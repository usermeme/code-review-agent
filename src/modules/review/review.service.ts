import { InMemorySessionService, Runner } from '@google/adk';
import { loadChangedFiles } from '../context/changed-files.service.js';
import { cloneShallow, type ClonedRepo } from '../context/clone.service.js';
import type { RepoContextBuilder } from '../context/repo-context-builder.service.js';
import type { DiscussionStore } from '../discussion/store.service.js';
import type { AppConfig } from '../../core/config/config.schema.js';
import { annotateDiff } from '../../integrations/github/diff.service.js';
import { resolveModelInstance } from '../../integrations/model/model-config.service.js';
import { fetchLinkedTickets, type TicketProvider } from '../../integrations/ticket/ticket.service.js';
import { createGetDiscussionTool } from './tools/get-discussion.tool.js';
import { createGetRepoContextTool } from './tools/get-repo-context.tool.js';
import { createReadFileTool, createSearchRepoTool } from './tools/repo-files.tool.js';
import { createStoreDiscussionTool } from './tools/store-discussion.tool.js';
import { logger } from '../../core/logger/logger.service.js';
import { createOrchestrator } from './agents/orchestrator.agent.js';
import { loadReviewSkill } from './skills/review.skill.js';
import { parseReviewPlan, type ReviewPlan } from './schemas/review.schema.js';
import { STATE, type PrMeta } from './constants/state-keys.constant.js';
import { verifyFindings } from './agents/verifier.agent.js';
import type { PlatformProvider } from '../../integrations/vcs/interfaces/vcs-provider.interface.js';
import type { RepositoryIdentifier, PrDiff } from '../../integrations/vcs/types/vcs.types.js';

const APP_NAME = 'code-review-agent';
const USER_ID = 'reviewer';

export interface ReviewDeps {
  cfg: AppConfig;
  getProvider: (id: string) => PlatformProvider;
  contextBuilder: RepoContextBuilder;
  discussionStore: DiscussionStore;
  ticketProviders: TicketProvider[];
}

export interface ReviewRequest {
  providerId: string;
  installationId: string;
  repo: RepositoryIdentifier;
  prNumber: number;
}

export async function runReview(deps: ReviewDeps, request: ReviewRequest): Promise<void> {
  const { cfg } = deps;
  const repoFull = `${request.repo.owner}/${request.repo.name}`;
  
  const provider = deps.getProvider(request.providerId);
  const client = await provider.getClient(request.installationId);
  const publisher = await provider.getPublisher(request.installationId);

  const [pr, files, cloneToken, baseCloneUrl] = await Promise.all([
    client.getPullRequest(request.repo, request.prNumber),
    client.getPrFiles(request.repo, request.prNumber),
    client.getCloneToken(),
    client.getCloneUrl(request.repo) // Base clone url
  ]);

  // Fallback for PR diff: join patch fields
  const prDiffString = files
    .filter(f => f.patch)
    .map(f => `diff --git a/${f.previousFilename || f.filename} b/${f.filename}\n--- a/${f.previousFilename || f.filename}\n+++ b/${f.filename}\n${f.patch}`)
    .join('\n');

  const tickets = await fetchLinkedTickets(deps.ticketProviders, [pr.title, pr.body, pr.headSha].join('\n'));
  
  // const cloneUrl = pr.url; // Use pr html_url or derive head clone url? Let's use base clone url for now
  const checkout = await checkoutPrHead(baseCloneUrl, pr.headSha, cloneToken, repoFull, request.prNumber);
  
  try {
    const changedFiles = checkout ? await renderChangedFiles(checkout, repoFull, files, cfg) : '';
    logger.info({ repo: repoFull, pr: request.prNumber, tickets: tickets.length }, 'starting review');

    const orchestrator = createOrchestrator(
      cfg,
      {
        getRepoContext: createGetRepoContextTool(deps.contextBuilder, {
          repo: repoFull,
          ref: pr.baseSha,
          cloneUrl: baseCloneUrl,
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
      number: pr.number,
      title: pr.title,
      body: pr.body,
      branch: pr.headSha,
      author: pr.authorUsername,
      headSha: pr.headSha,
    };

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {
        [STATE.diff]: annotateDiff(prDiffString),
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
        files: files, // changed files service needs to accept PrDiff
        concurrency: cfg.verification.concurrency,
      });
      for (const { finding, reason } of result.dropped) {
        logger.info(
          { repo: repoFull, pr: request.prNumber, path: finding.path, title: finding.title, reason },
          'finding dropped by verification',
        );
      }
      plan.findings = result.kept;
      if (result.dropped.length > 0) {
        verificationNote = ` · ${result.dropped.length} candidate finding(s) withheld after verification`;
      }
    }

    const comments = plan.findings.map(f => {
      let body = `**[${f.severity}] ${f.title}**\n\n${f.body}`;
      if (f.suggestion) {
        body += `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
      }
      return {
        path: f.path,
        line: f.endLine,
        body
      };
    });

    let generalSummary = plan.summary;
    if (plan.ticketCoverage) {
      generalSummary += `\n\n### Ticket coverage\n${plan.ticketCoverage}`;
    }

    await publisher.publishReview(
      request.repo,
      request.prNumber,
      comments,
      generalSummary + `\n\n---\n_Reviewed by code-review-agent · head ${pr.headSha.slice(0, 7)}${verificationNote}_`
    );

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
  if (severity === 'critical') return 0;
  if (severity === 'major') return 1;
  return 2;
}

async function checkoutPrHead(cloneUrl: string, branchOrSha: string, token: string, repoFull: string, prNumber: number): Promise<ClonedRepo | null> {
  try {
    return await cloneShallow({
      cloneUrl,
      ref: branchOrSha,
      token,
    });
  } catch (error) {
    logger.warn(
      { repo: repoFull, pr: prNumber, err: error },
      'could not clone PR head; reviewers will see the diff only',
    );
    return null;
  }
}

async function renderChangedFiles(checkout: ClonedRepo, repoFull: string, files: PrDiff[], cfg: AppConfig): Promise<string> {
  const result = await loadChangedFiles(checkout.dir, files, {
    maxFileTokens: cfg.context.maxChangedFileTokens,
    totalTokenBudget: cfg.context.changedFilesTokenBudget,
  });
  logger.info(
    { repo: repoFull, included: result.included.length, omitted: result.omitted.length },
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
