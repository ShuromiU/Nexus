import type Database from 'better-sqlite3';

// ── Types ──────────────────────────────────────────────────────────────

export interface FileRow {
  id?: number;
  path: string;
  path_key: string;
  hash: string;
  mtime: number;
  size: number;
  language: string;
  status: string;
  error?: string | null;
  indexed_at: string;
}

export interface SymbolRow {
  id?: number;
  file_id: number;
  name: string;
  kind: string;
  line: number;
  col: number;
  end_line?: number | null;
  signature?: string | null;
  scope?: string | null;
  doc?: string | null;
}

export interface ModuleEdgeRow {
  id?: number;
  file_id: number;
  kind: string;
  name?: string | null;
  alias?: string | null;
  source?: string | null;
  line: number;
  is_default: boolean;
  is_star: boolean;
  is_type: boolean;
  symbol_id?: number | null;
  resolved_file_id?: number | null;
}

export interface OccurrenceRow {
  id?: number;
  file_id: number;
  name: string;
  line: number;
  col: number;
  context?: string | null;
  confidence: string;
}

export interface IndexRunRow {
  id?: number;
  started_at: string;
  completed_at?: string | null;
  mode: string;
  files_scanned: number;
  files_indexed: number;
  files_skipped: number;
  files_errored: number;
  status: string;
}

// ── JOIN result types (avoids N+1 queries) ───────────────────────────

export interface SymbolWithFile extends SymbolRow {
  id: number;
  file_path: string;
  file_language: string;
}

export interface OccurrenceWithFile extends OccurrenceRow {
  id: number;
  file_path: string;
}

export interface ImportEdgeWithFile extends ModuleEdgeRow {
  id: number;
  file_path: string;
  file_language: string;
}

export interface TreeDataRow {
  id: number;
  path: string;
  language: string;
  status: string;
  symbol_count: number;
}

// ── Store ──────────────────────────────────────────────────────────────

export class NexusStore {
  constructor(private db: Database.Database) {}

  // ── Meta ────────────────────────────────────────────────────────────

  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  // ── Files ───────────────────────────────────────────────────────────

  insertFile(file: FileRow): number {
    const result = this.db
      .prepare(
        `INSERT INTO files (path, path_key, hash, mtime, size, language, status, error, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        file.path,
        file.path_key,
        file.hash,
        file.mtime,
        file.size,
        file.language,
        file.status,
        file.error ?? null,
        file.indexed_at,
      );
    return Number(result.lastInsertRowid);
  }

  getFileByPathKey(pathKey: string): (FileRow & { id: number }) | undefined {
    return this.db
      .prepare('SELECT * FROM files WHERE path_key = ?')
      .get(pathKey) as (FileRow & { id: number }) | undefined;
  }

  getFileById(id: number): (FileRow & { id: number }) | undefined {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as
      | (FileRow & { id: number })
      | undefined;
  }

  getAllFiles(): (FileRow & { id: number })[] {
    return this.db.prepare('SELECT * FROM files').all() as (FileRow & {
      id: number;
    })[];
  }

  getFilePaths(opts?: { language?: string; pathPrefix?: string }): { path: string; language: string }[] {
    let sql = "SELECT path, language FROM files WHERE status = 'indexed'";
    const params: unknown[] = [];

    if (opts?.language) {
      sql += ' AND language = ?';
      params.push(opts.language);
    }
    if (opts?.pathPrefix) {
      sql += " AND (path LIKE ? OR REPLACE(path, '\\', '/') LIKE ?)";
      params.push(`${opts.pathPrefix}%`, `${opts.pathPrefix}%`);
    }

    sql += ' ORDER BY path';
    return this.db.prepare(sql).all(...params) as { path: string; language: string }[];
  }

  updateFileMtime(id: number, mtime: number, size: number): void {
    this.db
      .prepare('UPDATE files SET mtime = ?, size = ? WHERE id = ?')
      .run(mtime, size, id);
  }

  deleteFile(id: number): void {
    this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
  }

  deleteFilesByIds(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(`DELETE FROM files WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  deleteAllFiles(): void {
    this.db.prepare('DELETE FROM files').run();
  }

  // ── Symbols ─────────────────────────────────────────────────────────

  insertSymbol(symbol: SymbolRow): number {
    const result = this.db
      .prepare(
        `INSERT INTO symbols (file_id, name, kind, line, col, end_line, signature, scope, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        symbol.file_id,
        symbol.name,
        symbol.kind,
        symbol.line,
        symbol.col,
        symbol.end_line ?? null,
        symbol.signature ?? null,
        symbol.scope ?? null,
        symbol.doc ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  insertSymbols(symbols: SymbolRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO symbols (file_id, name, kind, line, col, end_line, signature, scope, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((rows: SymbolRow[]) => {
      for (const s of rows) {
        stmt.run(
          s.file_id,
          s.name,
          s.kind,
          s.line,
          s.col,
          s.end_line ?? null,
          s.signature ?? null,
          s.scope ?? null,
          s.doc ?? null,
        );
      }
    });
    insertMany(symbols);
  }

  getSymbolsByName(name: string): (SymbolRow & { id: number })[] {
    return this.db
      .prepare('SELECT * FROM symbols WHERE name = ?')
      .all(name) as (SymbolRow & { id: number })[];
  }

  getSymbolsByNameCaseInsensitive(name: string): (SymbolRow & { id: number })[] {
    return this.db
      .prepare('SELECT * FROM symbols WHERE name = ? COLLATE NOCASE')
      .all(name) as (SymbolRow & { id: number })[];
  }

  getSymbolsByFileId(fileId: number): (SymbolRow & { id: number })[] {
    return this.db
      .prepare('SELECT * FROM symbols WHERE file_id = ?')
      .all(fileId) as (SymbolRow & { id: number })[];
  }

  getSymbolsByFileIdAndKind(fileId: number, kind: string): (SymbolRow & { id: number })[] {
    return this.db
      .prepare('SELECT * FROM symbols WHERE file_id = ? AND kind = ?')
      .all(fileId, kind) as (SymbolRow & { id: number })[];
  }

  getSymbolsByNameAndKind(
    name: string,
    kind: string,
  ): (SymbolRow & { id: number })[] {
    return this.db
      .prepare('SELECT * FROM symbols WHERE name = ? AND kind = ?')
      .all(name, kind) as (SymbolRow & { id: number })[];
  }

  // ── JOIN Queries (avoids N+1) ──────────────────────────────────────

  getSymbolsWithFile(name: string, kind?: string): SymbolWithFile[] {
    const sql = kind
      ? `SELECT s.*, f.path AS file_path, f.language AS file_language
         FROM symbols s JOIN files f ON s.file_id = f.id
         WHERE s.name = ? AND s.kind = ?`
      : `SELECT s.*, f.path AS file_path, f.language AS file_language
         FROM symbols s JOIN files f ON s.file_id = f.id
         WHERE s.name = ?`;
    return (kind
      ? this.db.prepare(sql).all(name, kind)
      : this.db.prepare(sql).all(name)
    ) as SymbolWithFile[];
  }

  getSymbolsWithFileCaseInsensitive(name: string, kind?: string): SymbolWithFile[] {
    const sql = kind
      ? `SELECT s.*, f.path AS file_path, f.language AS file_language
         FROM symbols s JOIN files f ON s.file_id = f.id
         WHERE s.name = ? COLLATE NOCASE AND s.kind = ?`
      : `SELECT s.*, f.path AS file_path, f.language AS file_language
         FROM symbols s JOIN files f ON s.file_id = f.id
         WHERE s.name = ? COLLATE NOCASE`;
    return (kind
      ? this.db.prepare(sql).all(name, kind)
      : this.db.prepare(sql).all(name)
    ) as SymbolWithFile[];
  }

  getOccurrencesWithFile(name: string): OccurrenceWithFile[] {
    return this.db
      .prepare(
        `SELECT o.*, f.path AS file_path
         FROM occurrences o JOIN files f ON o.file_id = f.id
         WHERE o.name = ?`,
      )
      .all(name) as OccurrenceWithFile[];
  }

  getImportEdgesWithFile(source: string): ImportEdgeWithFile[] {
    return this.db
      .prepare(
        `SELECT e.*, f.path AS file_path, f.language AS file_language
         FROM module_edges e JOIN files f ON e.file_id = f.id
         WHERE e.kind IN ('import', 'dynamic-import', 'require') AND e.source = ?
         ORDER BY f.path, e.line`,
      )
      .all(source) as ImportEdgeWithFile[];
  }

  getImportEdgesWithFileLike(sourcePattern: string): ImportEdgeWithFile[] {
    return this.db
      .prepare(
        `SELECT e.*, f.path AS file_path, f.language AS file_language
         FROM module_edges e JOIN files f ON e.file_id = f.id
         WHERE e.kind IN ('import', 'dynamic-import', 'require') AND e.source LIKE ?
         ORDER BY f.path, e.line`,
      )
      .all(`%${sourcePattern}%`) as ImportEdgeWithFile[];
  }

  getImportersByResolvedFileId(fileId: number): ImportEdgeWithFile[] {
    return this.db
      .prepare(
        `SELECT e.*, f.path AS file_path, f.language AS file_language
         FROM module_edges e JOIN files f ON e.file_id = f.id
         WHERE e.resolved_file_id = ?
         ORDER BY f.path, e.line`,
      )
      .all(fileId) as ImportEdgeWithFile[];
  }

  getTreeData(pathPrefix?: string): TreeDataRow[] {
    const sql = pathPrefix
      ? `SELECT f.id, f.path, f.language, f.status,
                COUNT(DISTINCT s.id) AS symbol_count
         FROM files f
         LEFT JOIN symbols s ON s.file_id = f.id
         WHERE f.path LIKE ? OR REPLACE(f.path, '\\', '/') LIKE ?
         GROUP BY f.id
         ORDER BY f.path`
      : `SELECT f.id, f.path, f.language, f.status,
                COUNT(DISTINCT s.id) AS symbol_count
         FROM files f
         LEFT JOIN symbols s ON s.file_id = f.id
         GROUP BY f.id
         ORDER BY f.path`;
    return (pathPrefix
      ? this.db.prepare(sql).all(`${pathPrefix}%`, `${pathPrefix}%`)
      : this.db.prepare(sql).all()
    ) as TreeDataRow[];
  }

  getExportNamesByFileIds(fileIds: number[]): Map<number, string[]> {
    if (fileIds.length === 0) return new Map();
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT file_id, name, is_default, is_star
         FROM module_edges
         WHERE file_id IN (${placeholders}) AND kind IN ('export', 're-export')`,
      )
      .all(...fileIds) as { file_id: number; name: string | null; is_default: number; is_star: number }[];

    const result = new Map<number, string[]>();
    for (const row of rows) {
      const name = row.name ?? (row.is_default ? '<default>' : row.is_star ? '*' : null);
      if (name) {
        const arr = result.get(row.file_id) ?? [];
        arr.push(name);
        result.set(row.file_id, arr);
      }
    }
    return result;
  }

  // ── Module Edges ────────────────────────────────────────────────────

  insertModuleEdge(edge: ModuleEdgeRow): number {
    const result = this.db
      .prepare(
        `INSERT INTO module_edges (file_id, kind, name, alias, source, line, is_default, is_star, is_type, symbol_id, resolved_file_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        edge.file_id,
        edge.kind,
        edge.name ?? null,
        edge.alias ?? null,
        edge.source ?? null,
        edge.line,
        edge.is_default ? 1 : 0,
        edge.is_star ? 1 : 0,
        edge.is_type ? 1 : 0,
        edge.symbol_id ?? null,
        edge.resolved_file_id ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  insertModuleEdges(edges: ModuleEdgeRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO module_edges (file_id, kind, name, alias, source, line, is_default, is_star, is_type, symbol_id, resolved_file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((rows: ModuleEdgeRow[]) => {
      for (const e of rows) {
        stmt.run(
          e.file_id,
          e.kind,
          e.name ?? null,
          e.alias ?? null,
          e.source ?? null,
          e.line,
          e.is_default ? 1 : 0,
          e.is_star ? 1 : 0,
          e.is_type ? 1 : 0,
          e.symbol_id ?? null,
          e.resolved_file_id ?? null,
        );
      }
    });
    insertMany(edges);
  }

  getEdgesByFileId(fileId: number): (ModuleEdgeRow & { id: number })[] {
    return this.db
      .prepare('SELECT * FROM module_edges WHERE file_id = ?')
      .all(fileId) as (ModuleEdgeRow & { id: number })[];
  }

  getImportsByFileId(fileId: number): (ModuleEdgeRow & { id: number })[] {
    return this.db
      .prepare("SELECT * FROM module_edges WHERE file_id = ? AND kind IN ('import', 'dynamic-import', 'require')")
      .all(fileId) as (ModuleEdgeRow & { id: number })[];
  }

  getExportsByFileId(fileId: number): (ModuleEdgeRow & { id: number })[] {
    return this.db
      .prepare(
        "SELECT * FROM module_edges WHERE file_id = ? AND kind IN ('export', 're-export')",
      )
      .all(fileId) as (ModuleEdgeRow & { id: number })[];
  }

  getEdgesBySource(source: string): (ModuleEdgeRow & { id: number })[] {
    return this.db
      .prepare('SELECT * FROM module_edges WHERE source = ?')
      .all(source) as (ModuleEdgeRow & { id: number })[];
  }

  getImportsBySourceLike(sourcePattern: string): (ModuleEdgeRow & { id: number })[] {
    return this.db
      .prepare(
        "SELECT * FROM module_edges WHERE kind IN ('import', 'dynamic-import', 'require') AND source LIKE ? ORDER BY file_id, line",
      )
      .all(`%${sourcePattern}%`) as (ModuleEdgeRow & { id: number })[];
  }

  getImportsBySourceExact(source: string): (ModuleEdgeRow & { id: number })[] {
    return this.db
      .prepare(
        "SELECT * FROM module_edges WHERE kind IN ('import', 'dynamic-import', 'require') AND source = ? ORDER BY file_id, line",
      )
      .all(source) as (ModuleEdgeRow & { id: number })[];
  }

  getUnresolvedRelativeEdges(): { id: number; file_id: number; source: string }[] {
    return this.db
      .prepare(
        `SELECT e.id, e.file_id, e.source
         FROM module_edges e
         WHERE e.resolved_file_id IS NULL
           AND e.source IS NOT NULL
           AND e.source LIKE '.%'`,
      )
      .all() as { id: number; file_id: number; source: string }[];
  }

  resolveEdge(edgeId: number, resolvedFileId: number): void {
    this.db
      .prepare('UPDATE module_edges SET resolved_file_id = ? WHERE id = ?')
      .run(resolvedFileId, edgeId);
  }

  resolveEdgesBatch(updates: { edgeId: number; resolvedFileId: number }[]): void {
    if (updates.length === 0) return;
    const stmt = this.db.prepare('UPDATE module_edges SET resolved_file_id = ? WHERE id = ?');
    const run = this.db.transaction((rows: typeof updates) => {
      for (const { edgeId, resolvedFileId } of rows) {
        stmt.run(resolvedFileId, edgeId);
      }
    });
    run(updates);
  }

  // ── Occurrences ─────────────────────────────────────────────────────

  insertOccurrence(occ: OccurrenceRow): number {
    const result = this.db
      .prepare(
        `INSERT INTO occurrences (file_id, name, line, col, context, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        occ.file_id,
        occ.name,
        occ.line,
        occ.col,
        occ.context ?? null,
        occ.confidence,
      );
    return Number(result.lastInsertRowid);
  }

  insertOccurrences(occs: OccurrenceRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO occurrences (file_id, name, line, col, context, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((rows: OccurrenceRow[]) => {
      for (const o of rows) {
        stmt.run(
          o.file_id,
          o.name,
          o.line,
          o.col,
          o.context ?? null,
          o.confidence,
        );
      }
    });
    insertMany(occs);
  }

  getOccurrencesByName(name: string): (OccurrenceRow & { id: number })[] {
    return this.db
      .prepare('SELECT * FROM occurrences WHERE name = ?')
      .all(name) as (OccurrenceRow & { id: number })[];
  }

  getOccurrencesByFileId(fileId: number): (OccurrenceRow & { id: number })[] {
    return this.db
      .prepare('SELECT * FROM occurrences WHERE file_id = ?')
      .all(fileId) as (OccurrenceRow & { id: number })[];
  }

  getOccurrencesInRange(
    fileId: number,
    startLine: number,
    endLine: number,
  ): (OccurrenceRow & { id: number })[] {
    return this.db
      .prepare(
        `SELECT *
         FROM occurrences
         WHERE file_id = ?
           AND line BETWEEN ? AND ?
         ORDER BY line, col`,
      )
      .all(fileId, startLine, endLine) as (OccurrenceRow & { id: number })[];
  }

  findSymbolsByNames(names: string[]): SymbolWithFile[] {
    if (names.length === 0) return [];

    const placeholders = names.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT s.*, f.path AS file_path, f.language AS file_language
         FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE s.name IN (${placeholders})
         ORDER BY s.name, f.path, s.line, s.col`,
      )
      .all(...names) as SymbolWithFile[];
  }

  // ── Index Runs ──────────────────────────────────────────────────────

  insertIndexRun(run: IndexRunRow): number {
    const result = this.db
      .prepare(
        `INSERT INTO index_runs (started_at, completed_at, mode, files_scanned, files_indexed, files_skipped, files_errored, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.started_at,
        run.completed_at ?? null,
        run.mode,
        run.files_scanned,
        run.files_indexed,
        run.files_skipped,
        run.files_errored,
        run.status,
      );
    return Number(result.lastInsertRowid);
  }

  updateIndexRun(
    id: number,
    updates: Partial<Pick<IndexRunRow, 'completed_at' | 'files_scanned' | 'files_indexed' | 'files_skipped' | 'files_errored' | 'status'>>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      sets.push(`${key} = ?`);
      values.push(value);
    }

    if (sets.length === 0) return;
    values.push(id);

    this.db
      .prepare(`UPDATE index_runs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  getLastIndexRun(): (IndexRunRow & { id: number }) | undefined {
    return this.db
      .prepare('SELECT * FROM index_runs ORDER BY id DESC LIMIT 1')
      .get() as (IndexRunRow & { id: number }) | undefined;
  }

  // ── Bulk Operations (Phase 2 of Two-Phase Indexing) ─────────────────

  /**
   * Atomically publish a batch of file data within a single transaction.
   * Deletes old rows for given file IDs (CASCADE removes children),
   * then inserts new file + symbol + edge + occurrence rows.
   */
  publishBatch(
    deleteFileIds: number[],
    files: FileRow[],
    symbolsByFile: Map<number, SymbolRow[]>,
    edgesByFile: Map<number, ModuleEdgeRow[]>,
    occurrencesByFile: Map<number, OccurrenceRow[]>,
  ): Map<string, number> {
    const fileIdMap = new Map<string, number>();

    const publish = this.db.transaction(() => {
      // Delete stale files (CASCADE removes symbols, edges, occurrences)
      if (deleteFileIds.length > 0) {
        this.deleteFilesByIds(deleteFileIds);
      }

      // Insert new files and map path_key → new ID
      for (const file of files) {
        const newId = this.insertFile(file);
        fileIdMap.set(file.path_key, newId);
      }

      // Insert symbols, edges, occurrences using the temporary index key
      // (callers put a placeholder file_id that maps to the path_key index)
      for (const [_tempId, symbols] of symbolsByFile) {
        if (symbols.length > 0) {
          this.insertSymbols(symbols);
        }
      }

      for (const [_tempId, edges] of edgesByFile) {
        if (edges.length > 0) {
          this.insertModuleEdges(edges);
        }
      }

      for (const [_tempId, occs] of occurrencesByFile) {
        if (occs.length > 0) {
          this.insertOccurrences(occs);
        }
      }
    });

    publish();
    return fileIdMap;
  }

  // ── Aggregate Queries ───────────────────────────────────────────────

  getFileCount(): { total: number; indexed: number; skipped: number; errored: number } {
    const total = (
      this.db.prepare('SELECT COUNT(*) as count FROM files').get() as {
        count: number;
      }
    ).count;
    const indexed = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM files WHERE status = 'indexed'")
        .get() as { count: number }
    ).count;
    const skipped = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM files WHERE status = 'skipped'")
        .get() as { count: number }
    ).count;
    const errored = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM files WHERE status = 'error'")
        .get() as { count: number }
    ).count;

    return { total, indexed, skipped, errored };
  }

  getSymbolCount(): number {
    return (
      this.db.prepare('SELECT COUNT(*) as count FROM symbols').get() as {
        count: number;
      }
    ).count;
  }

  getLanguageStats(): Record<string, { files: number; symbols: number }> {
    const rows = this.db
      .prepare(
        `SELECT f.language, COUNT(DISTINCT f.id) as file_count, COUNT(s.id) as symbol_count
         FROM files f
         LEFT JOIN symbols s ON s.file_id = f.id
         WHERE f.status = 'indexed'
         GROUP BY f.language`,
      )
      .all() as { language: string; file_count: number; symbol_count: number }[];

    const stats: Record<string, { files: number; symbols: number }> = {};
    for (const row of rows) {
      stats[row.language] = {
        files: row.file_count,
        symbols: row.symbol_count,
      };
    }
    return stats;
  }

  hasErrors(): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM files WHERE status = 'error'")
      .get() as { count: number };
    return row.count > 0;
  }

  // ── Transaction Support ──────────────────────────────────────────────

  /**
   * Run a function inside a BEGIN IMMEDIATE transaction.
   * Used by the orchestrator for Phase 2 atomic writes.
   */
  runInTransaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped.immediate();
  }
}
