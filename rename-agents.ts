import { Project } from 'ts-morph';
import * as path from 'path';

async function main() {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
  });

  const moves: Record<string, string> = {};

  function addMove(oldRel: string, newRel: string) {
    moves[path.resolve(oldRel)] = path.resolve(newRel);
  }

  // Agents
  addMove('src/modules/review/orchestrator.service.ts', 'src/modules/review/orchestrator.agent.ts');
  addMove('src/modules/review/problems-agent.service.ts', 'src/modules/review/problems.agent.ts');
  addMove('src/modules/review/quality-agent.service.ts', 'src/modules/review/quality.agent.ts');
  addMove('src/modules/review/ticket-agent.service.ts', 'src/modules/review/ticket.agent.ts');
  addMove('src/modules/review/verifier.service.ts', 'src/modules/review/verifier.agent.ts');
  addMove('src/modules/review/verifier.service.spec.ts', 'src/modules/review/verifier.agent.spec.ts');

  // Skill
  addMove('src/modules/review/review-skill.service.ts', 'src/modules/review/review.skill.ts');
  addMove('src/modules/review/review-skill.service.spec.ts', 'src/modules/review/review.skill.spec.ts');

  console.log(`Renaming ${Object.keys(moves).length} files...`);

  for (const [oldPath, newPath] of Object.entries(moves)) {
    const file = project.getSourceFile(oldPath);
    if (file) {
      console.log(`Renaming ${path.basename(oldPath)} -> ${path.basename(newPath)}`);
      file.move(newPath);
    } else {
      console.warn(`File not found: ${oldPath}`);
    }
  }

  // Fix JS extensions
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
