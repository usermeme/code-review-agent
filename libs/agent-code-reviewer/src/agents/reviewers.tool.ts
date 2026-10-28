import {
  BaseTool,
  type Event,
  ForwardingArtifactService,
  GoogleLLMVariant,
  InMemoryMemoryService,
  InMemorySessionService,
  type LlmAgent,
  type RunAsyncToolRequest,
  Runner,
  State,
} from '@google/adk';
import { Type } from '@google/genai';
import PQueue from 'p-queue';

import { LIMITS } from '../constants/limits.constant.js';

/**
 * Concurrent dispatch of the reviewer sub-agents.
 *
 * ADK's own `AgentTool` runs one agent per tool call, and the runtime executes
 * function calls within a turn strictly serially — so an orchestrator that
 * calls `code_problems_agent` then `code_quality_agent` chains every LLM call
 * of both reviews back-to-back. On slow models that serial chain is what blew
 * through the review time limit (13 sequential Gemini calls over ~8 minutes).
 *
 * This tool replaces the two AgentTools with a single tool call that runs both
 * reviewers CONCURRENTLY (bounded by a p-queue cap, LIMITS.maxLlmConcurrency),
 * each in its own ephemeral session seeded with a snapshot of the shared state
 * — the same semantics AgentTool provides, minus the serialization. Wall-time
 * becomes max(problems, quality) instead of their sum; token cost is unchanged
 * (the reviewers see the exact same prompts and the existing chunking of the
 * diff is untouched).
 */
export const REVIEWERS_TOOL_NAME = 'run_code_reviewers';

/** Per-reviewer entry in the merged tool response. */
export type ReviewerOutcome = Record<string, unknown> | { error: string };

export interface CreateReviewersToolOptions {
  /** Reviewer agents to dispatch concurrently (problems + quality). */
  agents: LlmAgent[];
  /** Overrides LIMITS.maxLlmConcurrency as the parallel-dispatch cap. */
  concurrency?: number;
}

/** A reviewer run counts as success only when it returned a non-empty, error-free result. */
export function isSuccessfulReviewerOutcome(outcome: unknown): boolean {
  return (
    typeof outcome === 'object' &&
    outcome !== null &&
    Object.keys(outcome).length > 0 &&
    !('error' in outcome)
  );
}

function describeEventError(event: Event): string {
  return `${event.errorCode ?? 'agent_error'}: ${event.errorMessage ?? 'unknown error'}`;
}

/** Mirrors AgentTool: copies non-temp state deltas from a sub-agent event back to the parent. */
function propagateStateDelta(
  event: Event,
  toolContext: RunAsyncToolRequest['toolContext'],
): void {
  const delta = event.actions?.stateDelta;
  if (!delta) return;
  const filtered = Object.fromEntries(
    Object.entries(delta).filter(([key]) => !key.startsWith(State.TEMP_PREFIX)),
  );
  if (Object.keys(filtered).length > 0) {
    toolContext.state.update(filtered);
  }
}

/** Content parts of the reviewer's final event. */
type ReviewerParts = NonNullable<NonNullable<Event['content']>['parts']>;

function extractMergedText(parts: ReviewerParts): string {
  return parts
    .filter((part) => !part.thought)
    .map((part) => part.text)
    .filter((text): text is string => Boolean(text))
    .join('\n');
}

function parseReviewerText(
  agentName: string,
  mergedText: string,
): ReviewerOutcome {
  try {
    const parsed: unknown = JSON.parse(mergedText);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return { error: `${agentName} returned a non-object result.` };
  } catch {
    return {
      error: `${agentName} returned an unparseable result: ${mergedText.slice(0, 200)}`,
    };
  }
}

/** Extracts the parsed structured result of one reviewer run (AgentTool parity). */
function extractReviewerResult(
  agentName: string,
  lastEvent: Event | undefined,
): ReviewerOutcome {
  const parts = lastEvent?.content?.parts ?? [];
  if (parts.length === 0) {
    return { error: `${agentName} returned an empty result.` };
  }
  return parseReviewerText(agentName, extractMergedText(parts));
}

/** Mirrors AgentTool's runner wiring for a sub-agent. */
function createReviewerRunner(
  agent: LlmAgent,
  toolContext: RunAsyncToolRequest['toolContext'],
): Runner {
  const invocation = toolContext.invocationContext;
  return new Runner({
    appName: agent.name,
    agent,
    artifactService: new ForwardingArtifactService(toolContext),
    sessionService: invocation.sessionService ?? new InMemorySessionService(),
    memoryService: invocation.memoryService ?? new InMemoryMemoryService(),
    credentialService: invocation.credentialService,
  });
}

function hasAgentError(event: Event): boolean {
  return Boolean(event.errorCode || event.errorMessage);
}

/** Result of draining a reviewer's event stream. */
type DrainResult =
  | { kind: 'complete'; lastEvent?: Event }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string };

/**
 * Drains one reviewer run. State deltas are propagated back to the parent the
 * way AgentTool does; aborts and agent errors short-circuit without throwing.
 */
async function drainReviewerEvents(
  runner: Runner,
  session: { id: string; userId: string },
  args: Record<string, unknown>,
  toolContext: RunAsyncToolRequest['toolContext'],
): Promise<DrainResult> {
  let lastEvent: Event | undefined;
  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: JSON.stringify(args) }] },
    abortSignal: toolContext.abortSignal,
  })) {
    if (toolContext.abortSignal?.aborted) {
      return { kind: 'aborted' };
    }
    if (hasAgentError(event)) {
      return { kind: 'error', message: describeEventError(event) };
    }
    propagateStateDelta(event, toolContext);
    lastEvent = event;
  }
  return { kind: 'complete', lastEvent };
}

function reviewerOutcome(
  agentName: string,
  drained: DrainResult,
): ReviewerOutcome {
  if (drained.kind === 'error') {
    return { error: drained.message };
  }
  if (drained.kind === 'aborted') {
    return { error: `${agentName} was aborted mid-run.` };
  }
  return extractReviewerResult(agentName, drained.lastEvent);
}

/** Opens a dedicated session so concurrent reviewers never share history. */
async function openReviewerSession(
  runner: Runner,
  agent: LlmAgent,
  toolContext: RunAsyncToolRequest['toolContext'],
): Promise<{ id: string; userId: string }> {
  return runner.sessionService.createSession({
    appName: agent.name,
    userId: toolContext.invocationContext.userId,
    state: toolContext.state.toRecord(),
  });
}

/** Best-effort cleanup of a reviewer's ephemeral session. */
async function deleteReviewerSession(
  runner: Runner,
  agent: LlmAgent,
  session: { id: string; userId: string } | undefined,
): Promise<void> {
  if (!session) return;
  try {
    await runner.sessionService.deleteSession({
      appName: agent.name,
      userId: session.userId,
      sessionId: session.id,
    });
  } catch {
    // Session cleanup must never fail the review.
  }
}

/**
 * Runs one reviewer agent to completion in its own ephemeral session, seeded
 * with a snapshot of the parent's shared state (same mechanism AgentTool uses
 * to pass repo-context slices, staged skills, and the diff to the child).
 *
 * Unlike AgentTool, each reviewer gets a NEW session id rather than reusing
 * the parent's: sub-agents are dispatched concurrently here, and interleaving
 * two runs into one session history would race on appendEvent (and, with a
 * remote session service, could drop events). The session is deleted in
 * `finally` so a review never leaks sessions.
 *
 * Failures are returned as `{ error }` values — never thrown — so one
 * reviewer's 429 does not cancel the other's in-flight run.
 */
async function runReviewerAgent(
  agent: LlmAgent,
  args: Record<string, unknown>,
  toolContext: RunAsyncToolRequest['toolContext'],
): Promise<ReviewerOutcome> {
  const runner = createReviewerRunner(agent, toolContext);
  let session: { id: string; userId: string } | undefined;
  try {
    session = await openReviewerSession(runner, agent, toolContext);
    if (toolContext.abortSignal?.aborted) {
      return { error: `${agent.name} was aborted before it could run.` };
    }
    const drained = await drainReviewerEvents(
      runner,
      session,
      args,
      toolContext,
    );
    return reviewerOutcome(agent.name, drained);
  } catch (err) {
    return {
      error: `${agent.name} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await deleteReviewerSession(runner, agent, session);
  }
}

class ReviewersTool extends BaseTool {
  /** Latest outcome per reviewer, kept across dispatches so retries only re-run failures. */
  private readonly outcomes = new Map<string, ReviewerOutcome>();

  constructor(
    private readonly agents: LlmAgent[],
    private readonly concurrency: number,
  ) {
    super({
      name: REVIEWERS_TOOL_NAME,
      description:
        'Runs the code_problems_agent and code_quality_agent reviewers CONCURRENTLY on the PR in shared state ' +
        'and returns their findings reports keyed by agent name. Call this ONCE with a short "focus" hint; ' +
        'if an entry contains "error", you may call it once more to retry — only the failed reviewers re-run.',
    });
  }

  override _getDeclaration() {
    const declaration = {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          focus: {
            type: Type.STRING,
            description:
              'One-paragraph hint on what to pay special attention to',
          },
        },
        required: ['focus'],
      },
    };
    // Same variant handling as ADK's AgentTool.
    if (this.apiVariant !== GoogleLLMVariant.GEMINI_API) {
      return { ...declaration, response: { type: Type.OBJECT } };
    }
    return declaration;
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    await this.dispatchPending(args, toolContext);
    return this.collectOutcomes();
  }

  /** Runs only the reviewers without a successful cached outcome yet. */
  private async dispatchPending(
    args: Record<string, unknown>,
    toolContext: RunAsyncToolRequest['toolContext'],
  ): Promise<void> {
    const pending = this.agents.filter(
      (agent) => !isSuccessfulReviewerOutcome(this.outcomes.get(agent.name)),
    );
    if (pending.length === 0) return;

    const queue = new PQueue({ concurrency: this.concurrency });
    const entries = await Promise.all(
      pending.map((agent) =>
        queue.add(async () => {
          const outcome = await runReviewerAgent(agent, args, toolContext);
          return [agent.name, outcome] as const;
        }),
      ),
    );
    for (const entry of entries) {
      if (entry) {
        this.outcomes.set(entry[0], entry[1]);
      }
    }
  }

  /** Merged per-reviewer response, including reviewers that never ran. */
  private collectOutcomes(): Record<string, ReviewerOutcome> {
    return Object.fromEntries(
      this.agents.map((agent): [string, ReviewerOutcome] => [
        agent.name,
        this.outcomes.get(agent.name) ?? {
          error: `${agent.name} was not dispatched.`,
        },
      ]),
    );
  }
}

/**
 * Creates the single orchestrator tool that dispatches all reviewer
 * sub-agents concurrently (capped by LIMITS.maxLlmConcurrency).
 */
export function createReviewersTool(options: CreateReviewersToolOptions) {
  return new ReviewersTool(
    options.agents,
    options.concurrency ?? LIMITS.maxLlmConcurrency,
  );
}
