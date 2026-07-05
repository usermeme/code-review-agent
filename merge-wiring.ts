import { Project } from 'ts-morph';
import * as path from 'path';

async function main() {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
  });

  const wiring = project.getSourceFileOrThrow('src/wiring.ts');
  const appModule = project.getSourceFileOrThrow('src/app.module.ts');

  // Copy all imports from wiring.ts to app.module.ts
  for (const imp of wiring.getImportDeclarations()) {
    appModule.addImportDeclaration({
      moduleSpecifier: imp.getModuleSpecifierValue(),
      namedImports: imp.getNamedImports().map(n => ({ name: n.getName(), isTypeOnly: n.isTypeOnly() })),
      defaultImport: imp.getDefaultImport()?.getText(),
      isTypeOnly: imp.isTypeOnly()
    });
  }

  // Copy Services interface and buildServices function
  appModule.addInterface(wiring.getInterfaceOrThrow('Services').getStructure());
  appModule.addFunction(wiring.getFunctionOrThrow('buildServices').getStructure());

  // Delete wiring.ts
  wiring.delete();

  // Rewrite all imports in the project that point to wiring.ts -> app.module.ts
  for (const sourceFile of project.getSourceFiles()) {
    for (const imp of sourceFile.getImportDeclarations()) {
      const val = imp.getModuleSpecifierValue();
      if (val.includes('wiring.js')) {
        imp.setModuleSpecifier(val.replace('wiring.js', 'app.module.js'));
      }
    }
  }

  // Also remove the unused "import type { Services } from './wiring.js';" inside app.module.ts itself
  for (const imp of appModule.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() === './app.module.js' || imp.getModuleSpecifierValue() === './wiring.js') {
      imp.remove();
    }
  }

  await project.save();
}

main().catch(console.error);
