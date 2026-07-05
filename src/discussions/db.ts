import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { logger } from '../util/logger.js';

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}

/** Arbitrary constant identifying "code-review-agent migrations" cluster-wide. */
const MIGRATION_LOCK_KEY = 724_401_137;

export async function runMigrations(pool: pg.Pool, migrationsDir = 'migrations'): Promise<void> {
  // Replicas starting concurrently must not race the check-then-apply below.
  // Advisory locks are session-scoped, so acquire and release must happen on
  // one dedicated connection held for the whole run.
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await applyMigrations(pool, migrationsDir);
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    lock.release();
  }
}

async function applyMigrations(pool: pg.Pool, migrationsDir: string): Promise<void> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (rowCount) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info({ migration: file }, 'applied migration');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
