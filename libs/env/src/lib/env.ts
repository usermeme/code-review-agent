import { z, ZodType } from 'zod';

/**
 * Type-safe environment manager backed by Zod.
 * Eagerly validates the environment in constructor and exposes a typed `get(key)` method.
 */
export class Env<T extends ZodType<any, any, any>> {
  private readonly data: z.infer<T>;

  constructor(schema: T, source: Record<string, unknown> = process.env) {
    const result = schema.safeParse(source);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  - ${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('\n');
      throw new Error(`Environment validation failed:\n${issues}`);
    }
    this.data = result.data;
  }

  /**
   * Retrieves a validated environment variable by key.
   * Return type is inferred from the Zod schema.
   */
  get<K extends keyof z.infer<T>>(key: K): z.infer<T>[K] {
    return this.data[key];
  }
}
