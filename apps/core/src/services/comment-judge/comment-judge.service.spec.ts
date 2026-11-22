import type {
  GitAdapterContract,
  PRMeta,
  PRState,
  ReviewThread,
  ThreadJudgmentDoc,
  ThreadJudgmentsPayload,
} from '@code-review-agent/shared-types';
import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeliveryRepository } from '../../modules/database/repositories/delivery.repository.js';
import { PrRepository } from '../../modules/database/repositories/pr.repository.js';
import {
  threadJudgmentId,
  ThreadJudgmentRepository,
} from '../../modules/database/repositories/thread-judgment.repository.js';
import { InMemoryDatabaseService } from '../../modules/database/testing/in-memory-database.service.js';
import {
  CommentJudgeRunError,
  CommentJudgeService,
} from './comment-judge.service.js';
import {
  COMMENT_SHA,
  HEAD_SHA,
  PR_KEY,
  resolvedThread,
} from './judge-fixtures.js';

type Judgment = { thread: number; verdict: string; reason: string };

/** Answers every judge session with one `submit_judgments` call. */
class JudgeLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly answer: () => Judgment[] | null) {
    super({ model: 'smart-model' });
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    const judgments = this.answer();
    yield judgments
      ? {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: `call_${this.requests.length}`,
                  name: 'submit_judgments',
                  args: { judgments },
                },
              },
            ],
          },
        }
      : { content: { role: 'model', parts: [{ text: 'No verdict.' }] } };
  }

  override connect(): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('Not implemented'));
  }
}

const META: PRMeta = {
  provider: 'github',
  owner: 'acme',
  repo: 'payments',
  prNumber: 9,
  title: 'fix: refunds',
  author: 'alice',
  branch: 'fix/refunds',
  htmlUrl: 'https://github.com/acme/payments/pull/9',
  action: 'thread_resolved',
  headSha: HEAD_SHA,
  threadId: 'T1',
};

const DOC_ID = threadJudgmentId(PR_KEY, 'T1');

describe('CommentJudgeService', () => {
  let db: InMemoryDatabaseService;
  let judgments: ThreadJudgmentRepository;
  let claims: DeliveryRepository;
  let prRepository: PrRepository;
  let threads: ReviewThread[];
  let published: ThreadJudgmentsPayload[];
  let publish: ReturnType<
    typeof vi.fn<(payload: ThreadJudgmentsPayload) => Promise<void>>
  >;
  let getReviewThreads: ReturnType<typeof vi.fn>;
  let getFileContent: ReturnType<typeof vi.fn>;
  let git: GitAdapterContract;
  let nowMs: number;

  function service(llm: BaseLlm): CommentJudgeService {
    return new CommentJudgeService({
      gitAdapterClient: git,
      judgments,
      claims,
      prRepository,
      model: llm,
      publish,
      now: () => nowMs,
    });
  }

  async function doc(): Promise<ThreadJudgmentDoc | null> {
    return judgments.get(DOC_ID);
  }

  beforeEach(() => {
    db = new InMemoryDatabaseService();
    judgments = new ThreadJudgmentRepository(db);
    claims = new DeliveryRepository(db);
    prRepository = new PrRepository(db);
    threads = [resolvedThread()];
    published = [];
    publish = vi.fn<(payload: ThreadJudgmentsPayload) => Promise<void>>(
      async (payload) => {
        published.push(payload);
      },
    );
    nowMs = 5_000;
    getReviewThreads = vi.fn(async () => threads);
    getFileContent = vi.fn(
      async () =>
        'export const refund = (a) => {\n  if (a < 0) throw new Error("negative");',
    );
    git = {
      getReviewThreads,
      getCompareDiff: vi.fn(async () => ({
        diff: 'diff --git a/src/refund.ts b/src/refund.ts\n--- a/src/refund.ts\n+++ b/src/refund.ts\n@@ -1,1 +1,2 @@\n export const refund = (a) => {\n+  if (a < 0) throw new Error("negative");',
        changedFiles: ['src/refund.ts'],
        status: 'ahead' as const,
      })),
      getFileContent,
      getRepoTarball: vi.fn(),
    } as unknown as GitAdapterContract;
  });

  it('queues the resolved thread and confirms a correct fix with a reaction', async () => {
    const llm = new JudgeLlm(() => [
      { thread: 0, verdict: 'fixed', reason: 'Negatives throw now.' },
    ]);

    const metrics = await service(llm).run(META, 'resolved');

    expect(llm.requests).toHaveLength(1);
    expect(published).toEqual([
      {
        kind: 'thread-judgments',
        provider: 'github',
        owner: 'acme',
        repo: 'payments',
        prNumber: 9,
        actions: [{ type: 'react', threadId: 'T1', commentId: 'C1' }],
        dismissApprovals: false,
      },
    ]);
    expect(await doc()).toMatchObject({
      status: 'fixed',
      notFixedCount: 0,
      lastVerdict: {
        verdict: 'fixed',
        reason: 'Negatives throw now.',
        headSha: HEAD_SHA,
        model: 'smart-model',
      },
    });
    expect(metrics).toMatchObject({
      judged: 1,
      verdicts: { fixed: 1, not_fixed: 0, accepted: 0 },
    });
    const pr = await prRepository.getPRStatus(PR_KEY);
    expect((pr as PRState).lastJudgment?.judged).toBe(1);
  });

  it('re-opens a wrong resolution and asks to dismiss the bot approval', async () => {
    const llm = new JudgeLlm(() => [
      {
        thread: 0,
        verdict: 'not_fixed',
        reason: 'Zero is still accepted at src/refund.ts:2.',
      },
    ]);

    await service(llm).run(META, 'resolved');

    expect(published[0].dismissApprovals).toBe(true);
    expect(published[0].actions[0]).toMatchObject({
      type: 'reopen',
      threadId: 'T1',
    });
    expect(await doc()).toMatchObject({
      status: 'not_fixed',
      notFixedCount: 1,
    });
  });

  it('waits for a push when nothing was committed after the comment, then judges', async () => {
    const llm = new JudgeLlm(() => [
      { thread: 0, verdict: 'fixed', reason: 'Done.' },
    ]);

    const waiting = await service(llm).run(
      { ...META, headSha: COMMENT_SHA },
      'resolved',
    );

    expect(llm.requests).toHaveLength(0);
    expect(published).toHaveLength(0);
    expect(waiting?.pending).toBe(1);
    expect((await doc())?.status).toBe('pending');

    await service(llm).run(
      { ...META, action: 'synchronize', threadId: undefined },
      'push',
    );

    expect(llm.requests).toHaveLength(1);
    expect((await doc())?.status).toBe('fixed');
  });

  it('skips a thread resolved with [skip judge] without a model call', async () => {
    threads[0].comments[1].body = 'Intentional. [skip judge]';
    const llm = new JudgeLlm(() => []);

    await service(llm).run(META, 'resolved');

    expect(llm.requests).toHaveLength(0);
    expect(await doc()).toMatchObject({
      status: 'skipped',
      skipReason: 'Resolved with [skip judge].',
    });
  });

  it('never judges threads that no resolved event queued', async () => {
    const llm = new JudgeLlm(() => []);

    const metrics = await service(llm).run(
      { ...META, action: 'synchronize', threadId: undefined },
      'push',
    );

    expect(metrics).toBeNull();
    expect(getReviewThreads).not.toHaveBeenCalled();
    expect(llm.requests).toHaveLength(0);
  });

  it('stops judging a thread after the third failed check', async () => {
    const llm = new JudgeLlm(() => [
      { thread: 0, verdict: 'not_fixed', reason: 'Still broken.' },
    ]);

    for (let check = 1; check <= 3; check++) {
      nowMs += 1_000;
      await service(llm).run(META, 'resolved');
    }
    expect(await doc()).toMatchObject({
      status: 'escalated',
      notFixedCount: 3,
    });

    nowMs += 1_000;
    await service(llm).run(META, 'resolved');

    expect(llm.requests).toHaveLength(3);
    expect((await doc())?.status).toBe('escalated');
  });

  it('leaves a thread to the run that already claimed it', async () => {
    const llm = new JudgeLlm(() => [
      { thread: 0, verdict: 'fixed', reason: 'Done.' },
    ]);
    await judgments.save(DOC_ID, {
      provider: 'github',
      owner: 'acme',
      repo: 'payments',
      prNumber: 9,
      prKey: PR_KEY,
      threadId: 'T1',
      status: 'queued',
      queuedAtMs: 4_000,
      notFixedCount: 0,
      history: [],
    });
    await claims.claim(`judge:${DOC_ID}:4000`);

    await service(llm).run({ ...META, threadId: undefined }, 'resolved');

    expect(llm.requests).toHaveLength(0);
    expect((await doc())?.status).toBe('queued');
  });

  it('keeps the thread queued and fails the event when the model gives no verdict', async () => {
    const llm = new JudgeLlm(() => null);

    await expect(service(llm).run(META, 'resolved')).rejects.toThrow(
      CommentJudgeRunError,
    );

    expect(published).toHaveLength(0);
    expect((await doc())?.status).toBe('queued');
    const pr = (await prRepository.getPRStatus(PR_KEY)) as PRState;
    expect(pr.lastJudgment?.failure).toBe(
      'Comment judge finished without calling submit_judgments.',
    );

    // The claim was released, so the redelivery can judge the thread.
    const retry = new JudgeLlm(() => [
      { thread: 0, verdict: 'fixed', reason: 'Done.' },
    ]);
    await service(retry).run(META, 'resolved');
    expect((await doc())?.status).toBe('fixed');
  });

  it('records nothing as judged and fails the event when publishing to GitHub fails', async () => {
    publish.mockRejectedValue(new Error('pubsub down'));
    const llm = new JudgeLlm(() => [
      { thread: 0, verdict: 'not_fixed', reason: 'Still broken.' },
    ]);

    await expect(service(llm).run(META, 'resolved')).rejects.toThrow(
      'Comment judge failed: pubsub down',
    );

    expect(await doc()).toMatchObject({ status: 'queued', notFixedCount: 0 });
    const pr = (await prRepository.getPRStatus(PR_KEY)) as PRState;
    expect(pr.lastJudgment?.failure).toBe('pubsub down');
  });

  it('fails the event when reading the evidence fails', async () => {
    getFileContent.mockRejectedValue(new Error('adapter 502'));
    const llm = new JudgeLlm(() => []);

    await expect(service(llm).run(META, 'resolved')).rejects.toThrow(
      'Comment judge failed: adapter 502',
    );
    expect((await doc())?.status).toBe('queued');
  });

  it('does not fail a push when judging its waiting threads fails', async () => {
    await service(new JudgeLlm(() => [])).run(
      { ...META, headSha: COMMENT_SHA },
      'resolved',
    );
    publish.mockRejectedValue(new Error('pubsub down'));
    const llm = new JudgeLlm(() => [
      { thread: 0, verdict: 'fixed', reason: 'Done.' },
    ]);

    const metrics = await service(llm).run(
      { ...META, action: 'synchronize', threadId: undefined },
      'push',
    );

    expect(metrics?.failure).toBe('pubsub down');
    expect((await doc())?.status).toBe('pending');
  });
});
