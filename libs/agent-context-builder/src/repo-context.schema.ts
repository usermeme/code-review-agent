import type { RepoContextSections } from '@code-review-agent/shared-types';
import { z } from 'zod';

const section = z.string().trim().min(1);

/** Structured-output schema for the synthesize step; every section is required. */
export const repoContextSectionsSchema = z.object({
  architecture: section,
  modules: section,
  patterns: section,
  errorHandling: section,
}) satisfies z.ZodType<RepoContextSections>;
