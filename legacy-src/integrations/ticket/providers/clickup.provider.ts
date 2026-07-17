import type { TicketProvider } from '../interfaces/ticket-provider.interface.js';
import type { Ticket } from '../interfaces/ticket.interface.js';

interface ClickUpConfig {
  apiToken: string;
}

const CLICKUP_URL_REGEX = /app\.clickup\.com\/t\/([a-z0-9]+)/gi;
const CLICKUP_ID_REGEX = /#(?:CU-)?([a-z0-9]{6,})\b/gi;

export class ClickUpProvider implements TicketProvider {
  readonly name = 'clickup' as const;

  constructor(private readonly cfg: ClickUpConfig) {}

  extractRefs(text: string): string[] {
    const refs = new Set<string>();
    for (const match of text.matchAll(CLICKUP_URL_REGEX)) {
      refs.add(match[1]!);
    }
    for (const match of text.matchAll(CLICKUP_ID_REGEX)) {
      refs.add(match[1]!.toLowerCase());
    }
    return [...refs];
  }

  async fetchTicket(ref: string): Promise<Ticket | null> {
    const response = await fetch(
      `https://api.clickup.com/api/v2/task/${ref}?include_subtasks=true`,
      {
        headers: { Authorization: this.cfg.apiToken },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`ClickUp ${ref}: HTTP ${response.status}`);
    const task = (await response.json()) as {
      id: string;
      url?: string;
      name?: string;
      text_content?: string;
      description?: string;
      status?: { status?: string };
      subtasks?: { name?: string; status?: { type?: string } }[];
      checklists?: { items?: { name?: string; resolved?: boolean }[] }[];
    };

    const checklistItems = (task.checklists ?? []).flatMap(
      (cl) => cl.items ?? [],
    );
    return {
      id: task.id,
      url: task.url ?? `https://app.clickup.com/t/${task.id}`,
      title: task.name ?? '',
      description: task.text_content ?? task.description ?? '',
      acceptanceCriteria: checklistItems
        .map((item) => item.name ?? '')
        .filter(Boolean),
      subtasks: (task.subtasks ?? []).map((subtask) => ({
        title: subtask.name ?? '',
        done:
          subtask.status?.type === 'done' || subtask.status?.type === 'closed',
      })),
      status: task.status?.status ?? 'unknown',
    };
  }
}
