import { Project } from 'ts-morph';
import * as path from 'path';

async function main() {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
  });

  const appModule = project.getSourceFileOrThrow('src/app.module.ts');
  const wiring = project.createSourceFile('src/wiring.ts', '');

  // Move Services interface and buildServices function back to wiring.ts
  const servicesIntf = appModule.getInterfaceOrThrow('Services');
  const buildServicesFn = appModule.getFunctionOrThrow('buildServices');

  wiring.addInterface(servicesIntf.getStructure());
  wiring.addFunction(buildServicesFn.getStructure());

  servicesIntf.remove();
  buildServicesFn.remove();

  // Find out which imports in app.module.ts belong to buildServices and move them to wiring.ts
  // To be safe, we can just copy all imports from app.module to wiring, and then ts-morph can organize/remove unused.
  // Actually it's easier to explicitly grab the imports we know belong to wiring.
  const importsToMove = [
    'ioredis', 'pg', 'octokit', './core/redis/redis.service.js', './core/config/config.schema.js',
    './modules/context/repo-context-builder.service.js', './modules/discussion/db.service.js',
    './modules/discussion/embeddings.service.js', './modules/discussion/store.service.js',
    './integrations/github/app-auth.service.js', './integrations/model/model-config.service.js',
    './integrations/model/registry.service.js', './integrations/ticket/provider.service.js',
    './modules/review/review.service.js', './modules/context/repo-context-cache.service.js'
  ];

  for (const imp of appModule.getImportDeclarations()) {
    const val = imp.getModuleSpecifierValue();
    if (importsToMove.includes(val)) {
      wiring.addImportDeclaration(imp.getStructure());
      imp.remove();
    }
  }

  // Rewrite all imports in the project that point to app.module.js looking for Services/buildServices back to wiring.js
  for (const sourceFile of project.getSourceFiles()) {
    for (const imp of sourceFile.getImportDeclarations()) {
      const val = imp.getModuleSpecifierValue();
      if (val.includes('app.module.js')) {
        const named = imp.getNamedImports().map(n => n.getName());
        if (named.includes('Services') || named.includes('buildServices')) {
           imp.setModuleSpecifier(val.replace('app.module.js', 'wiring.js'));
        }
      }
    }
  }

  // Add the import back to app.module.ts itself
  appModule.addImportDeclaration({
    moduleSpecifier: './wiring.js',
    namedImports: ['Services'],
    isTypeOnly: true
  });

  await project.save();
}

main().catch(console.error);
