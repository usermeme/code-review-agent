import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function replaceInFile(path: string, from: RegExp | string, to: string) {
  const content = readFileSync(path, 'utf8');
  writeFileSync(path, content.replace(from, to), 'utf8');
}

replaceInFile('src/modules/review/review.service.ts', '../../integrations/ticket/src/integrations/ticket/ticket.service.js', '../../integrations/ticket/ticket.service.js');
replaceInFile('src/wiring.ts', './integrations/ticket/src/integrations/ticket/ticket.service.js', './integrations/ticket/ticket.service.js');
replaceInFile('src/integrations/ticket/ticket.service.ts', '../../../../../core/config/config.schema.js', '../../core/config/config.schema.js');
replaceInFile('src/integrations/ticket/ticket.service.ts', '../../../../../core/logger/logger.service.js', '../../core/logger/logger.service.js');

const fixProvider = (file: string) => {
  let content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const filtered = lines.filter(l => !l.includes("import { Ticket, TicketProvider }") && !l.includes("import { Ticket }") && !l.includes("import { TicketProvider }"));
  filtered.unshift("import type { Ticket } from '../interfaces/ticket.interface.js';");
  filtered.unshift("import type { TicketProvider } from '../interfaces/ticket-provider.interface.js';");
  writeFileSync(file, filtered.join('\n'), 'utf8');
};

fixProvider('src/integrations/ticket/providers/clickup.provider.ts');
fixProvider('src/integrations/ticket/providers/jira.provider.ts');
