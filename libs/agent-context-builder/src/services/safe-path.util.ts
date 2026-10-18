import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** True when `path` is `dirPath` itself or nested inside it. */
function isInsideDir(path: string, dirPath: string): boolean {
  return path === dirPath || path.startsWith(dirPath + sep);
}

/** realpath that maps any failure (missing path, permission, ...) to null. */
async function tryRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Resolves a repo-relative path and jails it to the checkout: returns null
 * when the path escapes `dir`, either lexically (`..`, absolute paths) or
 * through a symlink anywhere in the path. Checkouts contain untrusted PR
 * content, so a symlink may point at /proc/self/environ, key files, or any
 * other host path.
 *
 * Paths that do not exist are returned unresolved — realpath cannot follow
 * them, and neither can the read that comes next, so the caller's normal
 * unreadable-file handling applies.
 */
export async function resolveInsideCheckout(
  dir: string,
  relPath: string,
): Promise<string | null> {
  const resolvedPath = resolve(dir, relPath);
  if (!isInsideDir(resolvedPath, dir)) {
    return null;
  }

  const realDirPath = await tryRealpath(dir);
  if (realDirPath === null) {
    return null;
  }

  try {
    const realPath = await realpath(resolvedPath);
    const isInsideCheckout = isInsideDir(realPath, realDirPath);
    if (isInsideCheckout) {
      return realPath;
    }

    return null;
  } catch {
    return resolvedPath;
  }
}
