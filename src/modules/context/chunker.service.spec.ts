import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildChunks, collectFiles, renderChunk, type RepoFile } from './chunker.service.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'chunker-test-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules/dep'), { recursive: true });
  await writeFile(join(root, 'src/app.ts'), 'export const x = 1;\n');
  await writeFile(join(root, 'README.md'), '# readme\n');
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, 'node_modules/dep/index.js'), 'ignored');
  await writeFile(join(root, 'generated.js'), 'x'.repeat(6000));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('collectFiles', () => {
  it('applies ignore rules for dirs, lockfiles, binaries and generated blobs', async () => {
    const files = await collectFiles(root);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/app.ts');
    expect(paths).toContain('README.md');
    expect(paths).not.toContain('package-lock.json');
    expect(paths).not.toContain('logo.png');
    expect(paths).not.toContain('node_modules/dep/index.js');
    expect(paths).not.toContain('generated.js');
  });

  it('honors extra ignore globs', async () => {
    const files = await collectFiles(root, ['src/**']);
    expect(files.map((f) => f.path)).not.toContain('src/app.ts');
  });
});

function fakeFile(path: string, tokens: number): RepoFile {
  return { path, content: 'x'.repeat(tokens * 4), tokens };
}

describe('buildChunks', () => {
  it('packs files greedily under the token budget', () => {
    const files = [fakeFile('a/1.ts', 30), fakeFile('a/2.ts', 30), fakeFile('b/3.ts', 60)];
    const { chunks, overflow } = buildChunks(files, { maxChunkTokens: 70, maxChunks: 10 });
    expect(overflow).toHaveLength(0);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.files.map((f) => f.path)).toEqual(['a/1.ts', 'a/2.ts']);
  });

  it('moves files beyond maxChunks into overflow', () => {
    const files = [fakeFile('a/1.ts', 50), fakeFile('b/2.ts', 50), fakeFile('c/3.ts', 50)];
    const { chunks, overflow } = buildChunks(files, { maxChunkTokens: 60, maxChunks: 2 });
    expect(chunks).toHaveLength(2);
    expect(overflow).toEqual(['c/3.ts']);
  });
});

describe('renderChunk', () => {
  it('includes a file tree and file bodies', () => {
    const rendered = renderChunk({ label: 'a', files: [fakeFile('a/1.ts', 2)], tokens: 2 });
    expect(rendered).toContain('a/1.ts');
    expect(rendered).toContain('===== FILE: a/1.ts =====');
  });
});
