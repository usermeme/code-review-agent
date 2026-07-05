import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { configSchema, type AppConfig } from './schema.js';

const ENV_OVERRIDE_PREFIX = 'CRA__';

/** Replaces `${VAR}` placeholders with values from the environment. */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    const match = value.match(/^\$\{(\w+)\}$/);
    if (match) {
      const name = match[1]!;
      const envVal = env[name];
      return envVal !== undefined && envVal !== '' ? envVal : undefined;
    }
    return value.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? '');
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v, env)).filter((v) => v !== undefined);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v, env)]),
    );
  }
  return value;
}

/** Applies `CRA__models__agents__orchestrator=claude` style env overrides. */
export function applyEnvOverrides(config: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(ENV_OVERRIDE_PREFIX) || raw === undefined) continue;
    const path = key.slice(ENV_OVERRIDE_PREFIX.length).split('__');
    let node: Record<string, unknown> = config;
    for (const segment of path.slice(0, -1)) {
      const next = node[segment];
      if (next === null || typeof next !== 'object') {
        node[segment] = {};
      }
      node = node[segment] as Record<string, unknown>;
    }
    const leaf = path[path.length - 1]!;
    let parsed: unknown = raw;
    if (raw === 'true') parsed = true;
    else if (raw === 'false') parsed = false;
    else if (raw !== '' && !Number.isNaN(Number(raw))) parsed = Number(raw);
    node[leaf] = parsed;
  }
}

export function loadConfig(configPath?: string): AppConfig {
  const path = resolve(configPath ?? process.env['CONFIG_PATH'] ?? 'config/default.yaml');
  const parsed = yaml.load(readFileSync(path, 'utf8'));
  const interpolated = interpolateEnv(parsed) as Record<string, unknown>;
  applyEnvOverrides(interpolated);
  return configSchema.parse(interpolated);
}
