import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Parser, type ReadEntry } from 'tar';

import {
  isBinaryBuffer,
  isIndexableFilePath,
  normalizeTarEntryPath,
} from './file-filter.util.js';
import { RepoWorkspace } from './repo-workspace.js';

export interface LoadRepoWorkspaceOptions {
  /** Maximum size of a single file to index in bytes (default: 512 KB). */
  maxFileBytes?: number;
  /** Maximum total bytes indexed across all files (default: 30 MB). */
  maxTotalBytes?: number;
  /** Optional unified PR diff to attach to the workspace. */
  rawDiff?: string;
  /** Optional list of changed file paths in the PR. */
  changedFiles?: string[];
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 30 * 1024 * 1024;

function isWebReadableStream(
  input: unknown,
): input is Parameters<typeof Readable.fromWeb>[0] {
  return (
    typeof input === 'object' &&
    input !== null &&
    'getReader' in input &&
    typeof (input as { getReader?: unknown }).getReader === 'function'
  );
}

function resolveNodeReadable(
  source: Response | ReadableStream | NodeJS.ReadableStream,
): NodeJS.ReadableStream {
  if ('body' in source && source instanceof Response) {
    if (!source.body) {
      throw new Error('Tarball response has an empty body.');
    }
    return Readable.fromWeb(
      source.body as Parameters<typeof Readable.fromWeb>[0],
    );
  }
  if (isWebReadableStream(source)) {
    return Readable.fromWeb(source);
  }
  return source as NodeJS.ReadableStream;
}

interface EntryCollectorState {
  files: Map<string, string[]>;
  totalBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

function shouldCollectEntry(
  entry: ReadEntry,
  relativePath: string,
  state: EntryCollectorState,
): boolean {
  if (entry.type !== 'File') {
    return false;
  }
  if (!isIndexableFilePath(relativePath)) {
    return false;
  }
  const size = entry.size ?? 0;
  if (size > state.maxFileBytes) {
    return false;
  }
  return state.totalBytes + size <= state.maxTotalBytes;
}

function storeEntryBuffer(
  relativePath: string,
  buffer: Buffer,
  state: EntryCollectorState,
): void {
  if (
    buffer.length > state.maxFileBytes ||
    state.totalBytes + buffer.length > state.maxTotalBytes ||
    isBinaryBuffer(buffer)
  ) {
    return;
  }
  state.totalBytes += buffer.length;
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
  state.files.set(relativePath, text.split('\n'));
}

function handleTarEntry(entry: ReadEntry, state: EntryCollectorState): void {
  const relativePath = normalizeTarEntryPath(entry.path);
  if (!shouldCollectEntry(entry, relativePath, state)) {
    entry.resume();
    return;
  }

  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let aborted = false;

  entry.on('data', (chunk: Buffer) => {
    bytesRead += chunk.length;
    if (
      bytesRead > state.maxFileBytes ||
      state.totalBytes + bytesRead > state.maxTotalBytes
    ) {
      aborted = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });

  entry.on('end', () => {
    if (!aborted) {
      storeEntryBuffer(relativePath, Buffer.concat(chunks), state);
    }
  });
}

/**
 * Streams a `.tar.gz` repository archive into an in-memory {@link RepoWorkspace},
 * filtering out non-source/binary/oversized files on the fly without writing to disk.
 */
export async function loadRepoWorkspaceFromTarball(
  source: Response | ReadableStream | NodeJS.ReadableStream,
  options: LoadRepoWorkspaceOptions = {},
): Promise<RepoWorkspace> {
  const readable = resolveNodeReadable(source);
  const state: EntryCollectorState = {
    files: new Map<string, string[]>(),
    totalBytes: 0,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };

  const parser = new Parser({
    onReadEntry: (entry: ReadEntry) => {
      handleTarEntry(entry, state);
    },
  });

  await pipeline(readable, parser);

  return new RepoWorkspace({
    files: state.files,
    rawDiff: options.rawDiff,
    changedFiles: options.changedFiles,
  });
}
