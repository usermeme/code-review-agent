import { RepoWorkspace } from '@code-review-agent/agent-tools';
import { describe, expect, it } from 'vitest';

import { buildVerifierInstruction } from './verifier.js';

function workspaceWith(files: [string, string[]][]): RepoWorkspace {
  return new RepoWorkspace({
    files: new Map(files),
    rawDiff: '',
    changedFiles: [],
  });
}

describe('buildVerifierInstruction', () => {
  it('includes the guidelines and the skills index, not skill contents', () => {
    const instruction = buildVerifierInstruction(
      workspaceWith([
        ['AGENTS.md', ['Never divide by taxRate.']],
        [
          '.claude/skills/billing/SKILL.md',
          ['---', 'description: Billing rules.', '---', 'Round tax up.'],
        ],
      ]),
    );

    expect(instruction).toContain('Never divide by taxRate.');
    expect(instruction).toContain(
      '- `billing`: `.claude/skills/billing/SKILL.md`',
    );
    expect(instruction).not.toContain('Round tax up.');
  });

  it('omits the skills section when the repo has no skills', () => {
    const instruction = buildVerifierInstruction(
      workspaceWith([['AGENTS.md', ['Rules.']]]),
    );

    expect(instruction).not.toContain('## Repository Skills');
  });
});
