import { BasePlugin, type BaseTool, type Context } from '@google/adk';

import { type PrMeta, STATE } from '../constants/state-keys.constant.js';

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function readPrMeta(toolContext: Context): PrMeta | undefined {
  return toolContext?.state?.get<PrMeta>(STATE.prMeta);
}

function isMissingCoordinate(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Scalar tool args are compared case-insensitively; anything else is a non-scalar offender. */
function readScalarText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function isAllowedCoordinate(
  text: string,
  allowed: Array<string | undefined>,
): boolean {
  return allowed.some(
    (candidate) => candidate !== undefined && sameName(text, candidate),
  );
}

/** Returns the offender description for one tool arg, or null when it matches. */
function describeCoordinateMismatch(
  key: string,
  value: unknown,
  allowed: Array<string | undefined>,
): string | null {
  if (isMissingCoordinate(value)) return null;
  const text = readScalarText(value);
  if (text === undefined) {
    return `${key}=<non-scalar>`;
  }
  return isAllowedCoordinate(text, allowed) ? null : `${key}="${text}"`;
}

function findCoordinateOffenders(
  toolArgs: Record<string, unknown>,
  meta: PrMeta,
): string[] {
  const offenders: string[] = [];

  const check = (key: string, allowed: Array<string | undefined>) => {
    const mismatch = describeCoordinateMismatch(key, toolArgs[key], allowed);
    if (mismatch !== null) {
      offenders.push(mismatch);
    }
  };

  check('provider', [meta.provider ?? 'github']);
  check('owner', [meta.owner]);
  check('repo', [
    meta.repo,
    meta.owner ? `${meta.owner}/${meta.repo}` : undefined,
  ]);
  check('prNumber', [String(meta.number)]);

  return offenders;
}

function buildCoordinateBlockMessage(
  toolName: string,
  offenders: string[],
  meta: PrMeta,
): string {
  return (
    `Blocked: ${toolName} was called with repository coordinates ` +
    `(${offenders.join(', ')}) that do not match the pull request under ` +
    `review (${meta.owner ?? ''}/${meta.repo}#${meta.number}). ` +
    'Repository coordinates are fixed for this invocation; retry the ' +
    'call without them.'
  );
}

/**
 * Defense-in-depth against prompt-injected repository-coordinate confusion.
 *
 * The model-facing tool schemas no longer expose `owner`/`repo`/`prNumber`/
 * `provider` at all (the tools resolve coordinates from session state), so
 * this guard should normally never fire. It exists to catch regressions and
 * hallucinations on any tool in the invocation — including reviewer
 * sub-agents and tools added later — by blocking tool calls whose
 * repository coordinates do not match the PR under review.
 *
 * Registered on the Runner, so it wraps every tool call in the invocation.
 * Returning a record from `beforeToolCallback` stops the tool execution and
 * returns that record as the tool response.
 */
export class CoordinateGuardPlugin extends BasePlugin {
  constructor() {
    super('coordinate-guard');
  }

  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const { tool, toolArgs, toolContext } = params;
    const meta = readPrMeta(toolContext);
    if (!meta || !toolArgs) return undefined;

    const offenders = findCoordinateOffenders(toolArgs, meta);
    if (offenders.length === 0) return undefined;

    return { error: buildCoordinateBlockMessage(tool.name, offenders, meta) };
  }
}
