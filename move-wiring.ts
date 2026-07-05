import { Project } from 'ts-morph';

async function main() {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
  });

  const wiring = project.getSourceFileOrThrow('src/core/wiring.ts');
  wiring.move('src/wiring.ts');

  // ts-morph updates the imports of files importing wiring.ts, 
  // but it usually strips the .js extension. Let's fix that.
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

  await project.save();
}

main().catch(console.error);
