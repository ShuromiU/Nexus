import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IgnoreMatcher } from './ignores.js';
import { classifyPath } from './classify.js';
import type { ClassifyConfig } from './classify.js';

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
  /** Resolved .nexus.json language overrides (forwarded to classifyPath). */
  languages: Record<string, { extensions: string[] }>;
}

function scanWithGit(
  rootDir: string,
  classifyConfig: ClassifyConfig,
  options: ScanOptions,
): ScannedFile[] | null {
  const root = path.resolve(rootDir);

  try {
    fs.statSync(path.join(root, '.git'));
  } catch {
    return null;
  }

  try {
    const output = execFileSync('git', [
      'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ], {
      cwd: root,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const files = output.split('\0').filter(f => f.length > 0);
    const results: ScannedFile[] = [];

    for (const relativePath of files) {
      const posixPath = relativePath.replace(/\\/g, '/');
      const basename = path.basename(posixPath);
      const kind = classifyPath(posixPath, basename, classifyConfig);
      if (kind.kind !== 'source') continue;

      const fullPath = path.join(root, relativePath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (!stat.isFile()) continue;
      if (stat.size > options.maxFileSize) continue;
      if (stat.size > 1024 && isMinified(fullPath, stat.size, options.minifiedLineLength)) continue;

      results.push({
        path: posixPath,
        absolutePath: fullPath,
        language: kind.language,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    }

    return results;
  } catch {
    return null;
  }
}

/**
 * Recursively scan a directory for indexable source files.
 * Tries git ls-files first for speed, falls back to directory walk.
 * Classification is delegated to classifyPath(); non-source kinds are skipped.
 */
export function scanDirectory(
  rootDir: string,
  isIgnored: IgnoreMatcher,
  options: ScanOptions,
): ScannedFile[] {
  const root = path.resolve(rootDir);
  const classifyConfig: ClassifyConfig = { languages: options.languages };

  const gitResult = scanWithGit(root, classifyConfig, options);
  if (gitResult !== null) return gitResult;

  const results: ScannedFile[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
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
      if (isIgnored(relativePath, false)) continue;

      const kind = classifyPath(relativePath, entry.name, classifyConfig);
      if (kind.kind !== 'source') continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.size > options.maxFileSize) continue;
      if (stat.size > 1024 && isMinified(fullPath, stat.size, options.minifiedLineLength)) {
        continue;
      }

      results.push({
        path: relativePath,
        absolutePath: fullPath,
        language: kind.language,
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
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(Math.min(fileSize, 10_240));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);

    const content = buffer.toString('utf-8');
    const newlines = content.split('\n').length - 1;

    if (newlines === 0) return fileSize > 1024;

    const avgLineLength = content.length / (newlines + 1);
    if (avgLineLength > threshold) return true;
    if (newlines < 5 && fileSize >= 10_240) return true;

    return false;
  } catch {
    return false;
  }
}
