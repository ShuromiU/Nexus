import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig, computeConfigHash } from '../src/config.js';
import { detectRoot, detectCaseSensitivity, getGitHead } from '../src/workspace/detector.js';
import { buildIgnoreMatcher } from '../src/workspace/ignores.js';
import { scanDirectory } from '../src/workspace/scanner.js';
import { detectChanges, hashFile, summarizeChanges } from '../src/workspace/changes.js';
import type { ScannedFile } from '../src/workspace/scanner.js';
import type { FileRow } from '../src/db/store.js';

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `nexus-ws-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ── Config ─────────────────────────────────────────────────────────────

describe('Config', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmrf(dir); });

  it('returns defaults when no .nexus.json exists', () => {
    const config = loadConfig(dir);
    expect(config.root).toBe('.');
    expect(config.exclude).toEqual([]);
    expect(config.include).toEqual([]);
    expect(config.maxFileSize).toBe(1_048_576);
    expect(config.minifiedLineLength).toBe(500);
  });

  it('loads .nexus.json with partial overrides', () => {
    fs.writeFileSync(
      path.join(dir, '.nexus.json'),
      JSON.stringify({ exclude: ['vendor/**'], maxFileSize: 512_000 }),
    );
    const config = loadConfig(dir);
    expect(config.exclude).toEqual(['vendor/**']);
    expect(config.maxFileSize).toBe(512_000);
    // Defaults for non-overridden fields
    expect(config.root).toBe('.');
    expect(config.include).toEqual([]);
  });

  it('handles invalid JSON gracefully', () => {
    fs.writeFileSync(path.join(dir, '.nexus.json'), '{broken json!!!');
    const config = loadConfig(dir);
    expect(config.root).toBe('.');
  });

  it('computes deterministic config hash', () => {
    const config = loadConfig(dir);
    const hash1 = computeConfigHash(config);
    const hash2 = computeConfigHash(config);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });

  it('config hash changes when config changes', () => {
    const config1 = loadConfig(dir);
    const hash1 = computeConfigHash(config1);

    fs.writeFileSync(
      path.join(dir, '.nexus.json'),
      JSON.stringify({ exclude: ['vendor/**'] }),
    );
    const config2 = loadConfig(dir);
    const hash2 = computeConfigHash(config2);

    expect(hash1).not.toBe(hash2);
  });
});

// ── Detector ───────────────────────────────────────────────────────────

describe('Detector', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmrf(dir); });

  it('detects root via .nexus.json', () => {
    fs.writeFileSync(path.join(dir, '.nexus.json'), '{}');
    const subDir = path.join(dir, 'a', 'b');
    fs.mkdirSync(subDir, { recursive: true });
    const root = detectRoot(subDir);
    expect(root).toBe(dir);
  });

  it('detects root via .git', () => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const subDir = path.join(dir, 'src', 'lib');
    fs.mkdirSync(subDir, { recursive: true });
    const root = detectRoot(subDir);
    expect(root).toBe(dir);
  });

  it('prefers .nexus.json over .git', () => {
    // .git at dir level, .nexus.json at subproject level
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const subProject = path.join(dir, 'sub');
    fs.mkdirSync(subProject, { recursive: true });
    fs.writeFileSync(path.join(subProject, '.nexus.json'), '{}');

    const root = detectRoot(path.join(subProject, 'src'));
    expect(root).toBe(subProject);
  });

  it('falls back to startDir when no markers found', () => {
    // Use a deeply nested tmpdir with no .git or .nexus.json
    const deepDir = path.join(dir, 'no', 'markers', 'here');
    fs.mkdirSync(deepDir, { recursive: true });
    const root = detectRoot(deepDir);
    expect(root).toBe(deepDir);
  });

  it('detects case sensitivity', () => {
    const result = detectCaseSensitivity(dir);
    // On Windows, this should be false. On Linux, true.
    expect(typeof result).toBe('boolean');
    if (process.platform === 'win32') {
      expect(result).toBe(false);
    }
  });

  it('getGitHead returns null for non-git dirs', () => {
    expect(getGitHead(dir)).toBeNull();
  });

  it('getGitHead reads HEAD for git dirs', () => {
    // Create a fake .git with a HEAD ref
    fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(dir, '.git', 'refs', 'heads', 'main'),
      'abc123def456\n',
    );
    expect(getGitHead(dir)).toBe('abc123def456');
  });
});

// ── Ignores ────────────────────────────────────────────────────────────

describe('Ignores', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmrf(dir); });

  it('excludes default directories', () => {
    const matcher = buildIgnoreMatcher(dir);
    expect(matcher('node_modules', true)).toBe(true);
    expect(matcher('dist', true)).toBe(true);
    expect(matcher('.next', true)).toBe(true);
    expect(matcher('.git', true)).toBe(true);
    expect(matcher('__pycache__', true)).toBe(true);
    expect(matcher('target', true)).toBe(true);
  });

  it('does not exclude regular directories', () => {
    const matcher = buildIgnoreMatcher(dir);
    expect(matcher('src', true)).toBe(false);
    expect(matcher('lib', true)).toBe(false);
    expect(matcher('components', true)).toBe(false);
  });

  it('respects .gitignore patterns', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\ncoverage/\n');
    const matcher = buildIgnoreMatcher(dir);
    expect(matcher('app.log', false)).toBe(true);
    expect(matcher('logs/debug.log', false)).toBe(true);
    expect(matcher('coverage', true)).toBe(true);
  });

  it('respects .nexusignore patterns', () => {
    fs.writeFileSync(path.join(dir, '.nexusignore'), 'generated/**\n');
    const matcher = buildIgnoreMatcher(dir);
    expect(matcher('generated/types.ts', false)).toBe(true);
    expect(matcher('src/types.ts', false)).toBe(false);
  });

  it('respects config excludes', () => {
    const matcher = buildIgnoreMatcher(dir, ['vendor/**']);
    expect(matcher('vendor/lib.js', false)).toBe(true);
    expect(matcher('src/lib.js', false)).toBe(false);
  });

  it('supports negation patterns', () => {
    fs.writeFileSync(path.join(dir, '.nexusignore'), '*.test.ts\n!important.test.ts\n');
    const matcher = buildIgnoreMatcher(dir);
    expect(matcher('foo.test.ts', false)).toBe(true);
    expect(matcher('important.test.ts', false)).toBe(false);
  });

  it('handles nested node_modules', () => {
    const matcher = buildIgnoreMatcher(dir);
    expect(matcher('packages/foo/node_modules', true)).toBe(true);
    expect(matcher('node_modules/react/index.js', false)).toBe(true);
  });
});

// ── Scanner ────────────────────────────────────────────────────────────

describe('Scanner', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmrf(dir); });

  it('discovers source files with correct language', () => {
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1');
    fs.writeFileSync(path.join(dir, 'main.go'), 'package main');
    fs.writeFileSync(path.join(dir, 'readme.md'), '# Hello');

    const matcher = buildIgnoreMatcher(dir);
    const files = scanDirectory(dir, matcher, {
      maxFileSize: 1_048_576,
      minifiedLineLength: 500,
      languages: {},
    });

    const languages = files.map(f => f.language).sort();
    expect(languages).toEqual(['go', 'python', 'typescript']);
    // .md is not a supported extension — skipped
    expect(files.find(f => f.path === 'readme.md')).toBeUndefined();
  });

  it('skips node_modules', () => {
    const nmDir = path.join(dir, 'node_modules', 'react');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(dir, 'src.ts'), 'const x = 1;');

    const matcher = buildIgnoreMatcher(dir);
    const files = scanDirectory(dir, matcher, {
      maxFileSize: 1_048_576,
      minifiedLineLength: 500,
      languages: {},
    });

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src.ts');
  });

  it('skips oversized files', () => {
    // Write a file larger than the limit
    fs.writeFileSync(path.join(dir, 'big.ts'), 'x'.repeat(2000));
    fs.writeFileSync(path.join(dir, 'small.ts'), 'const x = 1;');

    const matcher = buildIgnoreMatcher(dir);
    const files = scanDirectory(dir, matcher, {
      maxFileSize: 1000, // 1KB limit
      minifiedLineLength: 500,
      languages: {},
    });

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('small.ts');
  });

  it('discovers files in subdirectories', () => {
    fs.mkdirSync(path.join(dir, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {};');
    fs.writeFileSync(path.join(dir, 'src', 'utils', 'helpers.ts'), 'export {};');

    const matcher = buildIgnoreMatcher(dir);
    const files = scanDirectory(dir, matcher, {
      maxFileSize: 1_048_576,
      minifiedLineLength: 500,
      languages: {},
    });

    const paths = files.map(f => f.path).sort();
    expect(paths).toEqual(['src/index.ts', 'src/utils/helpers.ts']);
  });

  it('returns correct mtime and size', () => {
    const content = 'export const x = 42;';
    const filePath = path.join(dir, 'index.ts');
    fs.writeFileSync(filePath, content);

    const matcher = buildIgnoreMatcher(dir);
    const files = scanDirectory(dir, matcher, {
      maxFileSize: 1_048_576,
      minifiedLineLength: 500,
      languages: {},
    });

    expect(files).toHaveLength(1);
    expect(files[0].size).toBe(Buffer.byteLength(content));
    expect(files[0].mtime).toBeGreaterThan(0);
  });

  it('uses extra extensions in scan', () => {
    fs.writeFileSync(path.join(dir, 'schema.prisma'), 'model User {}');

    const matcher = buildIgnoreMatcher(dir);
    const files = scanDirectory(dir, matcher, {
      maxFileSize: 1_048_576,
      minifiedLineLength: 500,
      languages: { prisma: { extensions: ['.prisma'] } },
    });

    expect(files).toHaveLength(1);
    expect(files[0].language).toBe('prisma');
  });
});

// ── Changes ────────────────────────────────────────────────────────────

describe('Changes', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmrf(dir); });

  it('hashFile computes SHA-256', () => {
    const filePath = path.join(dir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world');
    const hash = hashFile(filePath);
    expect(hash).toHaveLength(64);
    // Same content = same hash
    const hash2 = hashFile(filePath);
    expect(hash).toBe(hash2);
  });

  it('detects new files as added', () => {
    const scanned: ScannedFile[] = [
      { path: 'src/index.ts', absolutePath: path.join(dir, 'src/index.ts'), language: 'typescript', mtime: 1000, size: 100 },
    ];
    // Write the file so hashFile works
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/index.ts'), 'export const x = 1;');
    scanned[0].size = fs.statSync(path.join(dir, 'src/index.ts')).size;

    const changes = detectChanges(scanned, [], true);
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('add');
    expect(changes[0].hash).toBeDefined();
  });

  it('detects deleted files', () => {
    const dbFiles: (FileRow & { id: number })[] = [
      { id: 1, path: 'old.ts', path_key: 'old.ts', hash: 'abc', mtime: 1000, size: 50, language: 'typescript', status: 'indexed', indexed_at: '2026-01-01T00:00:00Z' },
    ];

    const changes = detectChanges([], dbFiles, true);
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('delete');
    expect(changes[0].dbRow!.id).toBe(1);
  });

  it('skips unchanged files (mtime + size match)', () => {
    const scanned: ScannedFile[] = [
      { path: 'index.ts', absolutePath: '/tmp/index.ts', language: 'typescript', mtime: 1000, size: 100 },
    ];
    const dbFiles: (FileRow & { id: number })[] = [
      { id: 1, path: 'index.ts', path_key: 'index.ts', hash: 'abc', mtime: 1000, size: 100, language: 'typescript', status: 'indexed', indexed_at: '2026-01-01T00:00:00Z' },
    ];

    const changes = detectChanges(scanned, dbFiles, true);
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('unchanged');
  });

  it('detects updated files (content changed)', () => {
    const filePath = path.join(dir, 'index.ts');
    fs.writeFileSync(filePath, 'export const x = 2;');
    const stat = fs.statSync(filePath);
    const newHash = hashFile(filePath);

    const scanned: ScannedFile[] = [
      { path: 'index.ts', absolutePath: filePath, language: 'typescript', mtime: stat.mtimeMs, size: stat.size },
    ];
    const dbFiles: (FileRow & { id: number })[] = [
      { id: 1, path: 'index.ts', path_key: 'index.ts', hash: 'old-hash', mtime: 999, size: 50, language: 'typescript', status: 'indexed', indexed_at: '2026-01-01T00:00:00Z' },
    ];

    const changes = detectChanges(scanned, dbFiles, true);
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('update');
    expect(changes[0].hash).toBe(newHash);
  });

  it('detects hash_only when content unchanged but mtime differs', () => {
    const filePath = path.join(dir, 'index.ts');
    fs.writeFileSync(filePath, 'export const x = 1;');
    const hash = hashFile(filePath);
    const stat = fs.statSync(filePath);

    const scanned: ScannedFile[] = [
      { path: 'index.ts', absolutePath: filePath, language: 'typescript', mtime: stat.mtimeMs, size: stat.size },
    ];
    const dbFiles: (FileRow & { id: number })[] = [
      { id: 1, path: 'index.ts', path_key: 'index.ts', hash, mtime: 999, size: stat.size, language: 'typescript', status: 'indexed', indexed_at: '2026-01-01T00:00:00Z' },
    ];

    const changes = detectChanges(scanned, dbFiles, true);
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('hash_only');
  });

  it('uses case-insensitive keys when caseSensitive=false', () => {
    const filePath = path.join(dir, 'Index.ts');
    fs.writeFileSync(filePath, 'export const x = 1;');

    const scanned: ScannedFile[] = [
      { path: 'Index.ts', absolutePath: filePath, language: 'typescript', mtime: 1000, size: 100 },
    ];
    const dbFiles: (FileRow & { id: number })[] = [
      { id: 1, path: 'index.ts', path_key: 'index.ts', hash: 'abc', mtime: 1000, size: 100, language: 'typescript', status: 'indexed', indexed_at: '2026-01-01T00:00:00Z' },
    ];

    // Case-insensitive: Index.ts matches index.ts
    const changes = detectChanges(scanned, dbFiles, false);
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('unchanged');
  });

  it('summarizeChanges returns correct counts', () => {
    const changes = [
      { file: null, dbRow: null, action: 'add' as const },
      { file: null, dbRow: null, action: 'add' as const },
      { file: null, dbRow: null, action: 'update' as const },
      { file: null, dbRow: null, action: 'delete' as const },
      { file: null, dbRow: null, action: 'unchanged' as const },
      { file: null, dbRow: null, action: 'unchanged' as const },
      { file: null, dbRow: null, action: 'hash_only' as const },
    ];
    const summary = summarizeChanges(changes);
    expect(summary).toEqual({
      added: 2,
      updated: 1,
      deleted: 1,
      hashOnly: 1,
      unchanged: 2,
    });
  });
});
