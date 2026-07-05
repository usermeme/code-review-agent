import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRepoFile, searchRepoFiles } from './repo-files.tool.js';

const execFileAsync = promisify(execFile);

describe('repo file tools', () => {
  let dir: string;
  let outside: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'repo-files-test-'));
    outside = await mkdtemp(join(tmpdir(), 'repo-files-outside-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'util.ts'),
      ['export function greet(name: string) {', '  return `hello ${name}`;', '}', '', 'greet("world");'].join('\n'),
    );
    await writeFile(join(dir, 'README.md'), '# readme\ngreet is a helper');
    await writeFile(join(outside, 'secret.txt'), 'SECRET');
    await symlink(join(outside, 'secret.txt'), join(dir, 'link.ts'));
    await symlink(outside, join(dir, 'linkdir'));
    // searchRepoFiles shells out to `git grep`, which needs tracked files.
    await execFileAsync('git', ['init'], { cwd: dir });
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe('readRepoFile', () => {
    it('returns numbered lines for a range', async () => {
      const result = await readRepoFile(dir, { path: 'src/util.ts', startLine: 2, endLine: 3 });
      expect(result).toMatchObject({ path: 'src/util.ts', totalLines: 5 });
      const content = (result as { content: string }).content;
      expect(content).toContain('2 |   return `hello ${name}`;');
      expect(content).toContain('3 | }');
      expect(content).not.toContain('export function');
    });

    it('defaults to the whole file from line 1', async () => {
      const result = await readRepoFile(dir, { path: 'src/util.ts' });
      expect((result as { content: string }).content).toContain('1 | export function greet');
      expect((result as { content: string }).content).toContain('5 | greet("world");');
    });

    it('rejects paths escaping the checkout', async () => {
      expect(await readRepoFile(dir, { path: '../../etc/passwd' })).toEqual({
        error: 'path escapes the repository',
      });
      expect(await readRepoFile(dir, { path: '/etc/passwd' })).toEqual({
        error: 'path escapes the repository',
      });
    });

    it('rejects symlinks resolving outside the checkout', async () => {
      expect(await readRepoFile(dir, { path: 'link.ts' })).toEqual({
        error: 'path escapes the repository',
      });
      expect(await readRepoFile(dir, { path: 'linkdir/secret.txt' })).toEqual({
        error: 'path escapes the repository',
      });
    });

    it('reports unreadable files as an error result', async () => {
      expect(await readRepoFile(dir, { path: 'src/missing.ts' })).toEqual({
        error: 'cannot read src/missing.ts',
      });
    });
  });

  describe('searchRepoFiles', () => {
    it('finds matches as path:line:text', async () => {
      const result = await searchRepoFiles(dir, { pattern: 'greet' });
      const matches = (result as { matches: string[] }).matches;
      expect(matches.some((m) => m.startsWith('src/util.ts:1:'))).toBe(true);
      expect(matches.some((m) => m.startsWith('README.md:2:'))).toBe(true);
    });

    it('narrows by pathspec', async () => {
      const result = await searchRepoFiles(dir, { pattern: 'greet', glob: 'src/**' });
      const matches = (result as { matches: string[] }).matches;
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((m) => m.startsWith('src/'))).toBe(true);
    });

    it('returns empty matches when nothing is found', async () => {
      expect(await searchRepoFiles(dir, { pattern: 'no_such_symbol_anywhere' })).toEqual({ matches: [] });
    });
  });
});
