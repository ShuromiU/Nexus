import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Default directories always excluded from indexing.
 */
const DEFAULT_EXCLUDES = [
  'node_modules',
  'dist',
  '.next',
  '.nuxt',
  'build',
  'out',
  '.nexus',
  '.git',
  '__pycache__',
  'target',
  'bin',
  'obj',
];

/** A pattern from an ignore file, with its base directory for relative matching. */
interface IgnorePattern {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

/**
 * Parse a single gitignore-style line into a pattern.
 * Returns null for comments and blank lines.
 */
function parseLine(line: string): IgnorePattern | null {
  // Strip trailing whitespace (but not leading — significant in gitignore)
  let trimmed = line.replace(/\s+$/, '');
  if (!trimmed || trimmed.startsWith('#')) return null;

  let negated = false;
  if (trimmed.startsWith('!')) {
    negated = true;
    trimmed = trimmed.slice(1);
  }

  let dirOnly = false;
  if (trimmed.endsWith('/')) {
    dirOnly = true;
    trimmed = trimmed.slice(0, -1);
  }

  const regex = globToRegex(trimmed);
  return { pattern: trimmed, negated, dirOnly, regex };
}

/**
 * Convert a gitignore glob pattern to a regex.
 * Handles *, **, ?, and character classes.
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;

  // If pattern contains a slash (not at end), it's anchored to root
  const anchored = pattern.includes('/');

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // **/ matches zero or more directories
          regexStr += '(?:.+/)?';
          i += 3;
          continue;
        }
        // ** at end matches everything
        regexStr += '.*';
        i += 2;
        continue;
      }
      // * matches anything except /
      regexStr += '[^/]*';
      i++;
    } else if (c === '?') {
      regexStr += '[^/]';
      i++;
    } else if (c === '[') {
      // Character class — pass through until ]
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        regexStr += '\\[';
        i++;
      } else {
        regexStr += pattern.slice(i, close + 1);
        i = close + 1;
      }
    } else if (c === '/' && i === 0) {
      // Leading slash means anchored — skip it (regex already anchored with ^)
      i++;
    } else {
      // Escape regex special chars
      regexStr += c.replace(/[.+^${}()|\\]/g, '\\$&');
      i++;
    }
  }

  if (anchored) {
    return new RegExp('^' + regexStr + '(?:/|$)');
  }

  // Un-anchored patterns match against the basename or any path segment
  return new RegExp('(?:^|/)' + regexStr + '(?:/|$)');
}

/**
 * Load patterns from a gitignore-style file.
 */
function loadPatternFile(filePath: string): IgnorePattern[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .map(parseLine)
      .filter((p): p is IgnorePattern => p !== null);
  } catch {
    return [];
  }
}

export type IgnoreMatcher = (relativePath: string, isDir: boolean) => boolean;

/**
 * Build an ignore matcher from all ignore sources.
 * Priority: .nexusignore > config excludes > .gitignore > defaults.
 *
 * Returns a function that takes a POSIX-relative path and returns true if ignored.
 */
export function buildIgnoreMatcher(
  rootDir: string,
  configExcludes: string[] = [],
): IgnoreMatcher {
  const patterns: IgnorePattern[] = [];

  // 1. Default excludes (lowest priority — added first, can be overridden by negation)
  for (const dir of DEFAULT_EXCLUDES) {
    const regex = new RegExp('(?:^|/)' + dir.replace(/[.+^${}()|\\]/g, '\\$&') + '(?:/|$)');
    patterns.push({ pattern: dir, negated: false, dirOnly: true, regex });
  }

  // 2. .gitignore
  patterns.push(...loadPatternFile(path.join(rootDir, '.gitignore')));

  // 3. Config excludes
  for (const excl of configExcludes) {
    const parsed = parseLine(excl);
    if (parsed) patterns.push(parsed);
  }

  // 4. .nexusignore (highest priority — added last, wins conflicts)
  patterns.push(...loadPatternFile(path.join(rootDir, '.nexusignore')));

  return (relativePath: string, isDir: boolean): boolean => {
    // Normalize to forward slashes
    const normalized = relativePath.replace(/\\/g, '/');

    let ignored = false;
    // Last-match-wins (gitignore semantics)
    for (const p of patterns) {
      if (p.dirOnly && !isDir) {
        // dirOnly patterns still match files whose parent directories match.
        // Check if any parent segment of the path matches.
        const segments = normalized.split('/');
        let parentMatch = false;
        for (let i = 0; i < segments.length - 1; i++) {
          const parentPath = segments.slice(0, i + 1).join('/');
          if (p.regex.test(parentPath)) {
            parentMatch = true;
            break;
          }
        }
        if (!parentMatch) continue;
      } else if (!p.regex.test(normalized)) {
        continue;
      }
      ignored = !p.negated;
    }
    return ignored;
  };
}
