import { type Chunk, renderChunk } from '../repo/chunker.js';
import { UNTRUSTED_REPO_CONTENT_WARNING, wrapUntrusted } from './untrusted.js';

export function summarizeChunkPrompt(chunk: Chunk): string {
  return `You are analyzing one chunk of a codebase to help build a whole-repo context document.
Summarize this chunk covering: architecture and responsibilities, internal patterns and conventions,
error handling idioms, testing idioms, and notable utilities. Be specific — name files, functions, and patterns.

${UNTRUSTED_REPO_CONTENT_WARNING}

${wrapUntrusted(renderChunk(chunk))}`;
}
