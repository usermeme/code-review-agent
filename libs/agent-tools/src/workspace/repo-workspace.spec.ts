import { beforeEach, describe, expect, it } from 'vitest';

import { RepoWorkspace } from './repo-workspace.js';

const SAMPLE_DIFF = [
  'diff --git a/src/auth/auth.service.ts b/src/auth/auth.service.ts',
  '--- a/src/auth/auth.service.ts',
  '+++ b/src/auth/auth.service.ts',
  '@@ -1,3 +1,4 @@',
  ' export class AuthService {',
  '+  validateToken(token: string) { return Boolean(token); }',
  ' }',
  'diff --git a/src/index.ts b/src/index.ts',
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
  '@@ -1,1 +1,2 @@',
  ' export * from "./auth/auth.service.js";',
  '+export const VERSION = "1.0.0";',
].join('\n');

describe('RepoWorkspace', () => {
  let workspace: RepoWorkspace;

  beforeEach(() => {
    const files = new Map<string, string[]>([
      [
        'src/auth/auth.service.ts',
        [
          'export class AuthService {',
          '  validateToken(token: string): boolean {',
          '    return Boolean(token);',
          '  }',
          '}',
        ],
      ],
      [
        'src/auth/auth.service.spec.ts',
        [
          'import { AuthService } from "./auth.service.js";',
          'describe("AuthService", () => {',
          '  it("validates token", () => {});',
          '});',
        ],
      ],
      [
        'src/index.ts',
        [
          'export * from "./auth/auth.service.js";',
          'export const VERSION = "1.0.0";',
        ],
      ],
    ]);

    workspace = new RepoWorkspace({
      files,
      rawDiff: SAMPLE_DIFF,
    });
  });

  describe('findFiles', () => {
    it('lists all files sorted alphabetically when no pattern is given', () => {
      const res = workspace.findFiles();
      expect(res).toEqual({
        totalMatched: 3,
        truncated: false,
        files: [
          'src/auth/auth.service.spec.ts',
          'src/auth/auth.service.ts',
          'src/index.ts',
        ],
      });
    });

    it('filters files by glob pattern and substring', () => {
      expect(workspace.findFiles({ pattern: '**/*.spec.ts' }).files).toEqual([
        'src/auth/auth.service.spec.ts',
      ]);
      expect(workspace.findFiles({ pattern: 'auth.service.ts' }).files).toEqual(
        ['src/auth/auth.service.ts'],
      );
    });
  });

  describe('readFile', () => {
    it('reads requested line range with 1-based line numbers', () => {
      const res = workspace.readFile({
        path: 'src/auth/auth.service.ts',
        startLine: 2,
        endLine: 4,
      });

      expect(res).toEqual({
        path: 'src/auth/auth.service.ts',
        exists: true,
        totalLines: 5,
        startLine: 2,
        endLine: 4,
        hasMore: true,
        content: [
          '2 |   validateToken(token: string): boolean {',
          '3 |     return Boolean(token);',
          '4 |   }',
        ].join('\n'),
      });
    });

    it('returns an informative error when file does not exist', () => {
      const res = workspace.readFile({ path: 'src/missing.ts' });
      expect(res.exists).toBe(false);
      expect(res.error).toContain('File not found');
    });
  });

  describe('grepCode', () => {
    it('searches literally and formats context lines around the match', () => {
      const res = workspace.grepCode({
        pattern: 'validateToken',
        contextLines: 1,
      });

      expect(res.totalMatches).toBe(1);
      expect(res.truncated).toBe(false);
      expect(res.matches[0]).toEqual({
        path: 'src/auth/auth.service.ts',
        line: 2,
        snippet: [
          '  1 | export class AuthService {',
          '> 2 |   validateToken(token: string): boolean {',
          '  3 |     return Boolean(token);',
        ].join('\n'),
      });
    });

    it('supports regex search and pathPattern filtering', () => {
      const res = workspace.grepCode({
        pattern: 'export\\s+(class|const)',
        isRegex: true,
        pathPattern: 'src/index.ts',
        contextLines: 0,
      });

      expect(res.totalMatches).toBe(1);
      expect(res.matches[0]?.path).toBe('src/index.ts');
      expect(res.matches[0]?.line).toBe(2);
    });

    it('returns a graceful error on invalid regex instead of throwing', () => {
      const res = workspace.grepCode({
        pattern: '[unclosed',
        isRegex: true,
      });

      expect(res.totalMatches).toBe(0);
      expect(res.error).toContain('Invalid regular expression');
    });
  });

  describe('getPrDiff', () => {
    it('returns full diff and changedFiles when path is omitted', () => {
      const res = workspace.getPrDiff();
      expect(res.changedFiles).toEqual([
        'src/auth/auth.service.ts',
        'src/index.ts',
      ]);
      expect(res.diff).toBe(SAMPLE_DIFF);
      expect(res.truncated).toBe(false);
    });

    it('returns only the single-file diff when path is provided', () => {
      const res = workspace.getPrDiff({ path: 'src/index.ts' });
      expect(res.path).toBe('src/index.ts');
      expect(res.diff).toContain('export const VERSION = "1.0.0";');
      expect(res.diff).not.toContain('validateToken');
    });
  });
});
