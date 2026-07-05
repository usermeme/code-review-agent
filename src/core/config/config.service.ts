import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { configSchema, type AppConfig } from './config.schema.js';

const ENV_OVERRIDE_PREFIX = 'CRA__';

/** Replaces `${VAR}` placeholders with values from the environment. */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    const exactMatch = value.match(/^\$\{(\w+)\}$/);
    if (exactMatch) {
      const envVal = env[exactMatch[1]!];
      return envVal ? envVal : undefined;
    }
    return value.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? '');
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => interpolateEnv(item, env))
      .filter((item) => item !== undefined);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v, env)]),
    );
  }

  return value;
}

const parseEnvValue = (value: string): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
};

/** Applies `CRA__models__agents__orchestrator=claude` style env overrides. */
export function applyEnvOverrides(config: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.startsWith(ENV_OVERRIDE_PREFIX) || rawValue === undefined) continue;

    const path = key.slice(ENV_OVERRIDE_PREFIX.length).split('__');
    const leafKey = path.pop()!;

    let currentNode = config;
    for (const segment of path) {
      if (currentNode[segment] === null || typeof currentNode[segment] !== 'object') {
        currentNode[segment] = {};
      }
      currentNode = currentNode[segment] as Record<string, unknown>;
    }

    currentNode[leafKey] = parseEnvValue(rawValue);
  }
}

export function loadConfig(configPath?: string): AppConfig {
  const path = resolve(configPath ?? process.env['CONFIG_PATH'] ?? 'config/default.yaml');
  const parsed = yaml.load(readFileSync(path, 'utf8'));
  const interpolated = interpolateEnv(parsed) as Record<string, unknown>;
  applyEnvOverrides(interpolated);
  return configSchema.parse(interpolated);
}
