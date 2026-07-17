import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data', 'contexts');

export interface ContextData {
  repo: string;
  headSha?: string;
  sections: Record<string, string>;
  updatedAt: string;
}

export class DbService {
  constructor() {
    this.init().catch(console.error);
  }

  private async init() {
    await mkdir(DATA_DIR, { recursive: true });
  }

  private getFilePath(repo: string) {
    // Replace slashes so it's a valid filename
    const safeRepo = repo.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(DATA_DIR, `${safeRepo}.json`);
  }

  async saveContext(repo: string, data: Partial<ContextData>) {
    const file = this.getFilePath(repo);
    const fullData: ContextData = {
      ...data,
      repo,
      sections: data.sections || {},
      updatedAt: new Date().toISOString(),
    };
    await writeFile(file, JSON.stringify(fullData, null, 2), 'utf-8');
    return fullData;
  }

  async getContext(repo: string): Promise<ContextData | null> {
    const file = this.getFilePath(repo);
    try {
      const content = await readFile(file, 'utf-8');
      return JSON.parse(content) as ContextData;
    } catch {
      return null;
    }
  }
}

export const dbService = new DbService();
