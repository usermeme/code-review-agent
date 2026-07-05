import { Project, StringLiteral } from 'ts-morph';

async function fixExtensions() {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
  });

  for (const sourceFile of project.getSourceFiles()) {
    const importDecls = sourceFile.getImportDeclarations();
    const exportDecls = sourceFile.getExportDeclarations();

    let changed = false;

    for (const decl of [...importDecls, ...exportDecls]) {
      const moduleSpecifier = decl.getModuleSpecifier();
      if (moduleSpecifier) {
        const val = moduleSpecifier.getLiteralValue();
        if (val.startsWith('.') && !val.endsWith('.js') && !val.endsWith('.json')) {
          moduleSpecifier.setLiteralValue(val + '.js');
          changed = true;
        }
      }
    }

    if (changed) {
      sourceFile.saveSync();
    }
  }
}

fixExtensions().catch(console.error);
