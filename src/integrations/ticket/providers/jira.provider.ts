import type { TicketProvider } from '../interfaces/ticket-provider.interface.js';
import type { Ticket } from '../interfaces/ticket.interface.js';

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

/** Flattens Atlassian Document Format into plain markdown-ish text. */
export function flattenAdf(node: AdfNode | undefined): string {
  if (!node) return '';
  if (node.text) return node.text;
  const children = (node.content ?? []).map(flattenAdf);
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return children.join('') + '\n';
    case 'listItem':
      return '- ' + children.join('').trimEnd() + '\n';
    case 'bulletList':
    case 'orderedList':
      return children.join('');
    case 'codeBlock':
      return '```\n' + children.join('') + '\n```\n';
    case 'hardBreak':
      return '\n';
    default:
      return children.join('');
  }
}

export class JiraProvider implements TicketProvider {
  readonly name = 'jira' as const;

  constructor(private readonly cfg: JiraConfig) {}

  extractRefs(text: string): string[] {
    const refs = new Set<string>();
    for (const match of text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)) {
      refs.add(match[1]!);
    }
    // Also catch full browse URLs on the configured host.
    if (this.cfg.baseUrl) {
      const host = this.cfg.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const urlPattern = new RegExp(`${host.replace(/\./g, '\\.')}/browse/([A-Z][A-Z0-9]+-\\d+)`, 'g');
      for (const match of text.matchAll(urlPattern)) refs.add(match[1]!);
    }
    return [...refs];
  }

  async fetchTicket(ref: string): Promise<Ticket | null> {
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/api/3/issue/${ref}?fields=summary,description,subtasks,status`, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString('base64'),
        Accept: 'application/json',
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Jira ${ref}: HTTP ${response.status}`);
    const issue = (await response.json()) as {
      fields: {
        summary?: string;
        description?: AdfNode;
        status?: { name?: string };
        subtasks?: {
          fields?: {
            summary?: string;
            status?: { statusCategory?: { key?: string } };
          };
        }[];
      };
    };

    const description = flattenAdf(issue.fields.description).trim();
    return {
      id: ref,
      url: `${base}/browse/${ref}`,
      title: issue.fields.summary ?? '',
      description,
      // Jira has no first-class AC field on every project; extract checklist-style lines.
      acceptanceCriteria: description
        .split('\n')
        .filter((line) => /^- /.test(line.trim()))
        .map((line) => line.trim().slice(2)),
      subtasks: (issue.fields.subtasks ?? []).map((subtask) => ({
        title: subtask.fields?.summary ?? '',
        done: subtask.fields?.status?.statusCategory?.key === 'done',
      })),
      status: issue.fields.status?.name ?? 'unknown',
    };
  }
}
