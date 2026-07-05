import { Project } from 'ts-morph';

async function fixTests() {
  const project = new Project();
  project.addSourceFilesAtPaths('test/**/*.ts');

  const renames: Record<string, string> = {
    '../../src/agents/': '../../src/modules/agents/',
    '../../src/cache/': '../../src/modules/cache/',
    '../../src/context/': '../../src/modules/context/',
    '../../src/discussions/': '../../src/modules/discussions/',
    '../../src/github/': '../../src/modules/github/',
    '../../src/models/': '../../src/modules/models/',
    '../../src/tickets/': '../../src/modules/tickets/',
    '../../src/tools/': '../../src/modules/tools/',
    '../../src/server/webhook-router.js': '../../src/modules/webhook/webhook.service.js',
    '../../src/server/backfill.js': '../../src/modules/admin/admin.service.js',
    '../../src/server/admin-routes.js': '../../src/modules/admin/admin.routes.js',
    '../../src/server/app.js': '../../src/app.js'
  };

  for (const file of project.getSourceFiles()) {
    const imports = file.getImportDeclarations();
    let changed = false;

    for (const imp of imports) {
      const val = imp.getModuleSpecifierValue();
      for (const [oldPrefix, newPrefix] of Object.entries(renames)) {
        if (val.startsWith(oldPrefix)) {
          imp.setModuleSpecifier(val.replace(oldPrefix, newPrefix));
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      file.saveSync();
    }
  }
}

fixTests().catch(console.error);
