import type {
  ThreadJudgmentAction,
  ThreadJudgmentsPayload,
} from '@code-review-agent/shared-types';
import type { Octokit } from 'octokit';

import { dismissOwnApprovals } from './review-approval.js';

const UNRESOLVE_MUTATION = `
  mutation Unresolve($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
  }
`;

const REPLY_MUTATION = `
  mutation Reply($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(
      input: { pullRequestReviewThreadId: $threadId, body: $body }
    ) { comment { author { login } } }
  }
`;

const REACT_MUTATION = `
  mutation React($subjectId: ID!) {
    addReaction(input: { subjectId: $subjectId, content: THUMBS_UP }) {
      reaction { content }
    }
  }
`;

interface ReplyResponse {
  addPullRequestReviewThreadReply?: {
    comment?: { author?: { login?: string } | null } | null;
  } | null;
}

export interface AppliedThreadJudgments {
  reopened: number;
  reacted: number;
  failed: number;
  dismissedApprovals: number;
}

/**
 * Re-opens the thread first, then explains why: if the reply failed, the
 * thread would still block approval; the other order could leave a wrong
 * resolution standing with only a comment on it.
 * Returns the bot's login, taken from the reply it just posted.
 */
async function reopen(
  octokit: Octokit,
  action: Extract<ThreadJudgmentAction, { type: 'reopen' }>,
): Promise<string | undefined> {
  await octokit.graphql(UNRESOLVE_MUTATION, { threadId: action.threadId });
  const reply = await octokit.graphql<ReplyResponse>(REPLY_MUTATION, {
    threadId: action.threadId,
    body: action.body,
  });
  return reply.addPullRequestReviewThreadReply?.comment?.author?.login;
}

async function react(
  octokit: Octokit,
  action: Extract<ThreadJudgmentAction, { type: 'react' }>,
): Promise<void> {
  await octokit.graphql(REACT_MUTATION, { subjectId: action.commentId });
}

interface ActionOutcome {
  ok: boolean;
  login?: string;
}

async function applyAction(
  octokit: Octokit,
  action: ThreadJudgmentAction,
): Promise<ActionOutcome> {
  try {
    if (action.type === 'reopen') {
      return { ok: true, login: await reopen(octokit, action) };
    }
    await react(octokit, action);
    return { ok: true };
  } catch (error) {
    console.warn(
      `[GithubService] Could not apply ${action.type} to thread ${action.threadId}`,
      error,
    );
    return { ok: false };
  }
}

function countApplied(
  actions: ThreadJudgmentAction[],
  outcomes: ActionOutcome[],
  type: ThreadJudgmentAction['type'],
): number {
  return actions.filter((action, index) => {
    return action.type === type && outcomes[index]?.ok;
  }).length;
}

/**
 * Applies the judge's decisions on GitHub. Each action is best-effort and
 * never throws: a Pub/Sub retry would repeat the actions that already
 * succeeded and post the same reply twice.
 */
export async function applyThreadJudgments(
  octokit: Octokit,
  payload: ThreadJudgmentsPayload,
): Promise<AppliedThreadJudgments> {
  const outcomes: ActionOutcome[] = [];
  for (const action of payload.actions) {
    outcomes.push(await applyAction(octokit, action));
  }
  const login = outcomes.find((outcome) => outcome.login)?.login;
  const dismissedApprovals =
    payload.dismissApprovals && login
      ? await dismissOwnApprovals(octokit, payload, login)
      : 0;
  return {
    reopened: countApplied(payload.actions, outcomes, 'reopen'),
    reacted: countApplied(payload.actions, outcomes, 'react'),
    failed: outcomes.filter((outcome) => !outcome.ok).length,
    dismissedApprovals,
  };
}
