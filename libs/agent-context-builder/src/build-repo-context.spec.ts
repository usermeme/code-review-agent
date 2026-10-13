import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MockLlm } from '@code-review-agent/llm';
import type {
  GitAdapterContract,
  PRFile,
  RepoContextContent,
} from '@code-review-agent/shared-types';
import type { LlmRequest } from '@google/adk';
import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildRepoContext } from './build-repo-context.js';

const SECTIONS = {
  architecture: 'Fastify services talking over Pub/Sub',
  modules: 'apps/core: orchestration',
  patterns: 'Repositories wrap Firestore',
  errorHandling: 'Errors are logged and rethrown',
};

const isSynthesizeCall = (request: LlmRequest) =>
  request.config?.responseMimeType === 'application/json';

const promptOf = (request: LlmRequest) =>
  request.contents.map((c) => c.parts?.map((p) => p.text).join('')).join('');

/** Answers chunk summaries with text and the synthesize call with valid sections. */
function createLlm(overrides: { sections?: unknown } = {}) {
  return new MockLlm({
    generateResponse: (request) =>
      isSynthesizeCall(request)
        ? ((overrides.sections ?? SECTIONS) as Record<string, unknown>)
        : 'chunk summary',
  });
}

async function tarballOf(files: Record<string, string>): Promise<Response> {
  const root = await mkdtemp(join(tmpdir(), 'fixture-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, 'repo-abc123', path)), {
        recursive: true,
      });
      await writeFile(join(root, 'repo-abc123', path), content);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of tar.c({ gzip: true, cwd: root }, [
      'repo-abc123',
    ])) {
      chunks.push(chunk);
    }
    return new Response(Buffer.concat(chunks), {
      headers: { 'x-github-commit-sha': 'abc123' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createGitAdapter(
  overrides: Partial<GitAdapterContract> = {},
): GitAdapterContract {
  return {
    getPRDiff: vi.fn(),
    getPRFiles: vi.fn(),
    searchCode: vi.fn(),
    getFileContent: vi.fn(),
    getRepoTarball: vi.fn(),
    ...overrides,
  };
}

const listCheckouts = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith('repoctx-'));

describe('buildRepoContext — baseline', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds sections from the repo and keeps agent docs verbatim', async () => {
    const llm = createLlm();
    const getRepoTarball = vi.fn().mockImplementation(() =>
      tarballOf({
        'src/main.ts': 'export const main = 1;',
        'AGENTS.md': '# Rules\nUse pnpm.',
      }),
    );
    const gitAdapter = createGitAdapter({ getRepoTarball });

    const result = await buildRepoContext(
      { mode: 'baseline', owner: 'acme', repo: 'shop', ref: 'develop' },
      { llm, gitAdapter },
    );

    expect(getRepoTarball).toHaveBeenCalledWith('acme', 'shop', 'develop');
    expect(result).toEqual({
      sections: SECTIONS,
      agentDocs: [{ path: 'AGENTS.md', content: '# Rules\nUse pnpm.' }],
      headSha: 'abc123',
    });
  });

  it('removes the extracted checkout once the build is done', async () => {
    const before = await listCheckouts();
    const gitAdapter = createGitAdapter({
      getRepoTarball: vi
        .fn()
        .mockImplementation(() => tarballOf({ 'a.ts': 'const a = 1;' })),
    });

    await buildRepoContext(
      { mode: 'baseline', owner: 'acme', repo: 'shop' },
      { llm: createLlm(), gitAdapter },
    );

    expect(await listCheckouts()).toEqual(before);
  });

  it('never puts dependencies such as the LLM API key into a prompt', async () => {
    // Regression: the old orchestrator stringified its options (including the
    // Gemini instance and its apiKey) into the agent's user message.
    const llm = Object.assign(createLlm(), { apiKey: 'SECRET-API-KEY' });
    const gitAdapter = Object.assign(
      createGitAdapter({
        getRepoTarball: vi
          .fn()
          .mockImplementation(() => tarballOf({ 'a.ts': 'const a = 1;' })),
      }),
      { baseUrl: 'http://internal-adapter:8080' },
    );

    await buildRepoContext(
      { mode: 'baseline', owner: 'acme', repo: 'shop' },
      { llm, gitAdapter },
    );

    const everything = JSON.stringify(llm.calls);
    expect(everything).not.toContain('SECRET-API-KEY');
    expect(everything).not.toContain('internal-adapter');
  });

  it('fails instead of returning an empty context when synthesis is invalid', async () => {
    const gitAdapter = createGitAdapter({
      getRepoTarball: vi
        .fn()
        .mockImplementation(() => tarballOf({ 'a.ts': 'const a = 1;' })),
    });

    await expect(
      buildRepoContext(
        { mode: 'baseline', owner: 'acme', repo: 'shop' },
        { llm: createLlm({ sections: { architecture: '' } }), gitAdapter },
      ),
    ).rejects.toThrow('not matching the expected schema');
  });

  it('fails when every chunk summary fails', async () => {
    const llm = new MockLlm({
      generateResponse: () => {
        throw new Error('quota exceeded');
      },
    });
    const gitAdapter = createGitAdapter({
      getRepoTarball: vi
        .fn()
        .mockImplementation(() => tarballOf({ 'a.ts': 'const a = 1;' })),
    });

    await expect(
      buildRepoContext(
        { mode: 'baseline', owner: 'acme', repo: 'shop' },
        { llm, gitAdapter },
      ),
    ).rejects.toThrow('Every chunk summary failed');
  });
});

describe('buildRepoContext — incremental', () => {
  const existing: RepoContextContent = {
    sections: {
      architecture: 'EXISTING-ARCHITECTURE',
      modules: 'EXISTING-MODULES',
      patterns: 'EXISTING-PATTERNS',
      errorHandling: 'EXISTING-ERRORS',
    },
    agentDocs: [
      { path: 'AGENTS.md', content: 'old rules' },
      { path: 'docs/CLAUDE.md', content: 'to be deleted' },
    ],
  };

  const adapterWithPrFiles = (files: PRFile[]) =>
    createGitAdapter({ getPRFiles: vi.fn().mockResolvedValue(files) });

  it('merges the PR into the existing baseline instead of replacing it', async () => {
    // Regression: merged PRs used to overwrite the baseline with a document
    // built from the PR's files alone.
    const llm = createLlm();
    const gitAdapter = adapterWithPrFiles([
      { filename: 'src/new.ts', status: 'added', content: 'export {}' },
      { filename: 'AGENTS.md', status: 'modified', content: 'new rules' },
      { filename: 'src/old.ts', status: 'removed' },
      { filename: 'docs/CLAUDE.md', status: 'removed' },
    ]);

    const result = await buildRepoContext(
      {
        mode: 'incremental',
        owner: 'acme',
        repo: 'shop',
        prNumber: 7,
        existing,
      },
      { llm, gitAdapter },
    );

    const synthesizePrompt = promptOf(llm.calls.find(isSynthesizeCall));
    expect(synthesizePrompt).toContain('EXISTING-ARCHITECTURE');
    expect(synthesizePrompt).toContain('src/old.ts');
    expect(result.sections).toEqual(SECTIONS);
    expect(result.agentDocs).toEqual([
      { path: 'AGENTS.md', content: 'new rules' },
    ]);
  });

  it('makes no LLM calls when the PR changed no readable files', async () => {
    const llm = createLlm();
    const gitAdapter = adapterWithPrFiles([
      { filename: 'logo.png', status: 'modified' },
    ]);

    const result = await buildRepoContext(
      {
        mode: 'incremental',
        owner: 'acme',
        repo: 'shop',
        prNumber: 7,
        existing,
      },
      { llm, gitAdapter },
    );

    expect(llm.calls).toHaveLength(0);
    expect(result.sections).toEqual(existing.sections);
  });
});
