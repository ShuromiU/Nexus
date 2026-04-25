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
