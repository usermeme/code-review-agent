import { Project } from 'ts-morph';
import * as path from 'path';

async function main() {
  const project = new Project({ tsConfigFilePath: 'tsconfig.json' });

  // 1. Rename files
  const clickup = project.getSourceFileOrThrow('src/integrations/ticket/clickup.service.ts');
  clickup.move('src/integrations/ticket/providers/clickup.provider.ts');

  const jira = project.getSourceFileOrThrow('src/integrations/ticket/jira.service.ts');
  jira.move('src/integrations/ticket/providers/jira.provider.ts');

  const providerSpec = project.getSourceFileOrThrow('src/integrations/ticket/provider.service.spec.ts');
  providerSpec.move('src/integrations/ticket/ticket.service.spec.ts');

  const ticketService = project.getSourceFileOrThrow('src/integrations/ticket/provider.service.ts');
  ticketService.move('src/integrations/ticket/ticket.service.ts');

  // 2. Extract interfaces
  const ticketInterfaceFile = project.createSourceFile('src/integrations/ticket/interfaces/ticket.interface.ts', '');
  const ticketStruct = ticketService.getInterfaceOrThrow('Ticket').getStructure();
  ticketInterfaceFile.addInterface(ticketStruct);
  ticketService.getInterfaceOrThrow('Ticket').remove();

  const ticketProviderInterfaceFile = project.createSourceFile('src/integrations/ticket/interfaces/ticket-provider.interface.ts', '');
  const tpStruct = ticketService.getInterfaceOrThrow('TicketProvider').getStructure();
  ticketProviderInterfaceFile.addInterface(tpStruct);
  ticketService.getInterfaceOrThrow('TicketProvider').remove();

  // 3. Fix interface file imports
  ticketProviderInterfaceFile.addImportDeclaration({
    moduleSpecifier: './ticket.interface.js',
    namedImports: [{ name: 'Ticket' }],
    isTypeOnly: true
  });

  // 4. Update ticket.service.ts imports & exports
  ticketService.addImportDeclaration({
    moduleSpecifier: './interfaces/ticket.interface.js',
    namedImports: [{ name: 'Ticket' }],
    isTypeOnly: true
  });
  ticketService.addImportDeclaration({
    moduleSpecifier: './interfaces/ticket-provider.interface.js',
    namedImports: [{ name: 'TicketProvider' }]
  });
  
  // Re-export so consumers don't break
  ticketService.addExportDeclaration({
    moduleSpecifier: './interfaces/ticket.interface.js',
    namedExports: [{ name: 'Ticket', isTypeOnly: true }]
  });
  ticketService.addExportDeclaration({
    moduleSpecifier: './interfaces/ticket-provider.interface.js',
    namedExports: [{ name: 'TicketProvider' }]
  });

  // 5. Update clickup.provider.ts and jira.provider.ts imports
  for (const src of [clickup, jira]) {
    for (const imp of src.getImportDeclarations()) {
      if (imp.getModuleSpecifierValue() === '../ticket.service.js') {
        imp.remove();
      }
    }
    src.addImportDeclaration({
      moduleSpecifier: '../interfaces/ticket.interface.js',
      namedImports: [{ name: 'Ticket' }],
      isTypeOnly: true
    });
    src.addImportDeclaration({
      moduleSpecifier: '../interfaces/ticket-provider.interface.js',
      namedImports: [{ name: 'TicketProvider' }]
    });
  }

  // 6. Fix JS extensions
  for (const sourceFile of project.getSourceFiles()) {
    for (const decl of [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()]) {
      const moduleSpecifier = decl.getModuleSpecifier();
      if (moduleSpecifier) {
        const val = moduleSpecifier.getLiteralValue();
        if (val.startsWith('.') && !val.endsWith('.js') && !val.endsWith('.json')) {
          moduleSpecifier.setLiteralValue(val + '.js');
        }
      }
    }
  }

  await project.save();
}

main().catch(console.error);
