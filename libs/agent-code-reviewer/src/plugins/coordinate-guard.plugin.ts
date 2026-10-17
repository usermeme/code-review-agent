import { BasePlugin, type BaseTool, type Context } from '@google/adk';

import { type PrMeta, STATE } from '../constants/state-keys.constant.js';

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
    const meta = toolContext?.state?.get<PrMeta>(STATE.prMeta);
    if (!meta || !toolArgs) return undefined;

    const sameName = (a: string, b: string) =>
      a.toLowerCase() === b.toLowerCase();
    const offenders: string[] = [];

    const check = (key: string, allowed: Array<string | undefined>) => {
      const value = toolArgs[key];
      if (value === undefined || value === null || value === '') return;
      const text =
        typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : undefined;
      if (text === undefined) {
        offenders.push(`${key}=<non-scalar>`);
        return;
      }
      const isAllowed = allowed.some(
        (candidate) => candidate !== undefined && sameName(text, candidate),
      );
      if (!isAllowed) offenders.push(`${key}="${text}"`);
    };

    check('provider', [meta.provider ?? 'github']);
    check('owner', [meta.owner]);
    check('repo', [meta.repo, meta.owner ? `${meta.owner}/${meta.repo}` : '']);
    check('prNumber', [String(meta.number)]);

    if (offenders.length === 0) return undefined;

    return {
      error:
        `Blocked: ${tool.name} was called with repository coordinates ` +
        `(${offenders.join(', ')}) that do not match the pull request under ` +
        `review (${meta.owner ?? ''}/${meta.repo}#${meta.number}). ` +
        'Repository coordinates are fixed for this invocation; retry the ' +
        'call without them.',
    };
  }
}
