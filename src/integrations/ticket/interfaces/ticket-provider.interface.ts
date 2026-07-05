import type { Ticket } from "./ticket.interface.js";

export interface TicketProvider {
    readonly name: 'jira' | 'clickup';
    /** Extracts ticket references from PR title, body, and branch name. */
    extractRefs(text: string): string[];
    fetchTicket(ref: string): Promise<Ticket | null>;
}
