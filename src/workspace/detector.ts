import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Detect the project root by walking up from `startDir`.
 * Priority: .nexus.json > .git > fallback to startDir.
 */
export function detectRoot(startDir: string): string {
  let dir = path.resolve(startDir);

  // First pass: look for .nexus.json (highest priority)
  let current = dir;
  while (true) {
    if (fs.existsSync(path.join(current, '.nexus.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Second pass: look for .git
  current = dir;
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fallback: use startDir as root
  return dir;
}

/**
 * Detect whether the filesystem at `rootDir` is case-sensitive.
 * Creates a temp file with a known name, checks if the uppercase variant resolves.
 */
export function detectCaseSensitivity(rootDir: string): boolean {
  const tmpName = `.nexus-case-probe-${randomUUID()}`;
  const tmpPath = path.join(rootDir, tmpName);

  try {
    fs.writeFileSync(tmpPath, '');
    const upperPath = path.join(rootDir, tmpName.toUpperCase());
    // If the uppercase path exists, the FS is case-insensitive
    const isCaseInsensitive = fs.existsSync(upperPath);
    return !isCaseInsensitive;
  } catch {
    // Can't write to rootDir — assume case-insensitive (safer default)
    return false;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Get the current git HEAD commit hash, or null if not a git repo.
 */
export function getGitHead(rootDir: string): string | null {
  const headPath = path.join(rootDir, '.git', 'HEAD');
  try {
    const head = fs.readFileSync(headPath, 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      // Resolve symbolic ref
      const refPath = path.join(rootDir, '.git', head.slice(5));
      try {
        return fs.readFileSync(refPath, 'utf-8').trim();
      } catch {
        return null;
      }
    }
    // Detached HEAD — already a hash
    return head;
  } catch {
    return null;
  }
}
