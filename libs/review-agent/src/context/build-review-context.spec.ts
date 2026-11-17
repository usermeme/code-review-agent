import { describe, expect, it } from 'vitest';

import { createTextResponse, ScriptedLlm } from '../testing/scripted-llm.js';
import { buildReviewContext, prepareSources } from './build-review-context.js';
import type { LoadedContextSource } from './context-sources.js';

function source(
  path: string,
  content: string,
  overrides: Partial<LoadedContextSource> = {},
): LoadedContextSource {
  const kind = path.endsWith('SKILL.md') ? 'skill' : 'guideline';
  return { path, kind, blobSha: `sha:${path}`, content, ...overrides };
}

/**
 * A guideline file that mixes agent-workflow noise with reviewable rules,
 * like this repository's own AGENTS.md.
 */
const FIXTURE_AGENTS = source(
  'AGENTS.md',
  [
    '# Guidelines',
    '- Always run tasks through `pnpm nx run`.',
    '- Invoke the nx-generate skill before scaffolding.',
    '- Never return raw Firestore documents from HTTP handlers.',
    '- Validate every environment variable with Zod; no silent defaults.',
  ].join('\n'),
);

describe('prepareSources', () => {
  it('orders guidelines by depth, then skills by size', () => {
    const { included } = prepareSources([
      source('skills/big/SKILL.md', 'x'.repeat(50)),
      source('apps/core/AGENTS.md', 'nested'),
      source('skills/small/SKILL.md', 'x'),
      source('AGENTS.md', 'root'),
    ]);

    expect(included.map((s) => s.path)).toEqual([
      'AGENTS.md',
      'apps/core/AGENTS.md',
      'skills/small/SKILL.md',
      'skills/big/SKILL.md',
    ]);
  });

  it('sends a mirrored skill once and records the copy', () => {
    const { included, discarded } = prepareSources([
      source('.opencode/skills/x/SKILL.md', 'same', { blobSha: 'blob-x' }),
      source('.agents/skills/x/SKILL.md', 'same', { blobSha: 'blob-x' }),
    ]);

    expect(included.map((s) => s.path)).toEqual(['.agents/skills/x/SKILL.md']);
    expect(discarded).toEqual([
      {
        path: '.opencode/skills/x/SKILL.md',
        reason: 'Same content as .agents/skills/x/SKILL.md.',
      },
    ]);
  });

  it('leaves out files past the input budget', () => {
    const { included, discarded } = prepareSources(
      [
        source('AGENTS.md', 'x'.repeat(8)),
        source('s/a/SKILL.md', 'y'.repeat(8)),
      ],
      10,
    );

    expect(included.map((s) => s.path)).toEqual(['AGENTS.md']);
    expect(discarded).toEqual([
      { path: 's/a/SKILL.md', reason: 'Over the builder input limit.' },
    ]);
  });
});

describe('buildReviewContext', () => {
  it('sends line-numbered sources and keeps only validated rules', async () => {
    const llm = new ScriptedLlm([
      () =>
        createTextResponse(
          JSON.stringify({
            rules: [
              {
                id: 'no-raw-firestore-docs',
                rule: 'Never return raw Firestore documents from HTTP handlers.',
                appliesTo: [],
                severity: 'major',
                source: { path: 'AGENTS.md', startLine: 4, endLine: 4 },
              },
              {
                id: 'zod-env',
                rule: 'Validate every environment variable with Zod; no silent defaults.',
                appliesTo: ['**/env.ts'],
                severity: 'minor',
                source: { path: 'AGENTS.md', startLine: 5 },
              },
              {
                id: 'invented',
                rule: 'Rule from a file that was never sent.',
                appliesTo: [],
                severity: 'minor',
                source: { path: 'docs/OTHER.md' },
              },
            ],
          }),
        ),
    ]);

    const result = await buildReviewContext(
      llm,
      { sources: [FIXTURE_AGENTS] },
      10_000,
    );

    const prompt = JSON.stringify(llm.requests[0].contents);
    expect(prompt).toContain('### FILE: AGENTS.md (guideline)');
    expect(prompt).toContain('4 | - Never return raw Firestore documents');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules.map((rule) => rule.id)).toEqual([
      'no-raw-firestore-docs',
      'zod-env',
    ]);
    expect(result.sources).toEqual([
      {
        path: 'AGENTS.md',
        kind: 'guideline',
        blobSha: 'sha:AGENTS.md',
        chars: FIXTURE_AGENTS.content.length,
      },
    ]);
  });

  it('reports a failure when the model does not return valid rules', async () => {
    const llm = new ScriptedLlm([() => createTextResponse('not json')]);

    const result = await buildReviewContext(
      llm,
      { sources: [FIXTURE_AGENTS] },
      10_000,
    );

    expect(result.ok).toBe(false);
  });

  it('makes no model call when every source was left out', async () => {
    const llm = new ScriptedLlm([]);

    const result = await buildReviewContext(llm, { sources: [] }, 10_000);

    expect(result).toMatchObject({ ok: true, rules: [] });
    expect(llm.requests).toHaveLength(0);
  });
});
