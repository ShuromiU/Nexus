import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { runIndex } from '../src/index/orchestrator.js';
import { buildWorktreeIndex } from '../src/index/overlay-orchestrator.js';
import { detectWorkspace } from '../src/workspace/detector.js';

function tmpDir(): string {
  const d = path.join(os.tmpdir(), `nexus-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function rmrf(d: string): void {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

function git(dir: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@nexus.local']);
  git(dir, ['config', 'user.name', 'Nexus Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

function readMeta(dbPath: string): Record<string, string> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }
}

function setupParentAndWorktree(parent: string, wtName: string): { wtPath: string } {
  initRepo(parent);
  runIndex(parent); // build parent index with clean_at_index_time=true
  const wtPath = path.join(parent, wtName);
  git(parent, ['worktree', 'add', wtPath, '-b', 'feat/test']);
  return { wtPath };
}

describe('buildWorktreeIndex — overlay path', () => {
  let parent: string;
  beforeEach(() => { parent = tmpDir(); });
  afterEach(() => { rmrf(parent); });

  it('builds an overlay capturing an unstaged edit (the four-source diff)', () => {
    const { wtPath } = setupParentAndWorktree(parent, 'wt');

    // Make an UNSTAGED edit — this is the case that breaks if we forget
    // unstaged in the diff sources.
    fs.writeFileSync(path.join(wtPath, 'a.ts'), 'export const a = 999;\n');

    const info = detectWorkspace(wtPath);
    expect(info.mode).toBe('worktree');
    if (info.mode !== 'worktree') return;

    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');
    expect(fs.existsSync(info.overlayPath)).toBe(true);

    const meta = readMeta(info.overlayPath);
    expect(meta.index_mode).toBe('overlay-on-parent');
    expect(meta.parent_index_path).toBe(info.baseIndexPath);
    expect(meta.parent_git_head).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.git_head).toMatch(/^[0-9a-f]{40}$/);

    const db = new Database(info.overlayPath, { readonly: true });
    try {
      const files = db.prepare("SELECT path FROM files").all() as { path: string }[];
      expect(files.map((f) => f.path)).toContain('a.ts');
      // b.ts unchanged → MUST NOT be in overlay
      expect(files.map((f) => f.path)).not.toContain('b.ts');
    } finally { db.close(); }
  });

  it('records deleted files in overlay.deleted_files', () => {
    const { wtPath } = setupParentAndWorktree(parent, 'wt');
    fs.unlinkSync(path.join(wtPath, 'b.ts'));

    const info = detectWorkspace(wtPath);
    if (info.mode !== 'worktree') throw new Error('expected worktree');
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const db = new Database(info.overlayPath, { readonly: true });
    try {
      const deleted = db.prepare("SELECT path FROM deleted_files").all() as { path: string }[];
      expect(deleted.map((d) => d.path)).toEqual(['b.ts']);
    } finally { db.close(); }
  });

  it('captures a brand-new (untracked) file', () => {
    const { wtPath } = setupParentAndWorktree(parent, 'wt');
    fs.writeFileSync(path.join(wtPath, 'c.ts'), 'export const c = 3;\n');

    const info = detectWorkspace(wtPath);
    if (info.mode !== 'worktree') throw new Error('expected worktree');
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const db = new Database(info.overlayPath, { readonly: true });
    try {
      const files = db.prepare("SELECT path, language FROM files").all() as { path: string; language: string }[];
      expect(files.find((f) => f.path === 'c.ts')?.language).toBe('typescript');
    } finally { db.close(); }
  });

  it('captures committed-but-not-merged changes via the merge-base diff', () => {
    const { wtPath } = setupParentAndWorktree(parent, 'wt');
    fs.writeFileSync(path.join(wtPath, 'b.ts'), 'export const b = 22;\n');
    git(wtPath, ['add', '-A']);
    git(wtPath, ['commit', '-q', '-m', 'tweak b in worktree branch']);

    const info = detectWorkspace(wtPath);
    if (info.mode !== 'worktree') throw new Error('expected worktree');
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const db = new Database(info.overlayPath, { readonly: true });
    try {
      const files = db.prepare("SELECT path FROM files").all() as { path: string }[];
      expect(files.map((f) => f.path)).toContain('b.ts');
    } finally { db.close(); }
  });
});

describe('buildWorktreeIndex — compat gates fall back to worktree-isolated', () => {
  let parent: string;
  beforeEach(() => { parent = tmpDir(); });
  afterEach(() => { rmrf(parent); });

  it('parent_dirty_at_index_time → fallback', () => {
    initRepo(parent);
    // Reindex parent while it is DIRTY → meta.clean_at_index_time = 'false'.
    fs.writeFileSync(path.join(parent, 'a.ts'), 'export const a = 99;\n');
    runIndex(parent);

    const wtPath = path.join(parent, 'wt');
    git(parent, ['worktree', 'add', wtPath, '-b', 'feat/test']);

    const info = detectWorkspace(wtPath);
    if (info.mode !== 'worktree') throw new Error('expected worktree');
    const outcome = buildWorktreeIndex(info);

    expect(outcome.kind).toBe('isolated');
    if (outcome.kind === 'isolated') {
      expect(outcome.reason).toBe('parent_dirty_at_index_time');
    }
    // Isolated index lives at <worktree>/.nexus/index.db.
    const isoMeta = readMeta(path.join(wtPath, '.nexus', 'index.db'));
    expect(isoMeta.index_mode).toBe('worktree-isolated');
    expect(isoMeta.degraded_reason).toBe('parent_dirty_at_index_time');
    // Overlay file MUST NOT exist after fallback.
    expect(fs.existsSync(info.overlayPath)).toBe(false);
  });

  it('parent_index_missing → fallback', () => {
    initRepo(parent);
    // Note: NO runIndex(parent) — parent has no .nexus/index.db.
    const wtPath = path.join(parent, 'wt');
    git(parent, ['worktree', 'add', wtPath, '-b', 'feat/test']);

    const info = detectWorkspace(wtPath);
    if (info.mode !== 'worktree') throw new Error('expected worktree');
    const outcome = buildWorktreeIndex(info);

    expect(outcome.kind).toBe('isolated');
    if (outcome.kind === 'isolated') {
      expect(outcome.reason).toBe('parent_index_missing');
    }
  });

  it('config_diverged (.nexus.json changed in worktree) → fallback', () => {
    const { wtPath } = setupParentAndWorktree(parent, 'wt');
    fs.writeFileSync(path.join(wtPath, '.nexus.json'), '{}\n');

    const info = detectWorkspace(wtPath);
    // Note: now wtPath has .nexus.json AND the .git pointer file. Per the
    // detector rule, .git wins at the same dir → still worktree mode.
    expect(info.mode).toBe('worktree');
    if (info.mode !== 'worktree') return;

    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('isolated');
    if (outcome.kind === 'isolated') {
      expect(outcome.reason).toBe('config_diverged');
    }
  });

  it('too_many_changes → fallback (cap at MAX_OVERLAY_FILES)', async () => {
    const { wtPath } = setupParentAndWorktree(parent, 'wt');
    // Write more files than the default cap (500).
    for (let i = 0; i < 510; i++) {
      fs.writeFileSync(path.join(wtPath, `gen${i}.ts`), `export const g${i} = ${i};\n`);
    }

    const info = detectWorkspace(wtPath);
    if (info.mode !== 'worktree') throw new Error('expected worktree');
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('isolated');
    if (outcome.kind === 'isolated') {
      expect(outcome.reason).toBe('too_many_changes');
    }
  });
});
