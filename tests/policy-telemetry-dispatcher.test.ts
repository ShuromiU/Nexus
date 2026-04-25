import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { dispatchPolicy } from '../src/policy/dispatcher.js';
import { openTelemetryDb, closeTelemetryDb } from '../src/policy/telemetry.js';
import type { PolicyEvent, PolicyRule } from '../src/policy/types.js';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-disp-tel-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const event = (over: Partial<PolicyEvent> = {}): PolicyEvent => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: 'src/foo.ts' },
  session_id: 'sess-A',
  ...over,
});

const allowAlways: PolicyRule = {
  name: 'allow-always',
  evaluate: () => ({ decision: 'allow' as const, rule: 'allow-always' }),
};
const noopAlways: PolicyRule = {
  name: 'noop-always',
  evaluate: () => null,
};
const throwingRule: PolicyRule = {
  name: 'thrower',
  evaluate: () => { throw new Error('boom'); },
};

function readEvents(): Record<string, unknown>[] {
  const db = new Database(path.join(tmpRoot, '.nexus', 'telemetry.db'), { readonly: true });
  const rows = db.prepare('SELECT * FROM events ORDER BY id').all() as Record<string, unknown>[];
  db.close();
  return rows;
}

describe('dispatcher telemetry integration', () => {
  it('records one row when a rule fires', () => {
    const db = openTelemetryDb(tmpRoot)!;
    dispatchPolicy(event(), { rootDir: tmpRoot, rules: [allowAlways], telemetryDb: db, inputHash: 'aabb' });
    closeTelemetryDb(db);
    const rows = readEvents();
    expect(rows.length).toBe(1);
    expect(rows[0].rule).toBe('allow-always');
    expect(rows[0].decision).toBe('allow');
    expect(rows[0].input_hash).toBe('aabb');
    expect(rows[0].session_id).toBe('sess-A');
    expect(rows[0].hook_event).toBe('PreToolUse');
    expect(typeof rows[0].latency_us).toBe('number');
    expect(rows[0].latency_us as number).toBeGreaterThanOrEqual(0);
  });

  it('records a single noop row when no rule fires', () => {
    const db = openTelemetryDb(tmpRoot)!;
    dispatchPolicy(event(), { rootDir: tmpRoot, rules: [noopAlways], telemetryDb: db, inputHash: 'aabb' });
    closeTelemetryDb(db);
    const rows = readEvents();
    expect(rows.length).toBe(1);
    expect(rows[0].rule).toBeNull();
    expect(rows[0].decision).toBe('noop');
    expect(rows[0].input_hash).toBe('aabb');
  });

  it('does not record a row for a rule that throws (caught + skipped)', () => {
    const db = openTelemetryDb(tmpRoot)!;
    const resp = dispatchPolicy(event(), {
      rootDir: tmpRoot, rules: [throwingRule, allowAlways], telemetryDb: db, inputHash: 'aabb',
    });
    expect(resp.decision).toBe('allow');
    closeTelemetryDb(db);
    const rows = readEvents();
    expect(rows.length).toBe(1);
    expect(rows[0].rule).toBe('allow-always');
  });

  it('does not throw when telemetryDb is missing', () => {
    const resp = dispatchPolicy(event(), { rootDir: tmpRoot, rules: [allowAlways] });
    expect(resp.decision).toBe('allow');
  });

  it('records latency in microseconds (sane bound)', () => {
    const db = openTelemetryDb(tmpRoot)!;
    dispatchPolicy(event(), { rootDir: tmpRoot, rules: [allowAlways], telemetryDb: db });
    closeTelemetryDb(db);
    const rows = readEvents();
    expect((rows[0].latency_us as number) < 1_000_000).toBe(true);
  });
});
