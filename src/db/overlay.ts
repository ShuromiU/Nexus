/**
 * Overlay database — small SQLite file living at `<worktree>/.nexus/overlay.db`
 * that records only the files which diverge from the parent's `.nexus/index.db`.
 *
 * Schema diverges from the parent at exactly one column: `module_edges` stores
 * cross-file FK targets as POSIX paths instead of integer file ids, because
 * those targets may live in either parent.files or overlay.files at query time.
 *
 * Overlay rows reference overlay-local primary keys; the merged TEMP views
 * built by `Store.attachOverlay()` flip overlay ids to negative so they don't
 * collide with parent positive ids.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION, EXTRACTOR_VERSION } from './schema.js';
import type { SymbolRow, ModuleEdgeRow, OccurrenceRow, FileRow } from './store.js';

/** Raw extractor output (no IDs assigned yet). Mirrors orchestrator's FileBuffer. */
type ExtractedSymbol = Omit<SymbolRow, 'id' | 'file_id'>;
type ExtractedEdge = Omit<ModuleEdgeRow, 'id' | 'file_id' | 'symbol_id' | 'resolved_file_id'>;
type ExtractedOccurrence = Omit<OccurrenceRow, 'id' | 'file_id'>;

export const OVERLAY_SCHEMA_VERSION = 1;

const OVERLAY_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS module_edges (
  id                INTEGER PRIMARY KEY,
  file_id           INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  name              TEXT,
  alias             TEXT,
  source            TEXT,
  line              INTEGER NOT NULL,
  is_default        INTEGER DEFAULT 0,
  is_star           INTEGER DEFAULT 0,
  is_type           INTEGER DEFAULT 0,
  symbol_id         INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  resolved_path     TEXT,
  resolved_path_key TEXT
);

CREATE TABLE IF NOT EXISTS deleted_files (
  path     TEXT NOT NULL,
  path_key TEXT NOT NULL PRIMARY KEY
);

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

CREATE TABLE IF NOT EXISTS relation_edges (
  id              INTEGER PRIMARY KEY,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_id       INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  target_name     TEXT NOT NULL,
  target_path_key TEXT,
  confidence      TEXT NOT NULL DEFAULT 'declared',
  line            INTEGER NOT NULL
);
`;

const OVERLAY_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_overlay_symbols_name      ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_overlay_symbols_kind      ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_overlay_symbols_file_kind ON symbols(file_id, kind);
CREATE INDEX IF NOT EXISTS idx_overlay_edges_file        ON module_edges(file_id);
CREATE INDEX IF NOT EXISTS idx_overlay_edges_resolved    ON module_edges(resolved_path_key);
CREATE INDEX IF NOT EXISTS idx_overlay_occur_name        ON occurrences(name);
CREATE INDEX IF NOT EXISTS idx_overlay_occur_file        ON occurrences(file_id);
CREATE INDEX IF NOT EXISTS idx_overlay_rel_source        ON relation_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_overlay_rel_target_pk     ON relation_edges(target_path_key);
CREATE INDEX IF NOT EXISTS idx_overlay_rel_target_name   ON relation_edges(target_name);
CREATE INDEX IF NOT EXISTS idx_overlay_rel_kind          ON relation_edges(kind);
CREATE INDEX IF NOT EXISTS idx_overlay_rel_file          ON relation_edges(file_id);
`;

export interface OverlayMetaInput {
  parent_index_path: string;
  parent_git_head: string;
  git_head: string | null;
  built_at: string;
  index_mode: 'overlay-on-parent';
  root_path: string;
  fs_case_sensitive: boolean;
  degraded_reason?: string;
}

export interface InsertSymbolsResult {
  /** First-write-wins per name — used for module_edges symbol_id resolution. */
  idsByName: Map<string, number>;
  /** Parallel to input order — used for relation_edges source_id mapping. */
  idsByIndex: number[];
}

export interface OverlayRelationRow {
  file_id: number;
  source_id: number;
  kind: string;
  target_name: string;
  target_path_key: string | null;
  confidence: string;
  line: number;
}

export interface OverlayWriter {
  insertFile(row: Omit<FileRow, 'id'>): number;
  insertSymbols(fileId: number, syms: ExtractedSymbol[]): InsertSymbolsResult;
  insertModuleEdges(
    fileId: number,
    edges: ExtractedEdge[],
    symbolIdsByName: Map<string, number>,
  ): void;
  /**
   * Insert pre-resolved relation rows. Caller (overlay-orchestrator) is
   * responsible for resolving same-file and cross-file targets to a path_key
   * before calling. Cross-file resolution requires knowledge of the parent
   * index, which the writer doesn't have access to.
   */
  insertRelationEdges(rows: OverlayRelationRow[]): void;
  insertOccurrences(fileId: number, occ: ExtractedOccurrence[]): void;
  recordDeleted(paths: { path: string; path_key: string }[]): void;
  setMeta(meta: OverlayMetaInput): void;
  /** Commit + close + atomic rename `<path>.tmp` → `<path>`. */
  publish(): void;
  /** Discard the in-flight build; closes connection and unlinks tmp file. */
  abort(): void;
}

/**
 * Open a fresh writable overlay DB at `<finalPath>.tmp`. Caller must call
 * `publish()` to atomic-rename into place, or `abort()` to clean up.
 *
 * If `<finalPath>.tmp` already exists from a crashed build, it is unlinked
 * first.
 */
export function openOverlayWriter(finalPath: string): OverlayWriter {
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  for (const p of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
    try { fs.unlinkSync(p); } catch { /* missing is fine */ }
  }

  const db = new Database(tmpPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(OVERLAY_DDL);
  db.exec(OVERLAY_INDEXES);

  // Prepared statements
  const insertFileStmt = db.prepare<unknown[]>(`
    INSERT INTO files(path, path_key, hash, mtime, size, language, status, error, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSymbolStmt = db.prepare<unknown[]>(`
    INSERT INTO symbols(file_id, name, kind, line, col, end_line, signature, scope, doc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEdgeStmt = db.prepare<unknown[]>(`
    INSERT INTO module_edges(file_id, kind, name, alias, source, line,
                              is_default, is_star, is_type, symbol_id,
                              resolved_path, resolved_path_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOccStmt = db.prepare<unknown[]>(`
    INSERT INTO occurrences(file_id, name, line, col, context, confidence, ref_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRelStmt = db.prepare<unknown[]>(`
    INSERT INTO relation_edges(file_id, source_id, kind, target_name,
                               target_path_key, confidence, line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDeletedStmt = db.prepare<unknown[]>(`
    INSERT OR REPLACE INTO deleted_files(path, path_key) VALUES (?, ?)
  `);
  const setMetaStmt = db.prepare<unknown[]>(`
    INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)
  `);

  let closed = false;

  return {
    insertFile(row) {
      const r = insertFileStmt.run(
        row.path, row.path_key, row.hash, row.mtime, row.size,
        row.language, row.status, row.error, row.indexed_at,
      );
      return Number(r.lastInsertRowid);
    },

    insertSymbols(fileId, syms) {
      const idsByName = new Map<string, number>();
      const idsByIndex: number[] = [];
      const insertMany = db.transaction((rows: ExtractedSymbol[]) => {
        for (const s of rows) {
          const r = insertSymbolStmt.run(
            fileId, s.name, s.kind, s.line, s.col, s.end_line ?? null,
            s.signature ?? null, s.scope ?? null, s.doc ?? null,
          );
          const id = Number(r.lastInsertRowid);
          idsByIndex.push(id);
          // First-write-wins: if the same name appears multiple times in a file
          // (overloads, re-declarations), the first one is the one we'll use
          // for symbol_id resolution in module_edges. This mirrors the parent
          // index behavior (NexusStore does the same).
          if (!idsByName.has(s.name)) idsByName.set(s.name, id);
        }
      });
      insertMany(syms);
      return { idsByName, idsByIndex };
    },

    insertModuleEdges(fileId, edges, symbolIdsByName) {
      const insertMany = db.transaction((rows: ExtractedEdge[]) => {
        for (const e of rows) {
          // Resolved path for cross-file FK lookup at query time. The edge
          // came from extractFile, which already resolved the SOURCE module
          // (e.g. './utils') against the file's directory in some cases —
          // but we keep the raw spec so the merged view can resolve against
          // either parent.files OR overlay.files at query time.
          const resolvedPath = e.source ?? null;
          const resolvedPathKey = resolvedPath ?? null;
          // symbol_id resolution: prefer locally-defined symbol with same name.
          const symbolId = e.name && symbolIdsByName.has(e.name)
            ? symbolIdsByName.get(e.name)!
            : null;
          insertEdgeStmt.run(
            fileId, e.kind, e.name ?? null, e.alias ?? null, e.source ?? null, e.line,
            e.is_default ? 1 : 0, e.is_star ? 1 : 0, e.is_type ? 1 : 0,
            symbolId, resolvedPath, resolvedPathKey,
          );
        }
      });
      insertMany(edges);
    },

    insertRelationEdges(rows) {
      if (rows.length === 0) return;
      const insertMany = db.transaction((entries: OverlayRelationRow[]) => {
        for (const r of entries) {
          insertRelStmt.run(
            r.file_id, r.source_id, r.kind, r.target_name,
            r.target_path_key, r.confidence, r.line,
          );
        }
      });
      insertMany(rows);
    },

    insertOccurrences(fileId, occ) {
      const insertMany = db.transaction((rows: ExtractedOccurrence[]) => {
        for (const o of rows) {
          insertOccStmt.run(
            fileId, o.name, o.line, o.col, o.context ?? null,
            o.confidence ?? 'heuristic', o.ref_kind ?? null,
          );
        }
      });
      insertMany(occ);
    },

    recordDeleted(paths) {
      const insertMany = db.transaction((rows: { path: string; path_key: string }[]) => {
        for (const p of rows) insertDeletedStmt.run(p.path, p.path_key);
      });
      insertMany(paths);
    },

    setMeta(meta) {
      const writeMany = db.transaction(() => {
        setMetaStmt.run('parent_index_path', meta.parent_index_path);
        setMetaStmt.run('parent_git_head', meta.parent_git_head);
        if (meta.git_head) setMetaStmt.run('git_head', meta.git_head);
        setMetaStmt.run('built_at', meta.built_at);
        setMetaStmt.run('last_indexed_at', meta.built_at);
        setMetaStmt.run('index_mode', meta.index_mode);
        setMetaStmt.run('root_path', meta.root_path);
        setMetaStmt.run('fs_case_sensitive', meta.fs_case_sensitive ? 'true' : 'false');
        setMetaStmt.run('schema_version', String(SCHEMA_VERSION));
        setMetaStmt.run('extractor_version', String(EXTRACTOR_VERSION));
        setMetaStmt.run('overlay_schema_version', String(OVERLAY_SCHEMA_VERSION));
        if (meta.degraded_reason) {
          setMetaStmt.run('degraded_reason', meta.degraded_reason);
        }
      });
      writeMany();
    },

    publish() {
      if (closed) return;
      closed = true;
      // Checkpoint WAL into the main DB so the rename target is self-contained.
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
      db.close();
      // Clean up any stale -wal/-shm next to the final destination, then move.
      for (const p of [finalPath, `${finalPath}-wal`, `${finalPath}-shm`]) {
        try { fs.unlinkSync(p); } catch { /* missing is fine */ }
      }
      fs.renameSync(tmpPath, finalPath);
    },

    abort() {
      if (closed) return;
      closed = true;
      try { db.close(); } catch { /* ignore */ }
      for (const p of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
        try { fs.unlinkSync(p); } catch { /* missing is fine */ }
      }
    },
  };
}
