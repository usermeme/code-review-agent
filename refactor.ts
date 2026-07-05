import { Project } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';

async function main() {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
  });

  // Map of file moves: old path -> new path
  const moves: Record<string, string> = {};

  function mapDirectory(oldDir: string, newDir: string) {
    const dir = project.getDirectory(oldDir);
    if (!dir) {
      console.warn(`Directory not found: ${oldDir}`);
      return;
    }
    for (const file of dir.getDescendantSourceFiles()) {
      const relativePath = path.relative(oldDir, file.getFilePath());
      moves[file.getFilePath()] = path.resolve(newDir, relativePath);
    }
  }

  // 1. Move domains to src/modules/
  const domains = ['agents', 'cache', 'context', 'discussions', 'github', 'models', 'tickets', 'tools'];
  for (const domain of domains) {
    mapDirectory(path.resolve(`src/${domain}`), path.resolve(`src/modules/${domain}`));
  }

  // 2. Map server components
  const serverFiles = [
    { old: 'src/server/webhook-router.ts', new: 'src/modules/webhook/webhook.service.ts' },
    { old: 'src/server/backfill.ts', new: 'src/modules/admin/admin.service.ts' },
    { old: 'src/server/admin-routes.ts', new: 'src/modules/admin/admin.routes.ts' },
    { old: 'src/server/app.ts', new: 'src/app.ts' },
  ];

  for (const { old: oldRel, new: newRel } of serverFiles) {
    const oldPath = path.resolve(oldRel);
    if (project.getSourceFile(oldPath)) {
      moves[oldPath] = path.resolve(newRel);
    } else {
      console.warn(`File not found: ${oldPath}`);
    }
  }

  console.log(`Moving ${Object.keys(moves).length} files...`);

  // We need to apply moves. In ts-morph, calling file.move(newFilePath) automatically updates all import declarations.
  for (const [oldPath, newPath] of Object.entries(moves)) {
    const file = project.getSourceFile(oldPath);
    if (file) {
      // Create the target directory if it doesn't exist
      const targetDir = path.dirname(newPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      
      console.log(`Moving ${path.relative(process.cwd(), oldPath)} -> ${path.relative(process.cwd(), newPath)}`);
      file.move(newPath);
    }
  }

  console.log('Saving project...');
  await project.save();
  console.log('Done!');
}

main().catch(console.error);
