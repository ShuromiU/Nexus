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

export function recordEvent(_db: Database.Database | null, _ev: TelemetryEvent): void {
  // implemented in Task 3
}

export function pruneIfDue(_db: Database.Database, _now?: number): { pruned: number } {
  // implemented in Task 4
  return { pruned: 0 };
}
