import type {
  GitAdapterContract,
  PRDiffResult,
} from '@code-review-agent/shared-types';
import { Header, Pack, ReadEntry } from 'tar';

function createTarGzBuffer(
  entries: Array<{ path: string; content: string }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = new Pack({ gzip: true });
    const chunks: Buffer[] = [];
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);

    for (const item of entries) {
      const buf = Buffer.from(item.content, 'utf8');
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

const defaultDiff = `diff --git a/src/index.ts b/src/index.ts
new file mode 100644
--- /dev/null
+++ b/src/index.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;

export class InMemoryGitAdapterClient implements GitAdapterContract {
  async getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRDiffResult> {
    void owner;
    void repo;
    void prNumber;
    return {
      diff: defaultDiff,
      changedFiles: ['src/index.ts'],
    };
  }

  async getRepoTarball(
    owner: string,
    repo: string,
    ref?: string,
  ): Promise<Response> {
    void ref;
    const tarGz = await createTarGzBuffer([
      {
        path: `${owner}-${repo}-head/src/index.ts`,
        content: 'export const a = 1;\nexport const b = 2;\n',
      },
    ]);
    return new Response(new Uint8Array(tarGz), {
      status: 200,
      headers: { 'content-type': 'application/gzip' },
    });
  }
}
