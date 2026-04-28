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
CREATE TABLE IF NOT EXISTS pack_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  session_id TEXT,
  query TEXT NOT NULL,
  budget_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  included_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  timing_ms REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pack_runs_ts ON pack_runs(ts_ms);
CREATE INDEX IF NOT EXISTS idx_pack_runs_session ON pack_runs(session_id);
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

/** D4 v2 — pack-utilization persistence. Best-effort, never throws. */
export interface PackRunRecord {
  ts_ms: number;
  session_id: string | null;
  query: string;
  budget_tokens: number;
  total_tokens: number;
  included_count: number;
  skipped_count: number;
  timing_ms: number;
}

const INSERT_PACK_RUN_SQL = `
INSERT INTO pack_runs
  (ts_ms, session_id, query, budget_tokens, total_tokens,
   included_count, skipped_count, timing_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

export function recordPackRun(db: Database.Database | null, run: PackRunRecord): void {
  if (!db) return;
  try {
    db.prepare(INSERT_PACK_RUN_SQL).run(
      run.ts_ms,
      run.session_id,
      run.query,
      run.budget_tokens,
      run.total_tokens,
      run.included_count,
      run.skipped_count,
      run.timing_ms,
    );
  } catch {
    /* swallow — telemetry must never block pack() */
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

    // pack_runs uses the same retention window. The table won't exist on a
    // pre-D4-v2 db (CREATE TABLE IF NOT EXISTS in tryOpen handles it on
    // open) but try/catch is wrapping the whole prune anyway.
    let packTimeChanges = 0;
    let packCountChanges = 0;
    try {
      const packTimeRes = db.prepare('DELETE FROM pack_runs WHERE ts_ms < ?').run(cutoff);
      const packCountRes = db.prepare(
        'DELETE FROM pack_runs WHERE id NOT IN (SELECT id FROM pack_runs ORDER BY id DESC LIMIT ?)'
      ).run(RETENTION_ROW_CAP);
      packTimeChanges = Number(packTimeRes.changes);
      packCountChanges = Number(packCountRes.changes);
    } catch {
      /* table missing on legacy schema — ignore */
    }

    db.prepare(
      "INSERT INTO meta(key, value) VALUES('last_prune_ts', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(String(now));

    return {
      pruned:
        Number(timeRes.changes) + Number(countRes.changes) + packTimeChanges + packCountChanges,
    };
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
