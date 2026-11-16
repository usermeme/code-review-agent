import { createRepoTools, RepoWorkspace } from '@code-review-agent/agent-tools';
import type { FunctionTool } from '@google/adk';
import { describe, expect, it } from 'vitest';

import { createSubmitVerdictsTool } from '../verifier/submit-verdicts.tool.js';
import { createSubmitReviewTool } from './submit-review.tool.js';

/**
 * Fields of the Gemini API `Schema` object. Function declarations are
 * rejected with 400 "Unknown name" for anything else (e.g. the
 * `exclusiveMinimum` zod emits for `.positive()`), before the model runs.
 */
const GEMINI_SCHEMA_FIELDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'default',
  'example',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'propertyOrdering',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'anyOf',
]);

/** Nested schemas under a schema key, with the path suffix of each. */
function childSchemas(key: string, value: unknown): Array<[string, unknown]> {
  if (key === 'properties') {
    return Object.entries(value as Record<string, unknown>).map(
      ([name, child]) => [`.${name}`, child],
    );
  }
  if (key === 'items') return [['', value]];
  if (key === 'anyOf') {
    return (value as unknown[]).map((child, i) => [`[${i}]`, child]);
  }
  return [];
}

/** Paths of schema keys Gemini does not accept, e.g. `findings.items.line.exclusiveMinimum`. */
function unsupportedKeys(schema: unknown, path = ''): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) => {
    const here = path ? `${path}.${key}` : key;
    if (!GEMINI_SCHEMA_FIELDS.has(key)) return [here];
    return childSchemas(key, value).flatMap(([suffix, child]) =>
      unsupportedKeys(child, `${here}${suffix}`),
    );
  });
}

function agentTools(): FunctionTool[] {
  const workspace = new RepoWorkspace({
    files: new Map(),
    rawDiff: '',
    changedFiles: [],
  });
  return [
    ...createRepoTools(workspace).all,
    createSubmitReviewTool(workspace).tool,
    createSubmitVerdictsTool().tool,
  ];
}

describe('agent tool declarations', () => {
  it.each(agentTools().map((tool) => [tool.name, tool] as const))(
    '%s only uses schema fields the Gemini API accepts',
    (_name, tool) => {
      const declaration = tool._getDeclaration();

      expect(unsupportedKeys(declaration.parameters)).toEqual([]);
    },
  );
});
