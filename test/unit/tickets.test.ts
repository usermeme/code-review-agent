import { describe, expect, it } from 'vitest';
import { ClickUpProvider } from '../../src/tickets/clickup.js';
import { JiraProvider, flattenAdf } from '../../src/tickets/jira.js';

describe('JiraProvider.extractRefs', () => {
  const provider = new JiraProvider({ baseUrl: 'https://acme.atlassian.net', email: '', apiToken: '' });

  it('finds issue keys and browse URLs, deduplicated', () => {
    const refs = provider.extractRefs('Fixes DPL-123 and DPL-123, see https://acme.atlassian.net/browse/CORE-9');
    expect(refs.sort()).toEqual(['CORE-9', 'DPL-123']);
  });

  it('ignores lowercase and non-key text', () => {
    expect(provider.extractRefs('nothing here, dpl-1 is not a key')).toEqual([]);
  });
});

describe('flattenAdf', () => {
  it('flattens paragraphs, lists and code blocks', () => {
    const text = flattenAdf({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AC one' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AC two' }] }] },
          ],
        },
      ],
    });
    expect(text).toContain('Intro');
    expect(text).toContain('- AC one');
    expect(text).toContain('- AC two');
  });
});

describe('ClickUpProvider.extractRefs', () => {
  const provider = new ClickUpProvider({ apiToken: 't' });

  it('finds task URLs and CU-prefixed refs', () => {
    const refs = provider.extractRefs('See https://app.clickup.com/t/abc123 and #CU-def456');
    expect(refs).toContain('abc123');
    expect(refs).toContain('def456');
  });
});
