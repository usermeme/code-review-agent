import { z, ZodType } from 'zod';

/**
 * Type-safe environment manager backed by Zod.
 * Eagerly validates the environment in constructor and exposes typed `get(key)` and `getOrThrow(key)` methods.
 */
export class EnvService<T extends ZodType<any, any, any>> {
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

  /**
   * Retrieves a validated environment variable by key, throwing an error if it is null or undefined.
   */
  getOrThrow<K extends keyof z.infer<T>>(key: K): NonNullable<z.infer<T>[K]> {
    const value = this.data[key];
    if (value === undefined || value === null) {
      throw new Error(`Environment variable "${String(key)}" is not defined.`);
    }
    return value;
  }
}

/**
 * Alias for backward compatibility.
 */
export { EnvService as Env };
