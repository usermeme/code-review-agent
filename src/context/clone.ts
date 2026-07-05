import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ClonedRepo {
  dir: string;
  headSha: string;
  cleanup: () => Promise<void>;
}

/**
 * git embeds the credentialed clone URL in its failure messages (message,
 * stack, cmd), so a logged clone error would leak the installation token.
 * Scrub every string field on the error before it propagates.
 */
export function redactToken(error: unknown, token: string | undefined): unknown {
  if (!token || !(error instanceof Error)) return error;
  const scrub = (value: unknown): unknown => (typeof value === 'string' ? value.split(token).join('***') : value);
  const e = error as Error & { cmd?: unknown; stderr?: unknown; stdout?: unknown };
  e.message = scrub(e.message) as string;
  if (e.stack) e.stack = scrub(e.stack) as string;
  e.cmd = scrub(e.cmd);
  e.stderr = scrub(e.stderr);
  e.stdout = scrub(e.stdout);
  return e;
}

/**
 * Shallow-clones a repo for context building. Large blobs are filtered out —
 * anything over 200k is never useful for summarization anyway.
 *
 * core.symlinks=false checks out symlinks as plain text files (containing the
 * link target) instead of real links: PR authors must not be able to plant a
 * symlink to /proc/self/environ or ~/.ssh and have the agent read it as file
 * content.
 */
export async function cloneShallow(params: { cloneUrl: string; ref: string; token?: string }): Promise<ClonedRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'repoctx-'));
  const url = params.token
    ? params.cloneUrl.replace('https://', `https://x-access-token:${params.token}@`)
    : params.cloneUrl;
  try {
    await execFileAsync(
      'git',
      [
        'clone',
        '--config',
        'core.symlinks=false',
        '--depth',
        '1',
        '--branch',
        params.ref,
        '--filter=blob:limit=200k',
        url,
        dir,
      ],
      { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
    return {
      dir,
      headSha: stdout.trim(),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw redactToken(error, params.token);
  }
}
