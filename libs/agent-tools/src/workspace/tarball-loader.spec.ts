import { Readable } from 'node:stream';

import { Header, Pack, ReadEntry } from 'tar';
import { describe, expect, it } from 'vitest';

import { loadRepoWorkspaceFromTarball } from './tarball-loader.js';

function createTarGzBuffer(
  entries: Array<{ path: string; content: Buffer | string }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = new Pack({ gzip: true });
    const chunks: Buffer[] = [];

    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);

    for (const item of entries) {
      const buf =
        typeof item.content === 'string'
          ? Buffer.from(item.content, 'utf8')
          : item.content;
      const header = new Header({
        path: item.path,
        type: 'File',
        size: buf.length,
        mode: 0o644,
      });
      header.encode();
      const entry = new ReadEntry(header);
      pack.add(entry);
      entry.end(buf);
    }

    pack.end();
  });
}

describe('loadRepoWorkspaceFromTarball', () => {
  it('streams a .tar.gz archive into memory and strips the root folder prefix', async () => {
    const tarGz = await createTarGzBuffer([
      {
        path: 'usermeme-repo-abc123/src/index.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      },
      {
        path: 'usermeme-repo-abc123/src/utils/math.ts',
        content:
          'export function add(a: number, b: number) {\n  return a + b;\n}',
      },
    ]);

    const response = new Response(new Uint8Array(tarGz), {
      status: 200,
      headers: { 'content-type': 'application/x-gzip' },
    });

    const workspace = await loadRepoWorkspaceFromTarball(response);

    expect(workspace.fileCount).toBe(2);
    expect(workspace.findFiles().files).toEqual([
      'src/index.ts',
      'src/utils/math.ts',
    ]);
    expect(workspace.readFile({ path: 'src/index.ts' }).content).toBe(
      '1 | export const x = 1;\n2 | export const y = 2;',
    );
  });

  it('filters out node_modules, dist, lockfiles, binary files, and oversized files', async () => {
    const binaryBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
    const tarGz = await createTarGzBuffer([
      {
        path: 'repo-sha/src/keep.ts',
        content: 'const keep = true;',
      },
      {
        path: 'repo-sha/node_modules/pkg/index.js',
        content: 'module.exports = {};',
      },
      {
        path: 'repo-sha/dist/bundle.js',
        content: 'console.log("built");',
      },
      {
        path: 'repo-sha/pnpm-lock.yaml',
        content: 'lockfileVersion: 9.0',
      },
      {
        path: 'repo-sha/src/logo.png',
        content: 'fake-png',
      },
      {
        path: 'repo-sha/src/sneaky-binary.txt',
        content: binaryBuf,
      },
      {
        path: 'repo-sha/src/too-large.ts',
        content: 'a'.repeat(500),
      },
    ]);

    const stream = Readable.from(tarGz);
    const workspace = await loadRepoWorkspaceFromTarball(stream, {
      maxFileBytes: 100,
    });

    expect(workspace.findFiles().files).toEqual(['src/keep.ts']);
  });

  it('enforces maxTotalBytes across the archive', async () => {
    const tarGz = await createTarGzBuffer([
      {
        path: 'repo-sha/src/a.ts',
        content: '1234567890', // 10 bytes
      },
      {
        path: 'repo-sha/src/b.ts',
        content: '1234567890', // 10 bytes
      },
      {
        path: 'repo-sha/src/c.ts',
        content: '1234567890', // 10 bytes (exceeds 20 byte cap)
      },
    ]);

    const workspace = await loadRepoWorkspaceFromTarball(Readable.from(tarGz), {
      maxTotalBytes: 20,
    });

    expect(workspace.findFiles().files).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
