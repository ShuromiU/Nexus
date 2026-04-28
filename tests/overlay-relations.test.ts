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

import '../src/analysis/languages/typescript.js';

function tmpDir(): string {
  const d = path.join(os.tmpdir(), `nexus-rel-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

/**
 * Set up a parent repo with a class hierarchy already indexed:
 *   base.ts:   class Base
 *   mid.ts:    class Mid extends Base   (cross-file extends)
 *   leaf.ts:   class Leaf extends Mid    (cross-file extends)
 *   iface.ts:  interface IUser
 *   impl.ts:   class U implements IUser  (cross-file implements)
 * Returns the worktree info attached to a fresh `feat` branch.
 */
function setupParentAndWorktree(parent: string): WorktreeWorkspaceInfo {
  git(parent, ['init', '-q', '-b', 'main']);
  git(parent, ['config', 'user.email', 'test@nexus.local']);
  git(parent, ['config', 'user.name', 'Nexus Test']);
  git(parent, ['config', 'commit.gpgsign', 'false']);

  fs.writeFileSync(path.join(parent, 'base.ts'), 'export class Base {}\n');
  fs.writeFileSync(
    path.join(parent, 'mid.ts'),
    "import { Base } from './base';\nexport class Mid extends Base {}\n",
  );
  fs.writeFileSync(
    path.join(parent, 'leaf.ts'),
    "import { Mid } from './mid';\nexport class Leaf extends Mid {}\n",
  );
  fs.writeFileSync(path.join(parent, 'iface.ts'), 'export interface IUser {}\n');
  fs.writeFileSync(
    path.join(parent, 'impl.ts'),
    "import { IUser } from './iface';\nexport class U implements IUser {}\n",
  );

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

describe('attachOverlay merged relation_edges (T12)', () => {
  let parent: string;
  beforeEach(() => { parent = tmpDir(); });
  afterEach(() => { rmrf(parent); });

  it('parent-only relations remain queryable when the overlay is empty (no changes)', () => {
    const info = setupParentAndWorktree(parent);
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const { engine, close } = openMergedEngine(info);
    try {
      const r = engine.relations('Leaf', { direction: 'parents' });
      const inner = r.results[0];
      expect(inner.count).toBe(1);
      expect(inner.results[0].kind).toBe('extends_class');
      expect(inner.results[0].target.name).toBe('Mid');
      expect(inner.results[0].target.resolved).toBe(true);
      expect(inner.results[0].target.file).toBe('mid.ts');
    } finally { close(); }
  });

  it('overlay-added class targeting a parent symbol resolves cross-boundary', () => {
    const info = setupParentAndWorktree(parent);
    // New file in worktree: extends a parent class via cross-file import.
    fs.writeFileSync(
      path.join(info.root, 'sub.ts'),
      "import { Base } from './base';\nexport class Sub extends Base {}\n",
    );
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const { engine, close } = openMergedEngine(info);
    try {
      const parents = engine.relations('Sub', { direction: 'parents' });
      const inner = parents.results[0];
      expect(inner.count).toBe(1);
      expect(inner.results[0].kind).toBe('extends_class');
      expect(inner.results[0].target.name).toBe('Base');
      // The merged view should resolve the target through main.symbols/files
      // because base.ts is unchanged in the overlay.
      expect(inner.results[0].target.resolved).toBe(true);
      expect(inner.results[0].target.file).toBe('base.ts');
    } finally { close(); }
  });

  it('children direction sees overlay-added subclasses of a parent symbol', () => {
    const info = setupParentAndWorktree(parent);
    fs.writeFileSync(
      path.join(info.root, 'sub.ts'),
      "import { Base } from './base';\nexport class Sub extends Base {}\n",
    );
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const { engine, close } = openMergedEngine(info);
    try {
      const r = engine.relations('Base', { direction: 'children' });
      const inner = r.results[0];
      // Mid (parent) + Sub (overlay) = 2
      const sources = inner.results.map(x => x.source.name).sort();
      expect(sources).toEqual(['Mid', 'Sub']);
    } finally { close(); }
  });

  it('overlay-modified file replaces its parent relation rows (no duplicates)', () => {
    const info = setupParentAndWorktree(parent);
    // Rewrite mid.ts: rename Mid → Mid2, still extending Base.
    fs.writeFileSync(
      path.join(info.root, 'mid.ts'),
      "import { Base } from './base';\nexport class Mid2 extends Base {}\n",
    );
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const { engine, close } = openMergedEngine(info);
    try {
      // Mid (parent's symbol) is masked because mid.ts is in changed_or_deleted.
      expect(engine.relations('Mid', { direction: 'parents' }).results[0].count).toBe(0);

      // Mid2 (overlay's new symbol) extends Base via cross-file resolution.
      const r = engine.relations('Mid2', { direction: 'parents' });
      const inner = r.results[0];
      expect(inner.count).toBe(1);
      expect(inner.results[0].target.name).toBe('Base');
      expect(inner.results[0].target.resolved).toBe(true);
      expect(inner.results[0].target.file).toBe('base.ts');
    } finally { close(); }
  });

  it('overlay-deleted target hides parent relation rows pointing to it', () => {
    const info = setupParentAndWorktree(parent);
    // Delete base.ts in the worktree. Mid extended Base in the parent index;
    // after deletion, Mid's outgoing extends_class edge must report unresolved.
    fs.unlinkSync(path.join(info.root, 'base.ts'));
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const { engine, close } = openMergedEngine(info);
    try {
      const r = engine.relations('Mid', { direction: 'parents' });
      const inner = r.results[0];
      expect(inner.count).toBe(1);
      expect(inner.results[0].target.name).toBe('Base');
      expect(inner.results[0].target.resolved).toBe(false);
    } finally { close(); }
  });

  it('overlay-added same-file relation resolves locally', () => {
    const info = setupParentAndWorktree(parent);
    // Single overlay file with a within-file class hierarchy.
    fs.writeFileSync(
      path.join(info.root, 'local.ts'),
      'export class Animal {}\n' +
      'export class Dog extends Animal {}\n',
    );
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const { engine, close } = openMergedEngine(info);
    try {
      const r = engine.relations('Dog', { direction: 'parents' });
      const inner = r.results[0];
      expect(inner.count).toBe(1);
      expect(inner.results[0].target.name).toBe('Animal');
      expect(inner.results[0].target.resolved).toBe(true);
      expect(inner.results[0].target.file).toBe('local.ts');
    } finally { close(); }
  });

  it('implements edge across overlay→parent boundary', () => {
    const info = setupParentAndWorktree(parent);
    fs.writeFileSync(
      path.join(info.root, 'impl2.ts'),
      "import { IUser } from './iface';\nexport class U2 implements IUser {}\n",
    );
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const { engine, close } = openMergedEngine(info);
    try {
      const r = engine.relations('U2', { direction: 'parents' });
      const inner = r.results[0];
      expect(inner.count).toBe(1);
      expect(inner.results[0].kind).toBe('implements');
      expect(inner.results[0].target.name).toBe('IUser');
      expect(inner.results[0].target.resolved).toBe(true);
      expect(inner.results[0].target.file).toBe('iface.ts');

      // From the parent side: IUser's children now include both U (parent) and U2 (overlay).
      const ch = engine.relations('IUser', { direction: 'children' });
      const sources = ch.results[0].results.map(x => x.source.name).sort();
      expect(sources).toEqual(['U', 'U2']);
    } finally { close(); }
  });

  it('depth=2 walks parents through overlay→parent transitively', () => {
    const info = setupParentAndWorktree(parent);
    // Sub extends parent's Mid; depth 2 should reach Base.
    fs.writeFileSync(
      path.join(info.root, 'sub.ts'),
      "import { Mid } from './mid';\nexport class Sub extends Mid {}\n",
    );
    const outcome = buildWorktreeIndex(info);
    expect(outcome.kind).toBe('overlay');

    const { engine, close } = openMergedEngine(info);
    try {
      const r = engine.relations('Sub', { direction: 'parents', depth: 2 });
      const inner = r.results[0];
      const targets = inner.results.map(x => x.target.name).sort();
      expect(targets).toEqual(['Base', 'Mid']);
    } finally { close(); }
  });
});
