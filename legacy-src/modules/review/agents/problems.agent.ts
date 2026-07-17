import { LlmAgent, type ReadonlyContext } from '@google/adk';
import { z } from 'zod';
import type { AppConfig } from '../../../core/config/config.schema.js';
import { resolveModel } from '../../../integrations/model/model-config.service.js';
import type { ReviewSkill } from '../skills/review.skill.js';
import { findingsReportSchema } from '../schemas/review.schema.js';
import { STATE } from '../constants/state-keys.constant.js';

const instruction =
  (skill: ReviewSkill) =>
  (ctx: ReadonlyContext): string => {
    const diff = ctx.state.get<string>(STATE.diff) ?? '';
    const changedFiles = ctx.state.get<string>(STATE.changedFiles) ?? '';
    const architecture =
      ctx.state.get<string>(STATE.ctxArchitecture) ??
      '(repo context not loaded)';
    const errorHandling = ctx.state.get<string>(STATE.ctxErrorHandling) ?? '';

    const changedFilesContext = changedFiles
      ? `\nFull content of the changed files (left column = 1-based line numbers; large files show windowed\nregions around the changes). Use this to check the surrounding code before asserting a finding —\nmost false positives come from judging a hunk in isolation:\n${changedFiles}\n`
      : '';

    return `You hunt for real defects in a pull request. Report only problems, not style.

Look for: logic bugs; race conditions and other concurrency hazards; performance regressions
(N+1 queries, unbounded loops or memory, blocking IO on hot paths); data leaks and PII exposure;
security issues; missing or swallowed error handling.

Apply this review discipline to every finding — especially "verify before asserting": a finding's
body must contain its concrete failure scenario, and severity follows the taxonomy defined here:
${skill.core}

Walk this security checklist against the diff:
${skill.security}

Repository architecture (for understanding blast radius):
${architecture}

Repository error-handling & testing conventions:
${errorHandling}

Pull request diff (annotated: the left column is the NEW-side line number — use exactly those
numbers for startLine/endLine):
${diff}
${changedFilesContext}
Report uncertain findings too, with an honest "confidence" value — a downstream orchestrator filters
and deduplicates. Respond with JSON only.`;
  };

export function createProblemsAgent(
  cfg: AppConfig,
  skill: ReviewSkill,
): LlmAgent {
  return new LlmAgent({
    name: 'code_problems_agent',
    description:
      'Deep defect hunt: logic bugs, race conditions, performance, data leaks, security, error handling.',
    model: resolveModel(cfg, cfg.models.agents.codeProblems),
    instruction: instruction(skill),
    inputSchema: z.object({
      focus: z
        .string()
        .describe('One-paragraph hint on what to pay special attention to'),
    }),
    outputSchema: findingsReportSchema,
    includeContents: 'none',
  });
}
