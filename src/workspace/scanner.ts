import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IgnoreMatcher } from './ignores.js';

/**
 * Supported language extensions → language name mapping.
 */
const DEFAULT_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.css': 'css',
};

export interface ScannedFile {
  /** POSIX-relative path from root, original case */
  path: string;
  /** Absolute path on disk */
  absolutePath: string;
  /** Detected language */
  language: string;
  /** File stat mtime (epoch ms as float) */
  mtime: number;
  /** File size in bytes */
  size: number;
}

export interface ScanOptions {
  maxFileSize: number;
  minifiedLineLength: number;
  /** Extra extension → language mappings from config */
  extraExtensions?: Record<string, string>;
}

/**
 * Recursively scan a directory for indexable source files.
 * Applies ignore rules, skips oversized/minified files, detects language.
 */
export function scanDirectory(
  rootDir: string,
  isIgnored: IgnoreMatcher,
  options: ScanOptions,
): ScannedFile[] {
  const results: ScannedFile[] = [];
  const root = path.resolve(rootDir);

  // Merge default + config extensions
  const extensions = { ...DEFAULT_EXTENSIONS };
  if (options.extraExtensions) {
    Object.assign(extensions, options.extraExtensions);
  }

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Can't read directory — skip
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (!isIgnored(relativePath, true)) {
          walk(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;

      // Check ignore rules
      if (isIgnored(relativePath, false)) continue;

      // Check extension → language
      const ext = path.extname(entry.name).toLowerCase();
      const language = extensions[ext];
      if (!language) continue; // Unsupported extension — skip silently

      // Get file stats
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue; // Can't stat — skip
      }

      // Skip oversized files
      if (stat.size > options.maxFileSize) continue;

      // Skip minified files (only check if file is large enough to matter)
      if (stat.size > 1024 && isMinified(fullPath, stat.size, options.minifiedLineLength)) {
        continue;
      }

      results.push({
        path: relativePath,
        absolutePath: fullPath,
        language,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    }
  }

  walk(root);
  return results;
}

/**
 * Detect if a file is likely minified.
 * Heuristic: avg line length > threshold OR < 5 newlines per 10KB.
 */
function isMinified(filePath: string, fileSize: number, threshold: number): boolean {
  try {
    // Read first 10KB to check
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(Math.min(fileSize, 10_240));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);

    const content = buffer.toString('utf-8');
    const newlines = content.split('\n').length - 1;

    if (newlines === 0) {
      // Single line file > 1KB — likely minified
      return fileSize > 1024;
    }

    // Check average line length
    const avgLineLength = content.length / (newlines + 1);
    if (avgLineLength > threshold) return true;

    // Check newline density (< 5 newlines per 10KB)
    if (newlines < 5 && fileSize >= 10_240) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Build extra extension mappings from config languages.
 */
export function buildExtraExtensions(
  configLanguages: Record<string, { extensions: string[] }>,
): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [lang, { extensions }] of Object.entries(configLanguages)) {
    for (const ext of extensions) {
      const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
      extra[normalizedExt] = lang;
    }
  }
  return extra;
}
