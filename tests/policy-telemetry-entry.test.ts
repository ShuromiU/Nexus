import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

let tmpRoot: string;
const repoRoot = path.resolve(__dirname, '..');
const entryBin = path.join(repoRoot, 'dist', 'transports', 'policy-entry.js');

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-entry-tel-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runEntry(payload: object, env?: Record<string, string>): string {
  const r = execFileSync(process.execPath, [entryBin], {
    input: JSON.stringify(payload),
    env: { ...process.env, ...(env ?? {}) },
    encoding: 'utf-8',
  });
  return r;
}

function readRows(): Record<string, unknown>[] {
  const dbPath = path.join(tmpRoot, '.nexus', 'telemetry.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT * FROM events ORDER BY id').all() as Record<string, unknown>[];
  db.close();
  return rows;
}

describe('policy-entry telemetry integration', () => {
  it('records a row for a real Pre event', () => {
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/foo.ts' },
      session_id: 'sess-X',
      cwd: tmpRoot,
    });
    const rows = readRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const last = rows[rows.length - 1];
    expect(last.session_id).toBe('sess-X');
    expect(typeof last.input_hash).toBe('string');
    expect((last.input_hash as string).length).toBe(16);
  });

  it('records no event rows when NEXUS_TELEMETRY=0 (transition tracking only)', () => {
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/foo.ts' },
      session_id: 'sess-X',
      cwd: tmpRoot,
    }, { NEXUS_TELEMETRY: '0' });
    // The DB is created by recordOptOutTransition to record last_enabled_state.
    // But no PreToolUse event row should be written.
    const rows = readRows().filter(r => r.hook_event !== 'opt_in' && r.hook_event !== 'opt_out');
    expect(rows.length).toBe(0);
  });

  it('Pre + Post with same input_hash both recorded', () => {
    const payload = (hook: string) => ({
      hook_event_name: hook,
      tool_name: 'Read',
      tool_input: { file_path: 'src/foo.ts' },
      session_id: 'sess-Y',
      cwd: tmpRoot,
    });
    runEntry(payload('PreToolUse'));
    runEntry(payload('PostToolUse'));
    const rows = readRows().filter(r => r.hook_event === 'PreToolUse' || r.hook_event === 'PostToolUse');
    expect(rows.length).toBe(2);
    expect(rows[0].input_hash).toBe(rows[1].input_hash);
    expect(rows[0].hook_event).toBe('PreToolUse');
    expect(rows[1].hook_event).toBe('PostToolUse');
  });

  it('records opt_out transition when env flips', () => {
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/foo.ts' },
      cwd: tmpRoot,
    });
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/foo.ts' },
      cwd: tmpRoot,
    }, { NEXUS_TELEMETRY: '0' });
    const rows = readRows();
    const optOuts = rows.filter(r => r.hook_event === 'opt_out');
    expect(optOuts.length).toBe(1);
  });
});
