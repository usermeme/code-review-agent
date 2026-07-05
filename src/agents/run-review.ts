import { InMemorySessionService, Runner } from '@google/adk';
import type { App } from 'octokit';
import { loadChangedFiles } from '../context/changed-files.js';
import { cloneShallow, type ClonedRepo } from '../context/clone.js';
import type { RepoContextBuilder } from '../context/repo-context-builder.js';
import type { DiscussionStore } from '../discussions/store.js';
import type { AppConfig } from '../config/schema.js';
import { createInstallationToken } from '../github/app-auth.js';
import { annotateDiff } from '../github/diff.js';
import { fetchPrBundle, type PrBundle } from '../github/pr.js';
import { publishReview } from '../github/review-publisher.js';
import { resolveModelInstance } from '../models/model-config.js';
import { fetchLinkedTickets, type TicketProvider } from '../tickets/provider.js';
import { createGetDiscussionTool } from '../tools/get-discussion.js';
import { createGetRepoContextTool } from '../tools/get-repo-context.js';
import { createReadFileTool, createSearchRepoTool } from '../tools/repo-files.js';
import { createStoreDiscussionTool } from '../tools/store-discussion.js';
import { logger } from '../util/logger.js';
import { createOrchestrator } from './orchestrator.js';
import { loadReviewSkill } from './review-skill.js';
import { parseReviewPlan, type ReviewPlan } from './schemas.js';
import { STATE, type PrMeta } from './state-keys.js';
import { verifyFindings } from './verifier.js';

const APP_NAME = 'code-review-agent';
const USER_ID = 'reviewer';

export interface ReviewDeps {
  cfg: AppConfig;
  app: App;
  contextBuilder: RepoContextBuilder;
  discussionStore: DiscussionStore;
  ticketProviders: TicketProvider[];
}

export interface ReviewRequest {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
}

export async function runReview(deps: ReviewDeps, request: ReviewRequest): Promise<void> {
  const { cfg, app } = deps;
  const repoFull = `${request.owner}/${request.repo}`;
  const octokit = await app.getInstallationOctokit(request.installationId);

  const bundle = await fetchPrBundle(octokit, request.owner, request.repo, request.prNumber);
  const tickets = await fetchLinkedTickets(deps.ticketProviders, [bundle.title, bundle.body, bundle.branch].join('\n'));
  const cloneToken = await createInstallationToken(app, request.installationId);
  // The checkout backs the changed-file prompts, the orchestrator's
  // readFile/searchRepo tools, and the verification pass; it lives until the
  // review is published.
  const checkout = await checkoutPrHead(bundle, cloneToken);
  try {
    const changedFiles = checkout ? await renderChangedFiles(checkout, bundle, cfg) : '';
    logger.info({ repo: repoFull, pr: request.prNumber, tickets: tickets.length }, 'starting review');

    const orchestrator = createOrchestrator(
      cfg,
      {
        // The whole-repo context describes architecture and conventions, so it
        // is built from the trusted base branch and shared across PRs — not
        // from the (possibly forked) PR head.
        getRepoContext: createGetRepoContextTool(deps.contextBuilder, {
          repo: repoFull,
          ref: bundle.baseRef,
          cloneUrl: bundle.baseCloneUrl,
          token: cloneToken,
        }),
        getDiscussion: createGetDiscussionTool(deps.discussionStore, repoFull, cfg.discussions.searchLimit),
        storeDiscussion: createStoreDiscussionTool(deps.discussionStore, repoFull, request.prNumber),
        repoFiles: checkout ? [createReadFileTool(checkout.dir), createSearchRepoTool(checkout.dir)] : [],
      },
      loadReviewSkill(cfg.skills.codeReviewDir),
    );

    const prMeta: PrMeta = {
      repo: repoFull,
      number: bundle.number,
      title: bundle.title,
      body: bundle.body,
      branch: bundle.branch,
      author: bundle.author,
      headSha: bundle.headSha,
    };

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {
        [STATE.diff]: annotateDiff(bundle.diff),
        [STATE.changedFiles]: changedFiles,
        [STATE.prMeta]: prMeta,
        [STATE.tickets]: tickets,
      },
    });
    const runner = new Runner({
      appName: APP_NAME,
      agent: orchestrator,
      sessionService,
    });

    const plan = await runUntilPlan(runner, session.id);
    plan.findings = plan.findings
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
      .slice(0, cfg.triggers.maxFindings);

    let verificationNote = '';
    if (cfg.verification.enabled && checkout && plan.findings.length > 0) {
      const result = await verifyFindings({
        llm: resolveModelInstance(cfg, cfg.models.agents.verifier),
        checkoutDir: checkout.dir,
        findings: plan.findings,
        files: bundle.files,
        concurrency: cfg.verification.concurrency,
      });
      for (const { finding, reason } of result.dropped) {
        logger.info(
          {
            repo: repoFull,
            pr: request.prNumber,
            path: finding.path,
            title: finding.title,
            reason,
          },
          'finding dropped by verification',
        );
      }
      plan.findings = result.kept;
      if (result.dropped.length > 0) {
        verificationNote = ` · ${result.dropped.length} candidate finding(s) withheld after verification`;
      }
    }

    await publishReview({
      octokit,
      owner: request.owner,
      repo: request.repo,
      prNumber: request.prNumber,
      headSha: bundle.headSha,
      plan,
      files: bundle.files,
      contextNote: `Reviewed by code-review-agent · head ${bundle.headSha.slice(0, 7)}${verificationNote}`,
    });

    // Published findings become part of the discussion memory so future runs
    // know what was already raised.
    for (const finding of plan.findings) {
      await deps.discussionStore.insert({
        repo: repoFull,
        prNumber: request.prNumber,
        source: 'bot_finding',
        author: 'code-review-agent',
        filePath: finding.path,
        body: `[${finding.severity}] ${finding.title}: ${finding.body}`,
        createdAt: new Date(),
      });
    }
  } finally {
    await checkout?.cleanup();
  }
}

function severityRank(severity: string): number {
  return severity === 'critical' ? 0 : severity === 'major' ? 1 : 2;
}

/**
 * Clones the PR head for the review's duration. Failure degrades to a
 * diff-only review rather than aborting — e.g. a private fork the
 * installation token cannot clone.
 */
async function checkoutPrHead(bundle: PrBundle, token: string): Promise<ClonedRepo | null> {
  try {
    return await cloneShallow({
      cloneUrl: bundle.cloneUrl,
      ref: bundle.branch,
      token,
    });
  } catch (error) {
    logger.warn(
      { repo: `${bundle.owner}/${bundle.repo}`, pr: bundle.number, err: error },
      'could not clone PR head; reviewers will see the diff only',
    );
    return null;
  }
}

/** Renders the full changed files for the reviewer prompts. */
async function renderChangedFiles(checkout: ClonedRepo, bundle: PrBundle, cfg: AppConfig): Promise<string> {
  const result = await loadChangedFiles(checkout.dir, bundle.files, {
    maxFileTokens: cfg.context.maxChangedFileTokens,
    totalTokenBudget: cfg.context.changedFilesTokenBudget,
  });
  logger.info(
    {
      repo: `${bundle.owner}/${bundle.repo}`,
      included: result.included.length,
      omitted: result.omitted.length,
    },
    'loaded changed files for review',
  );
  return result.rendered;
}

async function runUntilPlan(runner: Runner, sessionId: string): Promise<ReviewPlan> {
  const prompts = [
    'Review this pull request now.',
    'Your previous reply was not a valid review plan. Reply with ONLY the fenced json block matching the required schema — no other text.',
  ];
  let lastText = '';
  for (const prompt of prompts) {
    lastText = await runTurn(runner, sessionId, prompt);
    const plan = parseReviewPlan(lastText);
    if (plan) return plan;
    logger.warn({ sessionId }, 'orchestrator output failed to parse as ReviewPlan; retrying');
  }
  throw new Error(`Orchestrator never produced a valid ReviewPlan; last output:\n${lastText.slice(0, 2000)}`);
}

async function runTurn(runner: Runner, sessionId: string, text: string): Promise<string> {
  let finalText = '';
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId,
    newMessage: { role: 'user', parts: [{ text }] },
  })) {
    if (event.partial) continue;
    const parts = event.content?.parts ?? [];
    const textParts = parts.filter((p) => p.text && !p.thought).map((p) => p.text!);
    if (event.content?.role === 'model' && textParts.length > 0) {
      finalText = textParts.join('');
    }
  }
  return finalText;
}
