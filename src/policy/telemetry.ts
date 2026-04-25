import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

export const TELEMETRY_SCHEMA_VERSION = 1;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  session_id TEXT,
  hook_event TEXT NOT NULL,
  tool_name TEXT,
  rule TEXT,
  decision TEXT,
  latency_us INTEGER,
  input_hash TEXT,
  file_path TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session_hash
  ON events(session_id, input_hash)
  WHERE session_id IS NOT NULL AND input_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_ms);
CREATE INDEX IF NOT EXISTS idx_events_rule_decision ON events(rule, decision);
`;

export interface TelemetryEvent {
  ts_ms: number;
  session_id: string | null;
  hook_event: 'PreToolUse' | 'PostToolUse' | 'opt_out' | 'opt_in';
  tool_name: string | null;
  rule: string | null;
  decision: 'allow' | 'ask' | 'deny' | 'noop' | null;
  latency_us: number | null;
  input_hash: string | null;
  file_path: string | null;
  payload_json: string | null;
}

export function openTelemetryDb(rootDir: string): Database.Database | null {
  const nexusDir = path.join(rootDir, '.nexus');
  try {
    fs.mkdirSync(nexusDir, { recursive: true });
  } catch {
    return null;
  }
  const dbPath = path.join(nexusDir, 'telemetry.db');

  const tryOpen = (): Database.Database | null => {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.exec(SCHEMA_DDL);
      const row = db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as { value: string } | undefined;
      if (!row) {
        db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(TELEMETRY_SCHEMA_VERSION));
      } else if (row.value !== String(TELEMETRY_SCHEMA_VERSION)) {
        db.close();
        return null;
      }
      return db;
    } catch {
      try { db?.close(); } catch { /* ignore */ }
      return null;
    }
  };

  let db = tryOpen();
  if (db) return db;

  try {
    if (fs.existsSync(dbPath)) {
      const stamp = Date.now();
      fs.renameSync(dbPath, `${dbPath}.corrupt-${stamp}`);
    }
  } catch {
    return null;
  }
  db = tryOpen();
  return db;
}

export function closeTelemetryDb(db: Database.Database): void {
  try { db.close(); } catch { /* swallow */ }
}

const INSERT_SQL = `
INSERT INTO events
  (ts_ms, session_id, hook_event, tool_name, rule, decision,
   latency_us, input_hash, file_path, payload_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function recordEvent(db: Database.Database | null, ev: TelemetryEvent): void {
  if (!db) return;
  try {
    db.prepare(INSERT_SQL).run(
      ev.ts_ms,
      ev.session_id,
      ev.hook_event,
      ev.tool_name,
      ev.rule,
      ev.decision,
      ev.latency_us,
      ev.input_hash,
      ev.file_path,
      ev.payload_json,
    );
  } catch {
    /* swallow — telemetry must never block policy */
  }
}

const RETENTION_DAYS = 30;
const RETENTION_ROW_CAP = 100_000;
const PRUNE_INTERVAL_MS = 24 * 3600 * 1000;

export function pruneIfDue(db: Database.Database, now: number = Date.now()): { pruned: number } {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get('last_prune_ts') as { value: string } | undefined;
    const last = row ? Number(row.value) : 0;
    if (last !== 0 && now - last < PRUNE_INTERVAL_MS) {
      return { pruned: 0 };
    }

    const cutoff = now - RETENTION_DAYS * 86400000;
    const timeRes = db.prepare('DELETE FROM events WHERE ts_ms < ?').run(cutoff);
    const countRes = db.prepare(
      'DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)'
    ).run(RETENTION_ROW_CAP);

    db.prepare(
      "INSERT INTO meta(key, value) VALUES('last_prune_ts', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(String(now));

    return { pruned: Number(timeRes.changes) + Number(countRes.changes) };
  } catch {
    return { pruned: 0 };
  }
}

export function recordOptOutTransition(rootDir: string, currentlyEnabled: boolean): void {
  const db = openTelemetryDb(rootDir);
  if (!db) return;
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get('last_enabled_state') as { value: string } | undefined;
    const last = row?.value ?? null;
    const now = currentlyEnabled ? '1' : '0';

    if (last === null) {
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('last_enabled_state', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(now);
    } else if (last !== now) {
      const hookEvent = currentlyEnabled ? 'opt_in' : 'opt_out';
      recordEvent(db, {
        ts_ms: Date.now(),
        session_id: null,
        hook_event: hookEvent,
        tool_name: null,
        rule: null,
        decision: null,
        latency_us: null,
        input_hash: null,
        file_path: null,
        payload_json: null,
      });
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('last_enabled_state', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(now);
    }
  } catch {
    /* swallow */
  } finally {
    closeTelemetryDb(db);
  }
}
