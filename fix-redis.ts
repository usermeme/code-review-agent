import { Project } from 'ts-morph';
import * as path from 'path';

async function main() {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
  });

  // 1. Export acquireLock and releaseLock from redis.service.ts
  const redisService = project.getSourceFileOrThrow('src/core/redis/redis.service.ts');
  const acquireLockFn = redisService.getFunctionOrThrow('acquireLock');
  acquireLockFn.setIsExported(true);
  const releaseLockFn = redisService.getFunctionOrThrow('releaseLock');
  releaseLockFn.setIsExported(true);

  // 2. Create repo-context-cache.service.ts
  const cacheFile = project.createSourceFile('src/modules/context/repo-context-cache.service.ts', `
import type { Redis } from 'ioredis';
import { acquireLock, releaseLock } from '../../core/redis/redis.service.js';
import type { RepoContextDoc } from './repo-context-builder.service.js';

const VERSION = 'v1';

export class RepoContextCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly maxAgeSeconds: number,
  ) {}

  private key(repo: string, sha: string): string {
    return \`repoctx:\${VERSION}:\${repo}:\${sha}\`;
  }

  private latestKey(repo: string): string {
    return \`repoctx:\${VERSION}:latest:\${repo}\`;
  }

  async get(repo: string, sha: string): Promise<RepoContextDoc | null> {
    const raw = await this.redis.get(this.key(repo, sha));
    return raw ? (JSON.parse(raw) as RepoContextDoc) : null;
  }

  async getLatest(repo: string): Promise<RepoContextDoc | null> {
    const sha = await this.redis.get(this.latestKey(repo));
    return sha ? this.get(repo, sha) : null;
  }

  async getLatestFresh(repo: string): Promise<RepoContextDoc | null> {
    const doc = await this.getLatest(repo);
    if (!doc) return null;
    return Date.now() - Date.parse(doc.builtAt) < this.maxAgeSeconds * 1000 ? doc : null;
  }

  async set(repo: string, sha: string, doc: RepoContextDoc): Promise<void> {
    await this.redis
      .multi()
      .set(this.key(repo, sha), JSON.stringify(doc), 'EX', this.ttlSeconds)
      .set(this.latestKey(repo), sha, 'EX', this.ttlSeconds)
      .exec();
  }

  tryAcquireBuildLock(repo: string): Promise<string | null> {
    return acquireLock(this.redis, \`repoctx:building:\${repo}\`, 900);
  }

  releaseBuildLock(repo: string, token: string): Promise<void> {
    return releaseLock(this.redis, \`repoctx:building:\${repo}\`, token);
  }
}
  `);

  // 3. Create review-lock.service.ts
  const lockFile = project.createSourceFile('src/modules/review/review-lock.service.ts', `
import type { Redis } from 'ioredis';
import { acquireLock, releaseLock } from '../../core/redis/redis.service.js';

export function acquireReviewLock(
  redis: Redis,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<string | null> {
  return acquireLock(redis, \`review:lock:\${repo}:\${prNumber}:\${headSha}\`, 3600);
}

export function releaseReviewLock(
  redis: Redis,
  repo: string,
  prNumber: number,
  headSha: string,
  token: string,
): Promise<void> {
  return releaseLock(redis, \`review:lock:\${repo}:\${prNumber}:\${headSha}\`, token);
}
  `);

  // Update wiring.ts
  const wiring = project.getSourceFileOrThrow('src/core/wiring.ts');
  wiring.getImportDeclarations().forEach(imp => {
    if (imp.getModuleSpecifierValue() === './redis/redis.service.js') {
      const named = imp.getNamedImports().find(n => n.getName() === 'RepoContextCache');
      if (named) named.remove();
    }
  });
  wiring.addImportDeclaration({
    moduleSpecifier: '../modules/context/repo-context-cache.service.js',
    namedImports: ['RepoContextCache']
  });

  // Update repo-context-builder.service.spec.ts
  const builderSpec = project.getSourceFileOrThrow('src/modules/context/repo-context-builder.service.spec.ts');
  builderSpec.getImportDeclarations().forEach(imp => {
    if (imp.getModuleSpecifierValue() === '../../core/redis/redis.service.js') {
      const named = imp.getNamedImports().find(n => n.getName() === 'RepoContextCache');
      if (named) named.remove();
    }
  });
  builderSpec.addImportDeclaration({
    moduleSpecifier: './repo-context-cache.service.js',
    namedImports: ['RepoContextCache']
  });

  // Update repo-context-builder.service.ts
  const builder = project.getSourceFileOrThrow('src/modules/context/repo-context-builder.service.ts');
  builder.getImportDeclarations().forEach(imp => {
    if (imp.getModuleSpecifierValue() === '../../core/redis/redis.service.js') {
      const named = imp.getNamedImports().find(n => n.getName() === 'RepoContextCache');
      if (named) named.remove();
    }
  });
  builder.addImportDeclaration({
    moduleSpecifier: './repo-context-cache.service.js',
    namedImports: ['RepoContextCache'],
    isTypeOnly: true
  });

  // Update webhook.service.ts
  const webhook = project.getSourceFileOrThrow('src/modules/webhook/webhook.service.ts');
  webhook.getImportDeclarations().forEach(imp => {
    if (imp.getModuleSpecifierValue() === '../../core/redis/redis.service.js') {
      const lockNamed = imp.getNamedImports().filter(n => ['acquireReviewLock', 'releaseReviewLock'].includes(n.getName()));
      lockNamed.forEach(n => n.remove());
    }
  });
  webhook.addImportDeclaration({
    moduleSpecifier: '../review/review-lock.service.js',
    namedImports: ['acquireReviewLock', 'releaseReviewLock']
  });

  // Update redis.service.spec.ts to import review locks from review module
  project.addSourceFilesAtPaths('src/**/*.spec.ts');
  const redisSpec = project.getSourceFileOrThrow('src/core/redis/redis.service.spec.ts');
  redisSpec.getImportDeclarations().forEach(imp => {
    if (imp.getModuleSpecifierValue() === './redis.service.js') {
      const lockNamed = imp.getNamedImports().filter(n => ['acquireReviewLock', 'releaseReviewLock'].includes(n.getName()));
      lockNamed.forEach(n => n.remove());
    }
  });
  redisSpec.addImportDeclaration({
    moduleSpecifier: '../../modules/review/review-lock.service.js',
    namedImports: ['acquireReviewLock', 'releaseReviewLock']
  });

  // Finally remove RepoContextCache, acquireReviewLock, releaseReviewLock from redis.service.ts
  redisService.getClassOrThrow('RepoContextCache').remove();
  redisService.getFunctionOrThrow('acquireReviewLock').remove();
  redisService.getFunctionOrThrow('releaseReviewLock').remove();

  // Also remove unused RepoContextDoc import from redis.service.ts
  redisService.getImportDeclarations().forEach(imp => {
    if (imp.getModuleSpecifierValue() === '../../modules/context/repo-context-builder.service.js') {
      imp.remove();
    }
  });

  await project.save();
}

main().catch(console.error);
