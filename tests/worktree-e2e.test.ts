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
  const d = path.join(os.tmpdir(), `nexus-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('end-to-end worktree pipeline', () => {
  let parent: string;
  beforeEach(() => { parent = tmpDir(); });
  afterEach(() => { rmrf(parent); });

  it('parent build → create worktree → SessionStart-equivalent → query reflects worktree changes', () => {
    // ── Parent setup ─────────────────────────────────────────────────
    git(parent, ['init', '-q', '-b', 'main']);
    git(parent, ['config', 'user.email', 'test@nexus.local']);
    git(parent, ['config', 'user.name', 'Nexus Test']);
    git(parent, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(parent, 'core.ts'), 'export const core = 1;\nexport function publicAPI() { return core; }\n');
    fs.writeFileSync(path.join(parent, 'helper.ts'), 'export const helper = 2;\n');
    fs.writeFileSync(path.join(parent, 'untouched.ts'), 'export const untouched = 3;\n');
    git(parent, ['add', '-A']);
    git(parent, ['commit', '-q', '-m', 'init']);

    runIndex(parent); // build parent index

    // ── Worktree creation + edits across all 4 diff sources ──────────
    const wtPath = path.join(parent, 'wt');
    git(parent, ['worktree', 'add', wtPath, '-b', 'feat/end-to-end']);

    // committed: rename publicAPI → renamedAPI
    fs.writeFileSync(path.join(wtPath, 'core.ts'), 'export const core = 1;\nexport function renamedAPI() { return core; }\n');
    git(wtPath, ['add', '-A']);
    git(wtPath, ['commit', '-q', '-m', 'rename API']);

    // staged: add a new file
    fs.writeFileSync(path.join(wtPath, 'staged.ts'), 'export const stagedSym = 10;\n');
    git(wtPath, ['add', 'staged.ts']);

    // unstaged: edit helper.ts
    fs.writeFileSync(path.join(wtPath, 'helper.ts'), 'export const helper = 22;\n');

    // untracked: new file not yet added
    fs.writeFileSync(path.join(wtPath, 'untracked.ts'), 'export const untrackedSym = 99;\n');

    // ── SessionStart-equivalent build ────────────────────────────────
    const info = detectWorkspace(wtPath);
    expect(info.mode).toBe('worktree');
    if (info.mode !== 'worktree') return;
    const wtInfo = info as WorktreeWorkspaceInfo;

    const outcome = buildWorktreeIndex(wtInfo);
    expect(outcome.kind).toBe('overlay');
    expect(fs.existsSync(wtInfo.overlayPath)).toBe(true);

    // ── Open merged engine and verify queries ────────────────────────
    const db = openDatabase(wtInfo.baseIndexPath, { readonly: true });
    const store = new NexusStore(db);
    store.attachOverlay(wtInfo.overlayPath);
    const engine = new QueryEngine(db, { sourceRoot: wtInfo.sourceRoot });

    try {
      // Renamed: old publicAPI gone, renamedAPI present.
      expect(engine.find('publicAPI').results).toHaveLength(0);
      const renamed = engine.find('renamedAPI');
      expect(renamed.results.length).toBeGreaterThan(0);
      expect(renamed.results[0].file).toBe('core.ts');

      // Staged-add: stagedSym findable.
      const staged = engine.find('stagedSym');
      expect(staged.results.length).toBeGreaterThan(0);
      expect(staged.results[0].file).toBe('staged.ts');

      // Untracked-add: untrackedSym findable.
      const untracked = engine.find('untrackedSym');
      expect(untracked.results.length).toBeGreaterThan(0);
      expect(untracked.results[0].file).toBe('untracked.ts');

      // Unchanged file: untouched still comes from parent.
      const u = engine.find('untouched');
      expect(u.results.length).toBeGreaterThan(0);
      expect(u.results[0].file).toBe('untouched.ts');

      // Source reads for an overlay-modified file resolve under the worktree
      // root (sourceRoot override), not the parent root.
      const src = engine.source('renamedAPI', 'core.ts');
      expect(src.results.length).toBeGreaterThan(0);
      expect(src.results[0].source).toContain('renamedAPI');
    } finally {
      store.detachOverlay();
      db.close();
    }
  });

  it('non-worktree projects are unaffected (regression check)', () => {
    git(parent, ['init', '-q', '-b', 'main']);
    git(parent, ['config', 'user.email', 'test@nexus.local']);
    git(parent, ['config', 'user.name', 'Nexus Test']);
    git(parent, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(parent, 'a.ts'), 'export const a = 1;\n');
    git(parent, ['add', '-A']);
    git(parent, ['commit', '-q', '-m', 'init']);

    const info = detectWorkspace(parent);
    expect(info.mode).toBe('main');

    const result = runIndex(parent);
    expect(result.mode).toBe('full');

    // No overlay file should exist for a main checkout.
    const overlayPath = path.join(parent, '.nexus', 'overlay.db');
    expect(fs.existsSync(overlayPath)).toBe(false);

    // Engine works as before, no overlay attached.
    const db = openDatabase(path.join(parent, '.nexus', 'index.db'));
    const engine = new QueryEngine(db);
    try {
      expect(engine.find('a').results.length).toBeGreaterThan(0);
    } finally { db.close(); }
  });
});
