import { describe, expect, it } from 'vitest';
import { splitSections } from './summarize.service.js';

describe('splitSections', () => {
  it('splits the fixed synthesis headings into keyed sections', () => {
    const sections = splitSections(
      [
        '## Architecture',
        'A monolith.',
        '## Modules',
        'src/ — everything.',
        '## Internal Patterns & Conventions',
        'Use the logger.',
        '## Error Handling & Testing',
        'Wrap errors.',
        '## Agent Docs (verbatim)',
        '### AGENTS.md',
      ].join('\n'),
    );
    expect(sections['architecture']).toBe('A monolith.');
    expect(sections['patterns']).toBe('Use the logger.');
    expect(sections['agentDocs']).toContain('AGENTS.md');
  });

  it('keeps verbatim agent docs whose content has its own ## headings', () => {
    const sections = splitSections(
      [
        '## Architecture',
        'A monolith.',
        '## Agent Docs (verbatim)',
        '### CLAUDE.md',
        'Header line kept.',
        '## Build',
        'npm run build',
        '## Testing',
        'npm test',
      ].join('\n'),
    );
    expect(sections['architecture']).toBe('A monolith.');
    expect(sections['agentDocs']).toContain('## Build');
    expect(sections['agentDocs']).toContain('npm run build');
    expect(sections['agentDocs']).toContain('## Testing');
    expect(sections['agentDocs']).toContain('npm test');
  });

  it('falls back to a single architecture section when headings are missing', () => {
    expect(splitSections('free-form text')).toEqual({ architecture: 'free-form text' });
  });
});
