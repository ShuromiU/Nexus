import * as path from 'node:path';

/**
 * Path fragments that are not "code" for the purpose of policy rules.
 * Shared between grep-on-code and read-on-source. Matches are substring-based
 * (case-insensitive) — path need not start with the fragment.
 */
export const NON_CODE_PATH = /(node_modules|\.git|\.nexus|\/?docs\/|\.env|\.claude\/)/i;

/**
 * Normalize an arbitrary `file_path` (POSIX or Windows) against `rootDir`
 * into a `{ relPath, absPath }` pair. Both paths are POSIX-style
 * (forward slashes); `relPath` falls back to the normalized input when the
 * path is outside `rootDir` so basename-based classifiers still work.
 *
 * Used by every policy rule that consumes `tool_input.file_path` —
 * preedit-impact, read-on-source, read-on-structured. Centralized so the
 * Windows drive-letter handling (`C:/...`) only lives in one place.
 */
export function relativize(
  rawPath: string,
  rootDir: string,
): { relPath: string; absPath: string } {
  const normalized = rawPath.replace(/\\/g, '/');
  const rootDirPosix = rootDir.replace(/\\/g, '/');
  // POSIX `isAbsolute` doesn't recognize Windows drive-letter prefixes
  // (e.g. "C:/..."), so detect those explicitly — otherwise `resolve`
  // concatenates the cwd + root + path.
  const isWinAbs = /^[a-zA-Z]:\//.test(normalized);
  const absPath = isWinAbs || path.posix.isAbsolute(normalized)
    ? normalized
    : path.posix.resolve(rootDirPosix || '/', normalized);
  const candidateRel = rootDirPosix
    ? path.posix.relative(rootDirPosix, absPath)
    : normalized;
  // If the path is outside rootDir (starts with '..'), fall back to the
  // normalized input — basename classification still works.
  const relPath = candidateRel.startsWith('..') ? normalized : candidateRel;
  return { relPath, absPath };
}
