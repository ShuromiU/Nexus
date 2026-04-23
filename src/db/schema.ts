import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 2;
export const EXTRACTOR_VERSION = 3;

const TABLES = `
-- Metadata (version tracking, invalidation, filesystem info)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Index run history (observability only)
CREATE TABLE IF NOT EXISTS index_runs (
  id             INTEGER PRIMARY KEY,
  started_at     TEXT NOT NULL,
  completed_at   TEXT,
  mode           TEXT NOT NULL,
  files_scanned  INTEGER DEFAULT 0,
  files_indexed  INTEGER DEFAULT 0,
  files_skipped  INTEGER DEFAULT 0,
  files_errored  INTEGER DEFAULT 0,
  status         TEXT NOT NULL
);

-- Singleton indexer lock (prevents competing rebuilds)
CREATE TABLE IF NOT EXISTS index_lock (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  holder_id     TEXT NOT NULL,
  acquired_at   TEXT NOT NULL,
  heartbeat_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

-- Indexed files
CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL,
  path_key   TEXT NOT NULL UNIQUE,
  hash       TEXT NOT NULL,
  mtime      REAL NOT NULL,
  size       INTEGER NOT NULL,
  language   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'indexed',
  error      TEXT,
  indexed_at TEXT NOT NULL
);

-- Symbol definitions
CREATE TABLE IF NOT EXISTS symbols (
  id        INTEGER PRIMARY KEY,
  file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  line      INTEGER NOT NULL,
  col       INTEGER NOT NULL,
  end_line  INTEGER,
  signature TEXT,
  scope     TEXT,
  doc       TEXT
);

-- Unified module edges: imports, exports, re-exports
CREATE TABLE IF NOT EXISTS module_edges (
  id               INTEGER PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  name             TEXT,
  alias            TEXT,
  source           TEXT,
  line             INTEGER NOT NULL,
  is_default       INTEGER DEFAULT 0,
  is_star          INTEGER DEFAULT 0,
  is_type          INTEGER DEFAULT 0,
  symbol_id        INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL
);

-- Best-effort identifier occurrences
CREATE TABLE IF NOT EXISTS occurrences (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  line       INTEGER NOT NULL,
  col        INTEGER NOT NULL,
  context    TEXT,
  confidence TEXT NOT NULL DEFAULT 'heuristic',
  ref_kind   TEXT
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_symbols_name      ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_name_ci   ON symbols(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_symbols_kind      ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file_kind ON symbols(file_id, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file_range ON symbols(file_id, line, end_line);
CREATE INDEX IF NOT EXISTS idx_edges_file        ON module_edges(file_id);
CREATE INDEX IF NOT EXISTS idx_edges_source      ON module_edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_name        ON module_edges(name);
CREATE INDEX IF NOT EXISTS idx_edges_resolved    ON module_edges(resolved_file_id);
CREATE INDEX IF NOT EXISTS idx_occur_name        ON occurrences(name);
CREATE INDEX IF NOT EXISTS idx_occur_file        ON occurrences(file_id);
CREATE INDEX IF NOT EXISTS idx_occur_name_refkind ON occurrences(name, ref_kind);
CREATE INDEX IF NOT EXISTS idx_files_language    ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_status      ON files(status);
`;

/**
 * Open (or create) the SQLite database with WAL mode and foreign keys.
 * Runs quick_check and applies schema if needed.
 */
export function openDatabase(
  dbPath: string,
  opts?: { readonly?: boolean },
): Database.Database {
  const db = opts?.readonly
    ? new Database(dbPath, { readonly: true, fileMustExist: true })
    : new Database(dbPath);

  // WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');
  // Enforce foreign key constraints
  db.pragma('foreign_keys = ON');
  // Sync mode: normal is safe with WAL
  db.pragma('synchronous = NORMAL');

  return db;
}

/**
 * Drop all Nexus tables if the stored schema version is stale. Called by
 * applySchema BEFORE running DDL. On a fresh database (no meta table),
 * this is a no-op — the normal CREATE TABLE flow handles it.
 *
 * A version mismatch triggers a full rebuild by design: SCHEMA_VERSION or
 * EXTRACTOR_VERSION bumps are reserved for changes that cannot be safely
 * migrated in place (e.g. new columns referenced by indexes, changed
 * semantics of existing columns). See CHANGELOG for the policy.
 */
function dropStaleTablesIfNeeded(db: Database.Database): void {
  // Check if meta table exists (fresh install → skip)
  const metaExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();
  if (!metaExists) return;

  // Read stored versions
  const schemaRow = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const extractorRow = db
    .prepare("SELECT value FROM meta WHERE key = 'extractor_version'")
    .get() as { value: string } | undefined;

  const storedSchema = schemaRow ? parseInt(schemaRow.value, 10) : 0;
  const storedExtractor = extractorRow ? parseInt(extractorRow.value, 10) : 0;

  if (storedSchema === SCHEMA_VERSION && storedExtractor === EXTRACTOR_VERSION) {
    return; // up to date
  }

  // Stale — drop everything. Drop indexes first (they reference columns),
  // then child tables (FK dependents), then parent tables.
  const DROP = `
    DROP INDEX IF EXISTS idx_symbols_name;
    DROP INDEX IF EXISTS idx_symbols_name_ci;
    DROP INDEX IF EXISTS idx_symbols_kind;
    DROP INDEX IF EXISTS idx_symbols_file_kind;
    DROP INDEX IF EXISTS idx_symbols_file_range;
    DROP INDEX IF EXISTS idx_edges_file;
    DROP INDEX IF EXISTS idx_edges_source;
    DROP INDEX IF EXISTS idx_edges_name;
    DROP INDEX IF EXISTS idx_edges_resolved;
    DROP INDEX IF EXISTS idx_occur_name;
    DROP INDEX IF EXISTS idx_occur_file;
    DROP INDEX IF EXISTS idx_occur_name_refkind;
    DROP INDEX IF EXISTS idx_files_language;
    DROP INDEX IF EXISTS idx_files_status;
    DROP TABLE IF EXISTS occurrences;
    DROP TABLE IF EXISTS module_edges;
    DROP TABLE IF EXISTS symbols;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS index_runs;
    DROP TABLE IF EXISTS index_lock;
    DROP TABLE IF EXISTS meta;
  `;
  db.exec(DROP);
}

/**
 * Apply schema tables and indexes. Idempotent (IF NOT EXISTS).
 * Drops stale tables first when the stored version mismatches current.
 */
export function applySchema(db: Database.Database): void {
  dropStaleTablesIfNeeded(db);
  db.exec(TABLES);
  db.exec(INDEXES);
}

/**
 * Initialize meta keys for a fresh database.
 */
export function initializeMeta(
  db: Database.Database,
  rootPath: string,
  fsCaseSensitive: boolean,
): void {
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
  );

  const initTransaction = db.transaction(() => {
    upsert.run('schema_version', String(SCHEMA_VERSION));
    upsert.run('extractor_version', String(EXTRACTOR_VERSION));
    upsert.run('config_hash', '');
    upsert.run('root_path', rootPath);
    upsert.run('last_indexed_at', '');
    upsert.run('fs_case_sensitive', String(fsCaseSensitive));
  });

  initTransaction();
}
