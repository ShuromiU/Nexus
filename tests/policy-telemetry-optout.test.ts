import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { recordOptOutTransition } from '../src/policy/telemetry.js';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-optout-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readEvents(): { hook_event: string }[] {
  const dbPath = path.join(tmpRoot, '.nexus', 'telemetry.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT hook_event FROM events ORDER BY id").all() as { hook_event: string }[];
  db.close();
  return rows;
}
function readEnabledState(): string | null {
  const dbPath = path.join(tmpRoot, '.nexus', 'telemetry.db');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT value FROM meta WHERE key='last_enabled_state'").get() as { value: string } | undefined;
  db.close();
  return row?.value ?? null;
}

describe('recordOptOutTransition', () => {
  it('on first run with enabled=true, stores last_enabled_state=1, no events', () => {
    recordOptOutTransition(tmpRoot, true);
    expect(readEnabledState()).toBe('1');
    expect(readEvents()).toEqual([]);
  });

  it('writes opt_out event when transitioning enabled→disabled', () => {
    recordOptOutTransition(tmpRoot, true);
    recordOptOutTransition(tmpRoot, false);
    expect(readEvents().map(e => e.hook_event)).toEqual(['opt_out']);
    expect(readEnabledState()).toBe('0');
  });

  it('writes opt_in event when transitioning disabled→enabled', () => {
    recordOptOutTransition(tmpRoot, false);
    recordOptOutTransition(tmpRoot, true);
    expect(readEvents().map(e => e.hook_event)).toEqual(['opt_in']);
    expect(readEnabledState()).toBe('1');
  });

  it('writes nothing when state is unchanged across calls', () => {
    recordOptOutTransition(tmpRoot, true);
    recordOptOutTransition(tmpRoot, true);
    recordOptOutTransition(tmpRoot, true);
    expect(readEvents()).toEqual([]);
  });

  it('survives bogus rootDir (no-op, no throw)', () => {
    const fakeRoot = path.join(tmpRoot, 'parent-is-file');
    fs.writeFileSync(fakeRoot, 'sentinel');
    expect(() => recordOptOutTransition(fakeRoot, false)).not.toThrow();
  });
});
