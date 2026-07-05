import { Project } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';

async function main() {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
  });

  // Add tests since they were outside src
  project.addSourceFilesAtPaths('test/**/*.ts');

  const moves: Record<string, string> = {};

  function moveDir(oldDir: string, newDir: string) {
    const dir = project.getDirectory(oldDir);
    if (!dir) return;
    for (const file of dir.getDescendantSourceFiles()) {
      if (file.getFilePath().includes('/test/')) continue;
      const rel = path.relative(oldDir, file.getFilePath());
      let newPath = path.resolve(newDir, rel);
      
      // enforce naming rules for basic ts files if needed
      // .ts -> .ts is fine, let's keep basenames unless specific renames
      moves[file.getFilePath()] = newPath;
    }
  }

  // CORE
  moves[path.resolve('src/modules/cache/redis.ts')] = path.resolve('src/core/redis/redis.service.ts');
  moves[path.resolve('src/config/load.ts')] = path.resolve('src/core/config/config.service.ts');
  moves[path.resolve('src/config/schema.ts')] = path.resolve('src/core/config/config.schema.ts');
  moves[path.resolve('src/util/logger.ts')] = path.resolve('src/core/logger/logger.service.ts');
  moves[path.resolve('src/wiring.ts')] = path.resolve('src/core/wiring.ts');

  // COMMON
  moves[path.resolve('src/util/headers.ts')] = path.resolve('src/common/utils/headers.util.ts');
  moves[path.resolve('src/util/safe-path.ts')] = path.resolve('src/common/utils/safe-path.util.ts');
  moves[path.resolve('src/util/tokens.ts')] = path.resolve('src/common/utils/tokens.util.ts');

  // INTEGRATIONS
  moveDir(path.resolve('src/modules/github'), path.resolve('src/integrations/github'));
  moveDir(path.resolve('src/modules/models'), path.resolve('src/integrations/model'));
  moveDir(path.resolve('src/modules/tickets'), path.resolve('src/integrations/ticket'));

  // MODULES
  moveDir(path.resolve('src/modules/admin'), path.resolve('src/modules/admin'));
  moveDir(path.resolve('src/modules/webhook'), path.resolve('src/modules/webhook'));
  moveDir(path.resolve('src/modules/agents'), path.resolve('src/modules/review'));
  moveDir(path.resolve('src/modules/context'), path.resolve('src/modules/context'));
  moveDir(path.resolve('src/modules/discussions'), path.resolve('src/modules/discussion'));
  moveDir(path.resolve('src/modules/tools'), path.resolve('src/modules/review/tools'));

  // COMMANDS
  const cliDir = project.getDirectory(path.resolve('src/cli'));
  if (cliDir) {
    for (const file of cliDir.getDescendantSourceFiles()) {
      const base = path.basename(file.getFilePath(), '.ts');
      moves[file.getFilePath()] = path.resolve(`src/commands/${base}.command.ts`);
    }
  }

  // APP/MAIN
  moves[path.resolve('src/app.ts')] = path.resolve('src/app.module.ts');
  moves[path.resolve('src/index.ts')] = path.resolve('src/main.ts');

  // Remove things that were overwritten by specific renames
  for (const f of project.getSourceFiles()) {
    if (!moves[f.getFilePath()] && !f.getFilePath().includes('/test/')) {
       // if we missed any
       if (f.getFilePath().includes('/src/modules/admin/') || f.getFilePath().includes('/src/modules/webhook/')) {
         // keep
       }
    }
  }

  // TESTS (Map to their new locations)
  const testMapping: Record<string, string> = {
    'admin-auth.test.ts': 'src/modules/admin/admin.routes.spec.ts',
    'changed-files.test.ts': 'src/modules/context/changed-files.spec.ts',
    'chunker.test.ts': 'src/modules/context/chunker.spec.ts',
    'claude-translate.test.ts': 'src/integrations/model/claude-translate.spec.ts',
    'clone-redact.test.ts': 'src/modules/context/clone.spec.ts',
    'config.test.ts': 'src/core/config/config.service.spec.ts',
    'diff.test.ts': 'src/integrations/github/diff.spec.ts',
    'generate.test.ts': 'src/integrations/model/generate.spec.ts',
    'redis-locks.test.ts': 'src/core/redis/redis.service.spec.ts',
    'repo-context-builder.test.ts': 'src/modules/context/repo-context-builder.spec.ts',
    'repo-files.test.ts': 'src/modules/review/tools/repo-files.spec.ts',
    'review-publisher.test.ts': 'src/integrations/github/review-publisher.spec.ts',
    'review-skill.test.ts': 'src/modules/review/review-skill.spec.ts',
    'schemas.test.ts': 'src/modules/review/schemas.spec.ts',
    'summarize.test.ts': 'src/modules/context/summarize.spec.ts',
    'tickets.test.ts': 'src/integrations/ticket/provider.spec.ts',
    'verifier.test.ts': 'src/modules/review/verifier.spec.ts',
    'webhook-router.test.ts': 'src/modules/webhook/webhook.service.spec.ts',
  };

  const testDir = project.getDirectory(path.resolve('test/unit'));
  if (testDir) {
    for (const testFile of testDir.getDescendantSourceFiles()) {
      const base = path.basename(testFile.getFilePath());
      if (testMapping[base]) {
        moves[testFile.getFilePath()] = path.resolve(testMapping[base]);
      }
    }
  }

  console.log(`Executing ${Object.keys(moves).length} file moves...`);
  for (const [oldPath, newPath] of Object.entries(moves)) {
    const file = project.getSourceFile(oldPath);
    if (file && oldPath !== newPath) {
      const targetDir = path.dirname(newPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      file.move(newPath);
    }
  }

  // Fix .js extensions!
  for (const sourceFile of project.getSourceFiles()) {
    const importDecls = sourceFile.getImportDeclarations();
    const exportDecls = sourceFile.getExportDeclarations();
    for (const decl of [...importDecls, ...exportDecls]) {
      const moduleSpecifier = decl.getModuleSpecifier();
      if (moduleSpecifier) {
        const val = moduleSpecifier.getLiteralValue();
        if (val.startsWith('.') && !val.endsWith('.js') && !val.endsWith('.json')) {
          moduleSpecifier.setLiteralValue(val + '.js');
        }
      }
    }
  }

  console.log('Saving project...');
  await project.save();
  console.log('Done!');
}

main().catch(console.error);
