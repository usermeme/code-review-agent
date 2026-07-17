import { GoogleGenAI } from '@google/genai';

export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Gemini embeddings behind a minimal interface so an OpenAI-compatible
 * embedder can be swapped in without touching the store.
 */
export class GeminiEmbedder implements Embedder {
  private readonly client: GoogleGenAI;

  constructor(
    private readonly model: string,
    readonly dimensions: number,
    client?: GoogleGenAI,
  ) {
    this.client = client ?? new GoogleGenAI({});
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.client.models.embedContent({
      model: this.model,
      contents: texts,
      config: { outputDimensionality: this.dimensions },
    });
    const embeddings = response.embeddings ?? [];
    if (embeddings.length !== texts.length) {
      throw new Error(
        `Expected ${texts.length} embeddings, got ${embeddings.length}`,
      );
    }
    return embeddings.map((e) => {
      if (!e.values) throw new Error('Embedding response missing values');
      return e.values;
    });
  }
}
