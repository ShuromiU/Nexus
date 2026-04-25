import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openTelemetryDb,
  closeTelemetryDb,
  recordEvent,
  pruneIfDue,
  TELEMETRY_SCHEMA_VERSION,
} from '../src/policy/telemetry.js';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-telemetry-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('openTelemetryDb', () => {
  it('creates .nexus/telemetry.db with schema on first open', () => {
    const db = openTelemetryDb(tmpRoot);
    expect(db).not.toBeNull();
    expect(fs.existsSync(path.join(tmpRoot, '.nexus', 'telemetry.db'))).toBe(true);
    const meta = db!.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    expect(meta?.value).toBe(String(TELEMETRY_SCHEMA_VERSION));
    closeTelemetryDb(db!);
  });

  it('reuses existing DB on subsequent opens', () => {
    const a = openTelemetryDb(tmpRoot);
    a!.prepare('INSERT INTO events (ts_ms, hook_event) VALUES (?, ?)').run(1, 'PreToolUse');
    closeTelemetryDb(a!);

    const b = openTelemetryDb(tmpRoot);
    const row = b!.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(row.n).toBe(1);
    closeTelemetryDb(b!);
  });

  it('returns null when .nexus dir cannot be created (parent is a file)', () => {
    const fakeRoot = path.join(tmpRoot, 'not-a-dir');
    fs.writeFileSync(fakeRoot, 'sentinel');
    const db = openTelemetryDb(fakeRoot);
    expect(db).toBeNull();
  });

  it('recovers from corrupt DB by renaming + recreating', () => {
    fs.mkdirSync(path.join(tmpRoot, '.nexus'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.nexus', 'telemetry.db'), 'not-a-sqlite-db');

    const db = openTelemetryDb(tmpRoot);
    expect(db).not.toBeNull();
    const row = db!.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(row.n).toBe(0);

    const corrupted = fs.readdirSync(path.join(tmpRoot, '.nexus'))
      .filter(f => f.startsWith('telemetry.db.corrupt-'));
    expect(corrupted.length).toBe(1);
    closeTelemetryDb(db!);
  });

  it('recovers when schema_version differs', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.nexus'), { recursive: true });
    const Database = (await import('better-sqlite3')).default;
    const db1 = new Database(path.join(tmpRoot, '.nexus', 'telemetry.db'));
    db1.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','999');");
    db1.close();

    const db = openTelemetryDb(tmpRoot);
    expect(db).not.toBeNull();
    const meta = db!.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as { value: string };
    expect(meta.value).toBe(String(TELEMETRY_SCHEMA_VERSION));
    closeTelemetryDb(db!);
  });
});

describe('recordEvent', () => {
  it('is a no-op when db is null', () => {
    expect(() => recordEvent(null, {
      ts_ms: 1, session_id: 's', hook_event: 'PreToolUse',
      tool_name: 'Read', rule: 'r', decision: 'allow', latency_us: 100,
      input_hash: 'a'.repeat(16), file_path: 'f.ts', payload_json: null,
    })).not.toThrow();
  });

  it('inserts a row matching the input', () => {
    const db = openTelemetryDb(tmpRoot)!;
    recordEvent(db, {
      ts_ms: 12345, session_id: 'sess1', hook_event: 'PreToolUse',
      tool_name: 'Edit', rule: 'preedit-impact', decision: 'allow',
      latency_us: 850, input_hash: '1234567890abcdef',
      file_path: 'src/foo.ts', payload_json: null,
    });
    const row = db.prepare('SELECT * FROM events').get() as Record<string, unknown>;
    expect(row.ts_ms).toBe(12345);
    expect(row.session_id).toBe('sess1');
    expect(row.hook_event).toBe('PreToolUse');
    expect(row.tool_name).toBe('Edit');
    expect(row.rule).toBe('preedit-impact');
    expect(row.decision).toBe('allow');
    expect(row.latency_us).toBe(850);
    expect(row.input_hash).toBe('1234567890abcdef');
    expect(row.file_path).toBe('src/foo.ts');
    expect(row.payload_json).toBeNull();
    closeTelemetryDb(db);
  });

  it('swallows errors when DB is closed mid-record', () => {
    const db = openTelemetryDb(tmpRoot)!;
    closeTelemetryDb(db);
    expect(() => recordEvent(db, {
      ts_ms: 1, session_id: null, hook_event: 'PreToolUse',
      tool_name: 'Read', rule: null, decision: 'noop', latency_us: 0,
      input_hash: null, file_path: null, payload_json: null,
    })).not.toThrow();
  });

  it('accepts NULL session_id, rule, decision, and latency_us', () => {
    const db = openTelemetryDb(tmpRoot)!;
    recordEvent(db, {
      ts_ms: 1, session_id: null, hook_event: 'opt_out',
      tool_name: null, rule: null, decision: null, latency_us: null,
      input_hash: null, file_path: null, payload_json: null,
    });
    const row = db.prepare('SELECT * FROM events').get() as Record<string, unknown>;
    expect(row.hook_event).toBe('opt_out');
    expect(row.session_id).toBeNull();
    expect(row.rule).toBeNull();
    expect(row.latency_us).toBeNull();
    closeTelemetryDb(db);
  });
});
