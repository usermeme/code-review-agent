import { createLazyRepoTools } from '@code-review-agent/agent-tools';
import { LlmAgent } from '@google/adk';

import {
  type AgentSessionOutcome,
  runAgentSession,
  thinkingConfig,
} from '../agents/agent-session.js';
import type {
  CommentJudgeInput,
  CommentJudgeOptions,
  CommentJudgeResult,
  JudgeThread,
  ThreadJudgment,
} from './judge-input.js';
import { buildJudgePrompt, JUDGE_INSTRUCTION } from './judge-prompt.js';
import {
  createSubmitJudgmentsTool,
  type SubmitJudgmentsInput,
} from './submit-judgments.tool.js';

function describeOutcomeError(outcome: AgentSessionOutcome): string {
  if (outcome.timedOut) return 'Comment judge timed out.';
  if (outcome.error instanceof Error) return outcome.error.message;
  if (outcome.error) return 'Comment judge failed.';
  return 'Comment judge finished without calling submit_judgments.';
}

/** Maps verdicts back to thread ids; out-of-range numbers are dropped. */
function toJudgments(
  threads: JudgeThread[],
  submission: SubmitJudgmentsInput,
): Map<string, ThreadJudgment> {
  const judgments = new Map<string, ThreadJudgment>();
  for (const { thread, verdict, reason } of submission.judgments) {
    const target = threads[thread];
    if (target && !judgments.has(target.threadId)) {
      judgments.set(target.threadId, { verdict, reason: reason.trim() });
    }
  }
  return judgments;
}

/**
 * Asks the smart model whether each resolved thread was really resolved.
 * Never throws; a failed session returns no judgments and an `error`, and
 * the caller leaves those threads to be judged again later.
 */
export async function runCommentJudge(
  input: CommentJudgeInput,
  options: CommentJudgeOptions,
): Promise<CommentJudgeResult> {
  const submit = createSubmitJudgmentsTool();
  const repoTools = createLazyRepoTools(input.loadWorkspace);
  const agent = new LlmAgent({
    name: 'comment_judge_agent',
    model: options.model,
    instruction: JUDGE_INSTRUCTION,
    ...thinkingConfig(options.thinkingLevel),
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    tools: [...repoTools.all, submit.tool],
  });
  const outcome = await runAgentSession({
    agent,
    prompt: buildJudgePrompt(
      input.prMeta.title,
      input.prMeta.prNumber,
      input.threads,
    ),
    maxLlmCalls: options.maxLlmCalls,
    timeoutMs: options.timeoutMs,
    isDone: () => Boolean(submit.getSubmission()),
  });
  const submission = submit.getSubmission();
  return {
    judgments: submission ? toJudgments(input.threads, submission) : new Map(),
    usage: outcome.usage,
    ...(submission ? {} : { error: describeOutcomeError(outcome) }),
    repoLoaded: repoTools.loaded(),
  };
}
