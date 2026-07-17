import type { AppConfig } from '../../core/config/config.schema.js';
import { logger } from '../../core/logger/logger.service.js';
import { ClickUpProvider } from './providers/clickup.provider.js';
import { JiraProvider } from './providers/jira.provider.js';
import type { Ticket } from './interfaces/ticket.interface.js';
import { TicketProvider } from './interfaces/ticket-provider.interface.js';

export function createProviders(cfg: AppConfig): TicketProvider[] {
  const providers: TicketProvider[] = [];
  if (cfg.tickets.jira.enabled)
    providers.push(new JiraProvider(cfg.tickets.jira));
  if (cfg.tickets.clickup.enabled)
    providers.push(new ClickUpProvider(cfg.tickets.clickup));
  return providers;
}

/** Fetches every ticket referenced anywhere in the PR text, across providers. */
export async function fetchLinkedTickets(
  providers: TicketProvider[],
  text: string,
): Promise<Ticket[]> {
  const tickets: Ticket[] = [];
  for (const provider of providers) {
    const refs = [...new Set(provider.extractRefs(text))];
    for (const ref of refs) {
      try {
        const ticket = await provider.fetchTicket(ref);
        if (ticket) tickets.push(ticket);
      } catch (error) {
        logger.warn(
          { provider: provider.name, ref, err: error },
          'failed to fetch ticket',
        );
      }
    }
  }
  return tickets;
}

export { type Ticket } from './interfaces/ticket.interface.js';
export { TicketProvider } from './interfaces/ticket-provider.interface.js';
