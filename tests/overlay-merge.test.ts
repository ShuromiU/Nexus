import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runIndex } from '../src/index/orchestrator.js';
import { buildWorktreeIndex } from '../src/index/overlay-orchestrator.js';
import { detectWorkspace, type WorktreeWorkspaceInfo } from '../src/workspace/detector.js';
import { openDatabase } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import { QueryEngine } from '../src/query/engine.js';

function tmpDir(): string {
  const d = path.join(os.tmpdir(), `nexus-merge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function setupParentAndWorktree(parent: string): WorktreeWorkspaceInfo {
  git(parent, ['init', '-q', '-b', 'main']);
  git(parent, ['config', 'user.email', 'test@nexus.local']);
  git(parent, ['config', 'user.name', 'Nexus Test']);
  git(parent, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(parent, 'README.md'), '# test\n');
  fs.writeFileSync(path.join(parent, 'a.ts'), 'export const fromA = 1;\nexport function helperA() { return fromA; }\n');
  fs.writeFileSync(path.join(parent, 'b.ts'), 'export const fromB = 2;\n');
  fs.writeFileSync(path.join(parent, 'unchanged.ts'), 'export const u = 3;\n');
  git(parent, ['add', '-A']);
  git(parent, ['commit', '-q', '-m', 'init']);
  runIndex(parent);

  const wtPath = path.join(parent, 'wt');
  git(parent, ['worktree', 'add', wtPath, '-b', 'feat']);
  const info = detectWorkspace(wtPath);
  if (info.mode !== 'worktree') throw new Error('expected worktree mode');
  return info;
}

function openMergedEngine(info: WorktreeWorkspaceInfo): { engine: QueryEngine; close(): void } {
  const db = openDatabase(info.baseIndexPath, { readonly: true });
  const store = new NexusStore(db);
  store.attachOverlay(info.overlayPath);
  const engine = new QueryEngine(db, { sourceRoot: info.sourceRoot });
  return { engine, close: () => { try { store.detachOverlay(); } catch { /* ignore */ } db.close(); } };
}

describe('attachOverlay merged TEMP views', () => {
  let parent: string;
  beforeEach(() => { parent = tmpDir(); });
  afterEach(() => { rmrf(parent); });

  it('overlay-modified file replaces parent rows; unchanged files remain', () => {
    const info = setupParentAndWorktree(parent);

    // Modify a.ts in the worktree: replace helperA with helperA2.
    fs.writeFileSync(
      path.join(info.root, 'a.ts'),
      'export const fromA = 1;\nexport function helperA2() { return fromA; }\n',
    );
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const { engine, close } = openMergedEngine(info);
    try {
      // helperA (parent's name) should NOT be findable — its file is in
      // changed_or_deleted, so parent.symbols rows for a.ts are masked out.
      const old = engine.find('helperA');
      expect(old.results).toHaveLength(0);

      // helperA2 (overlay's new symbol) IS findable.
      const renamed = engine.find('helperA2');
      expect(renamed.results.length).toBeGreaterThan(0);
      expect(renamed.results[0].file).toBe('a.ts');

      // unchanged.ts symbols still come from the parent index.
      const unchanged = engine.find('u');
      expect(unchanged.results.length).toBeGreaterThan(0);
      expect(unchanged.results[0].file).toBe('unchanged.ts');
    } finally { close(); }
  });

  it('overlay-added file shows up under search and outline', () => {
    const info = setupParentAndWorktree(parent);
    fs.writeFileSync(path.join(info.root, 'c.ts'), 'export const newSym = 100;\n');
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const { engine, close } = openMergedEngine(info);
    try {
      const found = engine.find('newSym');
      expect(found.results.length).toBeGreaterThan(0);
      expect(found.results[0].file).toBe('c.ts');

      const outline = engine.outline('c.ts');
      expect(outline.results.length).toBeGreaterThan(0);
    } finally { close(); }
  });

  it('overlay-deleted file is removed from results (parent rows hidden)', () => {
    const info = setupParentAndWorktree(parent);
    fs.unlinkSync(path.join(info.root, 'b.ts'));
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const { engine, close } = openMergedEngine(info);
    try {
      const found = engine.find('fromB');
      expect(found.results).toHaveLength(0);
    } finally { close(); }
  });

  it('nexus_stats merged view reports overlay metadata (index_mode, parent_git_head)', () => {
    const info = setupParentAndWorktree(parent);
    fs.writeFileSync(path.join(info.root, 'a.ts'), 'export const fromA = 999;\n');
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    // Direct meta read through the merged view (mirrors what nexus_stats does).
    const { engine: _engine, close } = openMergedEngine(info);
    try {
      // Re-open to peek at meta directly (engine.stats() may not expose all keys)
      const db = openDatabase(info.baseIndexPath, { readonly: true });
      const store = new NexusStore(db);
      store.attachOverlay(info.overlayPath);
      try {
        const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
        const map = new Map(rows.map((r) => [r.key, r.value]));
        expect(map.get('index_mode')).toBe('overlay-on-parent');
        expect(map.get('parent_git_head')).toMatch(/^[0-9a-f]{40}$/);
        expect(map.get('parent_index_path')).toBe(info.baseIndexPath);
      } finally {
        store.detachOverlay();
        db.close();
      }
    } finally { close(); }
  });

  it('detachOverlay restores parent-only view (re-attach is idempotent)', () => {
    const info = setupParentAndWorktree(parent);
    fs.writeFileSync(path.join(info.root, 'c.ts'), 'export const onlyOverlay = 1;\n');
    buildWorktreeIndex(info);

    const db = openDatabase(info.baseIndexPath, { readonly: true });
    const store = new NexusStore(db);

    store.attachOverlay(info.overlayPath);
    const withOverlay = db.prepare("SELECT COUNT(*) as n FROM files").get() as { n: number };

    store.detachOverlay();
    const withoutOverlay = db.prepare("SELECT COUNT(*) as n FROM files").get() as { n: number };

    // Detach drops the temp view → unqualified `files` resolves to main.files,
    // which was the parent's pre-overlay file count.
    expect(withOverlay.n).toBeGreaterThan(withoutOverlay.n);

    // Re-attach is idempotent.
    store.attachOverlay(info.overlayPath);
    store.attachOverlay(info.overlayPath);

    db.close();
  });
});
