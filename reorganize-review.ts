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
  addMove('src/modules/review/orchestrator.agent.ts', 'src/modules/review/agents/orchestrator.agent.ts');
  addMove('src/modules/review/problems.agent.ts', 'src/modules/review/agents/problems.agent.ts');
  addMove('src/modules/review/quality.agent.ts', 'src/modules/review/agents/quality.agent.ts');
  addMove('src/modules/review/ticket.agent.ts', 'src/modules/review/agents/ticket.agent.ts');
  addMove('src/modules/review/verifier.agent.ts', 'src/modules/review/agents/verifier.agent.ts');
  addMove('src/modules/review/verifier.agent.spec.ts', 'src/modules/review/agents/verifier.agent.spec.ts');

  // Skills
  addMove('src/modules/review/review.skill.ts', 'src/modules/review/skills/review.skill.ts');
  addMove('src/modules/review/review.skill.spec.ts', 'src/modules/review/skills/review.skill.spec.ts');

  // Constants
  addMove('src/modules/review/state-keys.constant.ts', 'src/modules/review/constants/state-keys.constant.ts');

  // Schemas
  addMove('src/modules/review/review.schema.ts', 'src/modules/review/schemas/review.schema.ts');
  addMove('src/modules/review/review.schema.spec.ts', 'src/modules/review/schemas/review.schema.spec.ts');

  // Core Service
  addMove('src/modules/review/run-review.service.ts', 'src/modules/review/review.service.ts');

  console.log(`Moving ${Object.keys(moves).length} files...`);

  for (const [oldPath, newPath] of Object.entries(moves)) {
    const file = project.getSourceFile(oldPath);
    if (file) {
      console.log(`Moving ${path.basename(oldPath)} -> ${path.relative(process.cwd(), newPath)}`);
      file.move(newPath);
    } else {
      console.warn(`File not found: ${oldPath}`);
    }
  }

  // Fix JS extensions again, since we moved files
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
