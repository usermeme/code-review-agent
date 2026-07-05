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
    const patterns = ctx.state.get<string>(STATE.ctxPatterns) ?? '(repo context not loaded)';
    const agentDocs = ctx.state.get<string>(STATE.ctxAgentDocs) ?? '';
    const modules = ctx.state.get<string>(STATE.ctxModules) ?? '';
    return `You review a pull request for code quality against THIS repository's established conventions.

Look for: antipatterns and code smells (duplication, god functions, dead code, leaky abstractions);
violations of the internal conventions below; and especially cases where the PR introduces a NEW
pattern or utility where an existing internal one should be reused — when you flag that, cite the
existing convention or utility from the context below.

Apply this review discipline — in particular "what's worth a comment vs what to let go" (style a
formatter should own and preference without a project convention are NOT findings) and the
severity taxonomy:
${skill.core}

Internal patterns & conventions (enforce these):
${patterns}

Agent docs / contributor guidelines (verbatim from the repo):
${agentDocs}

Module overview (to know where existing utilities live):
${modules}

Pull request diff (annotated: the left column is the NEW-side line number — use exactly those
numbers for startLine/endLine):
${diff}
${
  changedFiles
    ? `
Full content of the changed files (left column = 1-based line numbers; large files show windowed
regions around the changes). Judge structure and duplication against the whole file, not the hunk:
${changedFiles}
`
    : ''
}
Do not report defects/bugs — a separate agent covers those. Respond with JSON only.`;
  };

export function createQualityAgent(cfg: AppConfig, skill: ReviewSkill): LlmAgent {
  return new LlmAgent({
    name: 'code_quality_agent',
    description: "Reviews patterns, antipatterns, and code smells against the repository's established conventions.",
    model: resolveModel(cfg, cfg.models.agents.codeQuality),
    instruction: instruction(skill),
    inputSchema: z.object({
      focus: z.string().describe('One-paragraph hint on what to pay special attention to'),
    }),
    outputSchema: findingsReportSchema,
    includeContents: 'none',
  });
}
