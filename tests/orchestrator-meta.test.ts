import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { runIndex } from '../src/index/orchestrator.js';

function tmpDir(): string {
  const d = path.join(os.tmpdir(), `nexus-orch-meta-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('runIndex — base-compat metadata', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmrf(dir); });

  it('writes clean_at_index_time=true for an untouched repo', () => {
    initRepo(dir);
    runIndex(dir);
    const meta = readMeta(path.join(dir, '.nexus', 'index.db'));
    expect(meta.clean_at_index_time).toBe('true');
    expect(meta.index_mode).toBe('full');
    expect(meta.git_head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('writes clean_at_index_time=true even when only .nexus/ artifacts exist', () => {
    // .nexus/ is created by runIndex itself; ensure that doesn't dirty the
    // recorded clean flag (we ignore that path prefix in gitStatusClean).
    initRepo(dir);
    fs.mkdirSync(path.join(dir, '.nexus'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.nexus', 'leftover'), 'stale');
    runIndex(dir);
    const meta = readMeta(path.join(dir, '.nexus', 'index.db'));
    expect(meta.clean_at_index_time).toBe('true');
  });

  it('writes clean_at_index_time=false when there are unstaged changes', () => {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
    runIndex(dir);
    const meta = readMeta(path.join(dir, '.nexus', 'index.db'));
    expect(meta.clean_at_index_time).toBe('false');
  });

  it('writes clean_at_index_time=false when .nexus.json is staged but not committed', () => {
    // .nexus.json is real user config — must count as dirty even though .nexus/ is ignored.
    initRepo(dir);
    fs.writeFileSync(path.join(dir, '.nexus.json'), '{}\n');
    git(dir, ['add', '.nexus.json']);
    runIndex(dir);
    const meta = readMeta(path.join(dir, '.nexus', 'index.db'));
    expect(meta.clean_at_index_time).toBe('false');
  });

  it('refreshes git_head on incremental rebuild', () => {
    initRepo(dir);
    runIndex(dir);
    const headBefore = readMeta(path.join(dir, '.nexus', 'index.db')).git_head;

    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'add b']);
    runIndex(dir); // incremental
    const headAfter = readMeta(path.join(dir, '.nexus', 'index.db')).git_head;

    expect(headBefore).toMatch(/^[0-9a-f]{40}$/);
    expect(headAfter).toMatch(/^[0-9a-f]{40}$/);
    expect(headAfter).not.toBe(headBefore);
  });
});
