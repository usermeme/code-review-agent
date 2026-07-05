import type { AppConfig } from '../config/schema.js';
import { logger } from '../util/logger.js';
import { ClickUpProvider } from './clickup.js';
import { JiraProvider } from './jira.js';

export interface Ticket {
  id: string;
  url: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  subtasks: { title: string; done: boolean }[];
  status: string;
}

export interface TicketProvider {
  readonly name: 'jira' | 'clickup';
  /** Extracts ticket references from PR title, body, and branch name. */
  extractRefs(text: string): string[];
  fetchTicket(ref: string): Promise<Ticket | null>;
}

export function createProviders(cfg: AppConfig): TicketProvider[] {
  const providers: TicketProvider[] = [];
  if (cfg.tickets.jira.enabled) providers.push(new JiraProvider(cfg.tickets.jira));
  if (cfg.tickets.clickup.enabled) providers.push(new ClickUpProvider(cfg.tickets.clickup));
  return providers;
}

/** Fetches every ticket referenced anywhere in the PR text, across providers. */
export async function fetchLinkedTickets(providers: TicketProvider[], text: string): Promise<Ticket[]> {
  const tickets: Ticket[] = [];
  for (const provider of providers) {
    const refs = [...new Set(provider.extractRefs(text))];
    for (const ref of refs) {
      try {
        const ticket = await provider.fetchTicket(ref);
        if (ticket) tickets.push(ticket);
      } catch (error) {
        logger.warn({ provider: provider.name, ref, err: error }, 'failed to fetch ticket');
      }
    }
  }
  return tickets;
}
