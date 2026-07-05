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

  // Context
  addMove('src/modules/context/agent-docs.ts', 'src/modules/context/agent-docs.service.ts');
  addMove('src/modules/context/changed-files.ts', 'src/modules/context/changed-files.service.ts');
  addMove('src/modules/context/chunker.ts', 'src/modules/context/chunker.service.ts');
  addMove('src/modules/context/clone.ts', 'src/modules/context/clone.service.ts');
  addMove('src/modules/context/repo-context-builder.ts', 'src/modules/context/repo-context-builder.service.ts');
  addMove('src/modules/context/summarize.ts', 'src/modules/context/summarize.service.ts');
  
  addMove('src/modules/context/changed-files.spec.ts', 'src/modules/context/changed-files.service.spec.ts');
  addMove('src/modules/context/chunker.spec.ts', 'src/modules/context/chunker.service.spec.ts');
  addMove('src/modules/context/clone.spec.ts', 'src/modules/context/clone.service.spec.ts');
  addMove('src/modules/context/repo-context-builder.spec.ts', 'src/modules/context/repo-context-builder.service.spec.ts');
  addMove('src/modules/context/summarize.spec.ts', 'src/modules/context/summarize.service.spec.ts');

  // Discussion
  addMove('src/modules/discussion/db.ts', 'src/modules/discussion/db.service.ts');
  addMove('src/modules/discussion/embeddings.ts', 'src/modules/discussion/embeddings.service.ts');
  addMove('src/modules/discussion/store.ts', 'src/modules/discussion/store.service.ts');

  // Review
  addMove('src/modules/review/orchestrator.ts', 'src/modules/review/orchestrator.service.ts');
  addMove('src/modules/review/problems-agent.ts', 'src/modules/review/problems-agent.service.ts');
  addMove('src/modules/review/quality-agent.ts', 'src/modules/review/quality-agent.service.ts');
  addMove('src/modules/review/review-skill.ts', 'src/modules/review/review-skill.service.ts');
  addMove('src/modules/review/run-review.ts', 'src/modules/review/run-review.service.ts');
  addMove('src/modules/review/schemas.ts', 'src/modules/review/review.schema.ts');
  addMove('src/modules/review/state-keys.ts', 'src/modules/review/state-keys.constant.ts');
  addMove('src/modules/review/ticket-agent.ts', 'src/modules/review/ticket-agent.service.ts');
  addMove('src/modules/review/verifier.ts', 'src/modules/review/verifier.service.ts');

  addMove('src/modules/review/review-skill.spec.ts', 'src/modules/review/review-skill.service.spec.ts');
  addMove('src/modules/review/schemas.spec.ts', 'src/modules/review/review.schema.spec.ts');
  addMove('src/modules/review/verifier.spec.ts', 'src/modules/review/verifier.service.spec.ts');

  // Tools
  addMove('src/modules/review/tools/get-discussion.ts', 'src/modules/review/tools/get-discussion.tool.ts');
  addMove('src/modules/review/tools/get-repo-context.ts', 'src/modules/review/tools/get-repo-context.tool.ts');
  addMove('src/modules/review/tools/repo-files.ts', 'src/modules/review/tools/repo-files.tool.ts');
  addMove('src/modules/review/tools/store-discussion.ts', 'src/modules/review/tools/store-discussion.tool.ts');
  addMove('src/modules/review/tools/repo-files.spec.ts', 'src/modules/review/tools/repo-files.tool.spec.ts');

  // Github
  addMove('src/integrations/github/app-auth.ts', 'src/integrations/github/app-auth.service.ts');
  addMove('src/integrations/github/diff.ts', 'src/integrations/github/diff.service.ts');
  addMove('src/integrations/github/pr.ts', 'src/integrations/github/pr.service.ts');
  addMove('src/integrations/github/review-publisher.ts', 'src/integrations/github/review-publisher.service.ts');
  addMove('src/integrations/github/diff.spec.ts', 'src/integrations/github/diff.service.spec.ts');
  addMove('src/integrations/github/review-publisher.spec.ts', 'src/integrations/github/review-publisher.service.spec.ts');

  // Model
  addMove('src/integrations/model/claude-llm.ts', 'src/integrations/model/claude-llm.service.ts');
  addMove('src/integrations/model/claude-translate.ts', 'src/integrations/model/claude-translate.service.ts');
  addMove('src/integrations/model/generate.ts', 'src/integrations/model/generate.service.ts');
  addMove('src/integrations/model/model-config.ts', 'src/integrations/model/model-config.service.ts');
  addMove('src/integrations/model/registry.ts', 'src/integrations/model/registry.service.ts');
  addMove('src/integrations/model/claude-translate.spec.ts', 'src/integrations/model/claude-translate.service.spec.ts');
  addMove('src/integrations/model/generate.spec.ts', 'src/integrations/model/generate.service.spec.ts');

  // Ticket
  addMove('src/integrations/ticket/clickup.ts', 'src/integrations/ticket/clickup.service.ts');
  addMove('src/integrations/ticket/jira.ts', 'src/integrations/ticket/jira.service.ts');
  addMove('src/integrations/ticket/provider.ts', 'src/integrations/ticket/provider.service.ts');
  addMove('src/integrations/ticket/provider.spec.ts', 'src/integrations/ticket/provider.service.spec.ts');

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

  // Also fix JS extensions during the same step since ts-morph removes them when rewriting imports
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
