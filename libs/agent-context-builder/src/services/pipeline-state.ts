/**
 * Minimal get/set state carrier for the deterministic context-building
 * pipeline. Mirrors the slice of the ADK session State API the pipeline
 * steps use, without requiring a runner/session — the pipeline never talks
 * to an LLM for orchestration, only for chunk summarization and synthesis.
 */
export class PipelineState {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}
