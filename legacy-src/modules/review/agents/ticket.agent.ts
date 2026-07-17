import { LlmAgent, type ReadonlyContext } from '@google/adk';
import { z } from 'zod';
import type { AppConfig } from '../../../core/config/config.schema.js';
import { resolveModel } from '../../../integrations/model/model-config.service.js';
import { ticketReportSchema } from '../schemas/review.schema.js';
import { STATE } from '../constants/state-keys.constant.js';

function instruction(ctx: ReadonlyContext): string {
  const tickets = ctx.state.get(STATE.tickets);
  const diff = ctx.state.get<string>(STATE.diff) ?? '';
  return `You verify that a pull request fully implements its linked ticket(s).

Linked tickets (pre-fetched from the ticket system; empty array means no ticket was linked):
${JSON.stringify(tickets ?? [], null, 2)}

Pull request diff:
${diff}

If there are no tickets, return {"ticketFound": false, "tickets": [], "summary": "No ticket linked in the PR description."}.

Otherwise, for EVERY requirement, acceptance criterion, and subtask in each ticket, judge whether the
diff implements it: "implemented", "partial", or "missing", with concrete evidence (files/hunks in the
diff, or the absence thereof). Requirements may be implicit in the ticket description — extract them
faithfully; do not invent requirements the ticket does not state. Summarize overall coverage in
"summary". Respond with JSON only.`;
}

export function createTicketAgent(cfg: AppConfig): LlmAgent {
  return new LlmAgent({
    name: 'ticket_comparison_agent',
    description:
      'Checks whether the pull request fully implements every requirement of its linked ticket(s). ' +
      'Call it once per review.',
    model: resolveModel(cfg, cfg.models.agents.ticketComparison),
    instruction,
    inputSchema: z.object({
      focus: z
        .string()
        .describe('One-paragraph hint on what to pay special attention to'),
    }),
    outputSchema: ticketReportSchema,
    includeContents: 'none',
  });
}
