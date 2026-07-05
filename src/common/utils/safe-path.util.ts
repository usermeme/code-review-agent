import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

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
export async function resolveInsideCheckout(dir: string, relPath: string): Promise<string | null> {
  const lexical = resolve(dir, relPath);
  if (lexical !== dir && !lexical.startsWith(dir + sep)) return null;
  try {
    const [real, realDir] = await Promise.all([realpath(lexical), realpath(dir)]);
    return real === realDir || real.startsWith(realDir + sep) ? real : null;
  } catch {
    return lexical;
  }
}
