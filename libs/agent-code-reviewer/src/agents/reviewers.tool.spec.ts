import {
  BaseLlm,
  type BaseLlmConnection,
  BaseSessionService,
  Context,
  InMemoryMemoryService,
  InMemorySessionService,
  type InvocationContext,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { describe, expect, it, vi } from 'vitest';

import { createReviewersTool } from './reviewers.tool.js';

/** Minimal scripted model: one response per model call. */
class ScriptedLlm extends BaseLlm {
  calls = 0;

  constructor(private readonly respond: (call: number) => LlmResponse) {
    super({ model: 'scripted-model' });
  }

  override async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    void _request;
    this.calls += 1;
    yield this.respond(this.calls);
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}

function findingsReport(): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [{ text: JSON.stringify({ findings: [] }) }],
    },
    turnComplete: true,
  };
}

const rateLimited: LlmResponse = {
  errorCode: '429',
  errorMessage: 'RESOURCE_EXHAUSTED',
};

function createReviewer(name: string, llm: BaseLlm): LlmAgent {
  return new LlmAgent({
    name,
    description: name,
    model: llm,
    instruction: 'review',
  });
}

interface SessionSpy {
  service: BaseSessionService;
  created: string[];
  createdStates: (Record<string, unknown> | undefined)[];
  deleted: string[];
}

function createSessionSpy(): SessionSpy {
  const service = new InMemorySessionService();
  const created: string[] = [];
  const createdStates: (Record<string, unknown> | undefined)[] = [];
  const deleted: string[] = [];
  const create = service.createSession.bind(service);
  vi.spyOn(service, 'createSession').mockImplementation(async (request) => {
    const session = await create(request);
    created.push(session.id);
    createdStates.push(request.state);
    return session;
  });
  const remove = service.deleteSession.bind(service);
  vi.spyOn(service, 'deleteSession').mockImplementation(async (request) => {
    deleted.push(request.sessionId);
    return remove(request);
  });
  return { service, created, createdStates, deleted };
}

/** Tool context whose parent session must never be reused by a reviewer. */
function createToolContext(
  service: BaseSessionService,
  state: Record<string, unknown> = {},
): Context {
  const invocationContext = {
    userId: 'user-1',
    session: {
      id: 'parent-session',
      appName: 'parent-app',
      userId: 'user-1',
      state: { ...state },
      events: [],
    },
    sessionService: service,
    memoryService: new InMemoryMemoryService(),
  } as unknown as InvocationContext;
  return new Context({ invocationContext });
}

describe('createReviewersTool', () => {
  it('runs each reviewer in its own ephemeral session, seeded from shared state, and cleans it up', async () => {
    const spy = createSessionSpy();
    const tool = createReviewersTool({
      agents: [
        createReviewer('code_problems_agent', new ScriptedLlm(findingsReport)),
        createReviewer('code_quality_agent', new ScriptedLlm(findingsReport)),
      ],
    });
    const toolContext = createToolContext(spy.service, { marker: 'seeded' });

    const outcome = (await tool.runAsync({
      args: { focus: 'all' },
      toolContext,
    })) as Record<string, unknown>;

    expect(outcome.code_problems_agent).toEqual({ findings: [] });
    expect(outcome.code_quality_agent).toEqual({ findings: [] });

    // One dedicated session per reviewer, never the parent's.
    expect(spy.created).toHaveLength(2);
    expect(new Set(spy.created).size).toBe(2);
    expect(spy.created).not.toContain('parent-session');
    // Each reviewer receives a snapshot of the parent's shared state.
    expect(spy.createdStates).toEqual([
      { marker: 'seeded' },
      { marker: 'seeded' },
    ]);
    // No session leaks out of the review.
    expect([...spy.deleted].sort()).toEqual([...spy.created].sort());
  });

  it('re-runs only the failed reviewer on a second dispatch', async () => {
    const problems = new ScriptedLlm((call) =>
      call === 1 ? rateLimited : findingsReport(),
    );
    const quality = new ScriptedLlm(findingsReport);
    const tool = createReviewersTool({
      agents: [
        createReviewer('code_problems_agent', problems),
        createReviewer('code_quality_agent', quality),
      ],
    });
    const toolContext = createToolContext(new InMemorySessionService());

    const first = (await tool.runAsync({
      args: { focus: 'all' },
      toolContext,
    })) as Record<string, unknown>;

    expect(first.code_problems_agent).toEqual({
      error: expect.stringContaining('RESOURCE_EXHAUSTED'),
    });
    expect(first.code_quality_agent).toEqual({ findings: [] });

    const second = (await tool.runAsync({
      args: { focus: 'all' },
      toolContext,
    })) as Record<string, unknown>;

    expect(second.code_problems_agent).toEqual({ findings: [] });
    expect(second.code_quality_agent).toEqual({ findings: [] });
    // The successful reviewer's report is reused, not re-generated.
    expect(problems.calls).toBe(2);
    expect(quality.calls).toBe(1);
  });
});
