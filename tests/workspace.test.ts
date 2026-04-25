import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig, computeConfigHash } from '../src/config.js';
import { spawnSync } from 'node:child_process';
import {
  detectRoot,
  detectWorkspace,
  detectCaseSensitivity,
  getGitHead,
  resolveRoot,
  gitHead,
  gitStatusClean,
  gitDiffNameStatus,
  gitDiffStaged,
  gitDiffUnstaged,
  gitLsFilesUntracked,
  gitMergeBaseIsAncestor,
} from '../src/workspace/detector.js';
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

  it('getGitHead returns the HEAD commit hash for a real git repo', () => {
    initGitRepo(dir);
    const head = getGitHead(dir);
    expect(head).not.toBeNull();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });
});

// Helper: initialize a real git repo at `dir` with one commit. Required for
// the new shell-based git helpers (the previous fs-based implementation
// could fake .git contents; the shell version requires a real repo).
function initGitRepo(dir: string): void {
  const opts = { cwd: dir, encoding: 'utf-8' as const, windowsHide: true };
  spawnSync('git', ['init', '-q', '-b', 'main'], opts);
  spawnSync('git', ['config', 'user.email', 'test@nexus.local'], opts);
  spawnSync('git', ['config', 'user.name', 'Nexus Test'], opts);
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], opts);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  spawnSync('git', ['add', 'README.md'], opts);
  spawnSync('git', ['commit', '-q', '-m', 'init'], opts);
}

function gitOk(dir: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? r.stdout ?? ''}`);
  }
}

// ── detectWorkspace ────────────────────────────────────────────────────

describe('detectWorkspace', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmrf(dir); });

  it('returns standalone for a dir with no markers', () => {
    const deep = path.join(dir, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    const info = detectWorkspace(deep);
    expect(info.mode).toBe('standalone');
    expect(info.root).toBe(deep);
  });

  it('returns standalone rooted at .nexus.json marker', () => {
    fs.writeFileSync(path.join(dir, '.nexus.json'), '{}');
    const sub = path.join(dir, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const info = detectWorkspace(sub);
    expect(info.mode).toBe('standalone');
    expect(info.root).toBe(dir);
  });

  it('returns main mode for a real git repo (.git is a directory)', () => {
    initGitRepo(dir);
    const info = detectWorkspace(dir);
    expect(info.mode).toBe('main');
    expect(info.root).toBe(dir);
    if (info.mode === 'main') {
      expect(info.gitDir).toBe(path.join(dir, '.git'));
    }
  });

  it('prefers nearer .nexus.json over a parent .git (existing semantics)', () => {
    initGitRepo(dir);
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, '.nexus.json'), '{}');
    const info = detectWorkspace(path.join(sub));
    expect(info.mode).toBe('standalone');
    expect(info.root).toBe(sub);
  });

  it('when both .git and .nexus.json exist at the same dir, .git wins', () => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, '.nexus.json'), '{}');
    const info = detectWorkspace(dir);
    expect(info.mode).toBe('main');
  });

  it('detects worktree mode and resolves parentRoot via gitdir/commondir', () => {
    initGitRepo(dir);
    // Create a worktree: git worktree add <wt> -b feature/test
    const wt = path.join(dir, 'wt-test');
    gitOk(dir, ['worktree', 'add', wt, '-b', 'feature/test']);

    const info = detectWorkspace(wt);
    expect(info.mode).toBe('worktree');
    if (info.mode === 'worktree') {
      // parentRoot should resolve back to the main checkout dir.
      // Compare via realpath to handle Windows short/long path quirks.
      expect(fs.realpathSync(info.parentRoot)).toBe(fs.realpathSync(dir));
      expect(info.root).toBe(wt);
      expect(info.sourceRoot).toBe(wt);
      expect(info.baseIndexPath).toBe(path.join(info.parentRoot, '.nexus', 'index.db'));
      expect(info.overlayPath).toBe(path.join(wt, '.nexus', 'overlay.db'));
    }
  });
});

// ── resolveRoot ────────────────────────────────────────────────────────

describe('resolveRoot', () => {
  let savedNexus: string | undefined;
  let savedClaude: string | undefined;

  beforeEach(() => {
    savedNexus = process.env.NEXUS_ROOT;
    savedClaude = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.NEXUS_ROOT;
    delete process.env.CLAUDE_PROJECT_DIR;
  });
  afterEach(() => {
    if (savedNexus === undefined) delete process.env.NEXUS_ROOT;
    else process.env.NEXUS_ROOT = savedNexus;
    if (savedClaude === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedClaude;
  });

  it('--root arg wins highest priority', () => {
    process.env.NEXUS_ROOT = '/env/nexus';
    process.env.CLAUDE_PROJECT_DIR = '/env/claude';
    const r = resolveRoot({ rootArg: '/from/arg', mcpRoots: ['/from/mcp'] });
    expect(r.source).toBe('arg');
    expect(r.startDir).toBe(path.resolve('/from/arg'));
  });

  it('NEXUS_ROOT beats CLAUDE_PROJECT_DIR and MCP roots', () => {
    process.env.NEXUS_ROOT = '/env/nexus';
    process.env.CLAUDE_PROJECT_DIR = '/env/claude';
    const r = resolveRoot({ mcpRoots: ['/from/mcp'] });
    expect(r.source).toBe('env-nexus');
    expect(r.startDir).toBe(path.resolve('/env/nexus'));
  });

  it('CLAUDE_PROJECT_DIR beats MCP roots', () => {
    process.env.CLAUDE_PROJECT_DIR = '/env/claude';
    const r = resolveRoot({ mcpRoots: ['/from/mcp'] });
    expect(r.source).toBe('env-claude');
    expect(r.startDir).toBe(path.resolve('/env/claude'));
  });

  it('MCP roots beat cwd fallback', () => {
    const r = resolveRoot({ mcpRoots: ['/from/mcp'] });
    expect(r.source).toBe('mcp-roots');
    expect(r.startDir).toBe(path.resolve('/from/mcp'));
  });

  it('falls back to process.cwd()', () => {
    const r = resolveRoot();
    expect(r.source).toBe('cwd');
    expect(r.startDir).toBe(process.cwd());
  });
});

// ── Worktree-safe git helpers ──────────────────────────────────────────

describe('Worktree-safe git helpers', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmrf(dir); });

  it('gitHead returns null when not a git repo', () => {
    expect(gitHead(dir)).toBeNull();
  });

  it('gitHead works in a worktree (where .git is a file pointer)', () => {
    initGitRepo(dir);
    const mainHead = gitHead(dir);
    expect(mainHead).toMatch(/^[0-9a-f]{40}$/);

    const wt = path.join(dir, 'wt');
    gitOk(dir, ['worktree', 'add', wt, '-b', 'wt-test']);
    const wtHead = gitHead(wt);
    expect(wtHead).toMatch(/^[0-9a-f]{40}$/);
    // Same commit since the new branch was just created from HEAD.
    expect(wtHead).toBe(mainHead);
  });

  it('gitStatusClean returns true for an untouched repo', () => {
    initGitRepo(dir);
    expect(gitStatusClean(dir, { ignorePaths: ['.nexus/'] })).toBe(true);
  });

  it('gitStatusClean returns false for staged config changes (.nexus.json counts)', () => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, '.nexus.json'), '{}');
    gitOk(dir, ['add', '.nexus.json']);
    expect(gitStatusClean(dir, { ignorePaths: ['.nexus/'] })).toBe(false);
  });

  it('gitStatusClean ignores .nexus/ artifacts', () => {
    initGitRepo(dir);
    fs.mkdirSync(path.join(dir, '.nexus'));
    fs.writeFileSync(path.join(dir, '.nexus', 'index.db'), 'fake');
    expect(gitStatusClean(dir, { ignorePaths: ['.nexus/'] })).toBe(true);
  });

  it('gitDiffUnstaged catches an unstaged edit', () => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const x = 1;\n');
    gitOk(dir, ['add', 'src.ts']);
    gitOk(dir, ['commit', '-q', '-m', 'add src']);

    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const x = 2;\n');
    const changes = gitDiffUnstaged(dir);
    expect(changes).toEqual([{ status: 'M', path: 'src.ts' }]);
  });

  it('gitDiffStaged catches a staged add', () => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'new.ts'), 'export {};\n');
    gitOk(dir, ['add', 'new.ts']);
    const changes = gitDiffStaged(dir);
    expect(changes).toEqual([{ status: 'A', path: 'new.ts' }]);
  });

  it('gitLsFilesUntracked lists untracked files', () => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'untracked.ts'), 'x\n');
    expect(gitLsFilesUntracked(dir)).toEqual(['untracked.ts']);
  });

  it('gitMergeBaseIsAncestor returns true for HEAD ancestor', () => {
    initGitRepo(dir);
    const head1 = gitHead(dir)!;
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 1;\n');
    gitOk(dir, ['add', 'b.ts']);
    gitOk(dir, ['commit', '-q', '-m', 'add b']);
    const head2 = gitHead(dir)!;
    expect(head1).not.toBe(head2);
    expect(gitMergeBaseIsAncestor(dir, head1, head2)).toBe(true);
    expect(gitMergeBaseIsAncestor(dir, head2, head1)).toBe(false);
  });

  it('gitDiffNameStatus computes committed changes between base and HEAD', () => {
    initGitRepo(dir);
    const base = gitHead(dir)!;
    fs.writeFileSync(path.join(dir, 'a.ts'), 'a\n');
    gitOk(dir, ['add', 'a.ts']);
    gitOk(dir, ['commit', '-q', '-m', 'a']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# test\nupdated\n');
    gitOk(dir, ['add', 'README.md']);
    gitOk(dir, ['commit', '-q', '-m', 'update README']);

    const changes = gitDiffNameStatus(dir, base);
    const sorted = [...changes].sort((x, y) => x.path.localeCompare(y.path));
    expect(sorted).toEqual([
      { status: 'A', path: 'a.ts' },
      { status: 'M', path: 'README.md' },
    ]);
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
