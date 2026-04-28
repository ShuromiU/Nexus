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
  ref_kind?: string | null;
}

/**
 * Joined relation_edge row — fully expanded with source/target symbol +
 * file info. Used by query layer; not a storage shape.
 */
export interface RelationJoinedRow {
  id: number;
  kind: string;
  target_name: string;
  line: number;
  confidence: string;
  source_id: number;
  source_name: string;
  source_kind: string;
  source_line: number;
  source_file: string;
  target_id: number | null;
  target_resolved_name: string | null;
  target_kind: string | null;
  target_line: number | null;
  target_file: string | null;
}

/**
 * B2 v1: declared structural relationships between symbols.
 * `source_id` always resolves (declaring symbol — same ExtractionResult).
 * `target_id` may be null (unresolved import, dynamic mixin, cross-boundary).
 * `confidence` reserved for future 'derived' edges; v1 only writes 'declared'.
 */
export interface RelationEdgeRow {
  id?: number;
  file_id: number;
  source_id: number;
  kind: string;
  target_name: string;
  target_id?: number | null;
  confidence: string;
  line: number;
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
  private overlayAttached = false;

  constructor(private db: Database.Database) {}

  // ── Overlay attach/detach ──────────────────────────────────────────

  /**
   * Attach an overlay database (read-only) and create TEMP VIEWS named
   * `files`/`symbols`/`module_edges`/`occurrences`/`meta`/`index_runs` that
   * shadow the parent tables with merged content. Parent ids stay positive,
   * overlay ids become negative; cross-file FKs are redirected via path_key
   * joins against `overlay.files` and `overlay.deleted_files`.
   *
   * The parent `db` should be opened read-only; the overlay is attached as a
   * URI with `mode=ro`. After this call, every existing query that selects
   * from the unqualified table names automatically sees merged data — direct
   * SQL like `engine.ts:SELECT * FROM symbols` works without rewriting.
   */
  attachOverlay(overlayPath: string): void {
    if (this.overlayAttached) return;

    // Plain-path ATTACH. better-sqlite3 doesn't enable URI parsing by default,
    // so we can't use `file:...?mode=ro` to enforce read-only at the SQLite
    // level. Defense-in-depth: query code never writes to overlay tables, and
    // the rebuild flow closes this connection before the writer touches the
    // file (see mcp.ts ensureFresh).
    //
    // Path quoting: SQL string literals double-up single quotes. Windows paths
    // contain backslashes which SQLite treats literally — no escaping needed
    // beyond the single-quote pass.
    const safe = overlayPath.replace(/'/g, "''");
    this.db.exec(`ATTACH DATABASE '${safe}' AS overlay`);

    this.db.exec(`
      CREATE TEMP TABLE overlay_path_index AS
        SELECT path, path_key, id AS overlay_file_id FROM overlay.files;
      CREATE INDEX overlay_pi_pk ON overlay_path_index(path_key);

      CREATE TEMP TABLE changed_or_deleted (path TEXT, path_key TEXT PRIMARY KEY);
      INSERT INTO changed_or_deleted SELECT path, path_key FROM overlay.files;
      INSERT OR IGNORE INTO changed_or_deleted SELECT path, path_key FROM overlay.deleted_files;

      DROP VIEW IF EXISTS temp.files;
      CREATE TEMP VIEW files AS
        SELECT id, path, path_key, hash, mtime, size, language, status, error, indexed_at
          FROM main.files
         WHERE path_key NOT IN (SELECT path_key FROM changed_or_deleted)
        UNION ALL
        SELECT -id, path, path_key, hash, mtime, size, language, status, error, indexed_at
          FROM overlay.files;

      DROP VIEW IF EXISTS temp.symbols;
      CREATE TEMP VIEW symbols AS
        SELECT s.id, s.file_id, s.name, s.kind, s.line, s.col, s.end_line, s.signature, s.scope, s.doc
          FROM main.symbols s
          JOIN main.files f ON f.id = s.file_id
         WHERE f.path_key NOT IN (SELECT path_key FROM changed_or_deleted)
        UNION ALL
        SELECT -id, -file_id, name, kind, line, col, end_line, signature, scope, doc
          FROM overlay.symbols;

      DROP VIEW IF EXISTS temp.occurrences;
      CREATE TEMP VIEW occurrences AS
        SELECT o.id, o.file_id, o.name, o.line, o.col, o.context, o.confidence, o.ref_kind
          FROM main.occurrences o
          JOIN main.files f ON f.id = o.file_id
         WHERE f.path_key NOT IN (SELECT path_key FROM changed_or_deleted)
        UNION ALL
        SELECT -id, -file_id, name, line, col, context, confidence, ref_kind
          FROM overlay.occurrences;

      DROP VIEW IF EXISTS temp.module_edges;
      CREATE TEMP VIEW module_edges AS
        SELECT m.id, m.file_id, m.kind, m.name, m.alias, m.source, m.line,
               m.is_default, m.is_star, m.is_type, m.symbol_id,
               CASE
                 WHEN m.resolved_file_id IS NULL THEN NULL
                 WHEN tgt.path_key IN (SELECT path_key FROM overlay.deleted_files) THEN NULL
                 WHEN tgt.path_key IN (SELECT path_key FROM overlay_path_index) THEN
                   (SELECT -opi.overlay_file_id FROM overlay_path_index opi
                     WHERE opi.path_key = tgt.path_key)
                 ELSE m.resolved_file_id
               END AS resolved_file_id
          FROM main.module_edges m
          JOIN main.files src ON src.id = m.file_id
          LEFT JOIN main.files tgt ON tgt.id = m.resolved_file_id
         WHERE src.path_key NOT IN (SELECT path_key FROM changed_or_deleted)
        UNION ALL
        SELECT -m.id, -m.file_id, m.kind, m.name, m.alias, m.source, m.line,
               m.is_default, m.is_star, m.is_type,
               CASE WHEN m.symbol_id IS NULL THEN NULL ELSE -m.symbol_id END,
               CASE
                 WHEN m.resolved_path_key IS NULL THEN NULL
                 WHEN m.resolved_path_key IN (SELECT path_key FROM overlay_path_index) THEN
                   (SELECT -opi.overlay_file_id FROM overlay_path_index opi
                     WHERE opi.path_key = m.resolved_path_key)
                 WHEN m.resolved_path_key IN (SELECT path_key FROM overlay.deleted_files) THEN NULL
                 ELSE (SELECT id FROM main.files WHERE path_key = m.resolved_path_key)
               END AS resolved_file_id
          FROM overlay.module_edges m;

      DROP VIEW IF EXISTS temp.meta;
      CREATE TEMP VIEW meta AS
        SELECT key, value FROM main.meta
         WHERE key NOT IN ('git_head', 'root_path', 'index_mode', 'last_indexed_at')
        UNION ALL
        SELECT key, value FROM overlay.meta
         WHERE key IN ('git_head', 'root_path', 'index_mode', 'last_indexed_at',
                       'parent_git_head', 'parent_index_path', 'built_at', 'degraded_reason');

      DROP VIEW IF EXISTS temp.index_runs;
      CREATE TEMP VIEW index_runs AS
        SELECT * FROM overlay.index_runs;
    `);
    this.overlayAttached = true;
  }

  detachOverlay(): void {
    if (!this.overlayAttached) return;
    try {
      this.db.exec(`
        DROP VIEW IF EXISTS temp.index_runs;
        DROP VIEW IF EXISTS temp.meta;
        DROP VIEW IF EXISTS temp.module_edges;
        DROP VIEW IF EXISTS temp.occurrences;
        DROP VIEW IF EXISTS temp.symbols;
        DROP VIEW IF EXISTS temp.files;
        DROP TABLE IF EXISTS temp.changed_or_deleted;
        DROP TABLE IF EXISTS temp.overlay_path_index;
      `);
      this.db.exec(`DETACH DATABASE overlay`);
    } finally {
      this.overlayAttached = false;
    }
  }

  hasOverlayAttached(): boolean {
    return this.overlayAttached;
  }

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

  /**
   * Insert symbol rows; returns the inserted ids in input order.
   * The caller wraps in a transaction (orchestrator does this).
   */
  insertSymbols(symbols: SymbolRow[]): number[] {
    const stmt = this.db.prepare(
      `INSERT INTO symbols (file_id, name, kind, line, col, end_line, signature, scope, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: number[] = [];
    for (const s of symbols) {
      const r = stmt.run(
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
      ids.push(Number(r.lastInsertRowid));
    }
    return ids;
  }

  insertRelationEdges(rows: { file_id: number; source_id: number; kind: string;
                              target_name: string; target_id: number | null;
                              confidence: string; line: number }[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO relation_edges (file_id, source_id, kind, target_name, target_id, confidence, line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      stmt.run(r.file_id, r.source_id, r.kind, r.target_name, r.target_id, r.confidence, r.line);
    }
  }

  /**
   * Set target_id for a relation edge after-the-fact (used by cross-file
   * resolution pass). NULL clears the link.
   */
  updateRelationTargetId(edgeId: number, targetId: number | null): void {
    this.db.prepare('UPDATE relation_edges SET target_id = ? WHERE id = ?').run(targetId, edgeId);
  }

  /** Edges whose target_id is still unresolved — used by cross-file resolver. */
  getUnresolvedRelationEdges(): { id: number; file_id: number; target_name: string; kind: string }[] {
    return this.db.prepare(
      'SELECT id, file_id, target_name, kind FROM relation_edges WHERE target_id IS NULL'
    ).all() as { id: number; file_id: number; target_name: string; kind: string }[];
  }

  /**
   * Find a top-level class/interface/type symbol by file + name. Used by
   * cross-file relation resolution: given an imported name, find the symbol
   * declaration in the importer's source file.
   */
  findTopLevelTypeByFileAndName(fileId: number, name: string): number | null {
    const row = this.db.prepare(
      `SELECT id FROM symbols
       WHERE file_id = ? AND name = ? AND kind IN ('class', 'interface', 'type')
       AND (scope IS NULL OR scope = '')
       ORDER BY id ASC LIMIT 1`
    ).get(fileId, name) as { id: number } | undefined;
    return row?.id ?? null;
  }

  // ── Relation edges queries (B2 v1) ──────────────────────────────────

  /**
   * Edges declared by a symbol — i.e., what does `name` extend or implement?
   * Joins source/target symbols + files for ergonomic display.
   */
  getRelationsBySource(name: string, kind?: string): RelationJoinedRow[] {
    const params: unknown[] = [name];
    let sql = `
      SELECT
        r.id AS id,
        r.kind AS kind,
        r.target_name AS target_name,
        r.line AS line,
        r.confidence AS confidence,
        ss.id AS source_id,
        ss.name AS source_name,
        ss.kind AS source_kind,
        ss.line AS source_line,
        sf.path AS source_file,
        ts.id AS target_id,
        ts.name AS target_resolved_name,
        ts.kind AS target_kind,
        ts.line AS target_line,
        tf.path AS target_file
      FROM relation_edges r
      JOIN symbols ss ON r.source_id = ss.id
      JOIN files sf ON ss.file_id = sf.id
      LEFT JOIN symbols ts ON r.target_id = ts.id
      LEFT JOIN files tf ON ts.file_id = tf.id
      WHERE ss.name = ?
    `;
    if (kind) { sql += ' AND r.kind = ?'; params.push(kind); }
    sql += ' ORDER BY sf.path, r.line';
    return this.db.prepare(sql).all(...params) as RelationJoinedRow[];
  }

  /**
   * Edges that target a symbol — i.e., who extends or implements `name`?
   * Matches by either resolved target_id (joined back through symbols) or
   * by target_name (covers unresolved cross-boundary targets).
   */
  getRelationsByTarget(name: string, kind?: string): RelationJoinedRow[] {
    const params: unknown[] = [name, name];
    let sql = `
      SELECT
        r.id AS id,
        r.kind AS kind,
        r.target_name AS target_name,
        r.line AS line,
        r.confidence AS confidence,
        ss.id AS source_id,
        ss.name AS source_name,
        ss.kind AS source_kind,
        ss.line AS source_line,
        sf.path AS source_file,
        ts.id AS target_id,
        ts.name AS target_resolved_name,
        ts.kind AS target_kind,
        ts.line AS target_line,
        tf.path AS target_file
      FROM relation_edges r
      JOIN symbols ss ON r.source_id = ss.id
      JOIN files sf ON ss.file_id = sf.id
      LEFT JOIN symbols ts ON r.target_id = ts.id
      LEFT JOIN files tf ON ts.file_id = tf.id
      WHERE (ts.name = ? OR (ts.name IS NULL AND r.target_name = ?))
    `;
    if (kind) { sql += ' AND r.kind = ?'; params.push(kind); }
    sql += ' ORDER BY sf.path, r.line';
    return this.db.prepare(sql).all(...params) as RelationJoinedRow[];
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

  getOccurrencesWithFileFiltered(
    name: string,
    refKinds: string[] | undefined,
  ): OccurrenceWithFile[] {
    if (!refKinds || refKinds.length === 0) {
      return this.getOccurrencesWithFile(name);
    }
    const placeholders = refKinds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT o.*, f.path AS file_path
         FROM occurrences o JOIN files f ON o.file_id = f.id
         WHERE o.name = ? AND o.ref_kind IN (${placeholders})`,
      )
      .all(name, ...refKinds) as OccurrenceWithFile[];
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
        `INSERT INTO occurrences (file_id, name, line, col, context, confidence, ref_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        occ.file_id,
        occ.name,
        occ.line,
        occ.col,
        occ.context ?? null,
        occ.confidence,
        occ.ref_kind ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  insertOccurrences(occs: OccurrenceRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO occurrences (file_id, name, line, col, context, confidence, ref_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
          o.ref_kind ?? null,
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

  /**
   * Same as getOccurrencesByName, but narrows to rows whose ref_kind is in
   * the given list. A NULL ref_kind never matches a filter — pass undefined
   * to include all rows including legacy NULLs.
   */
  getOccurrencesByNameFiltered(
    name: string,
    refKinds: string[] | undefined,
  ): (OccurrenceRow & { id: number })[] {
    if (!refKinds || refKinds.length === 0) {
      return this.getOccurrencesByName(name);
    }
    const placeholders = refKinds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT * FROM occurrences
         WHERE name = ? AND ref_kind IN (${placeholders})`,
      )
      .all(name, ...refKinds) as (OccurrenceRow & { id: number })[];
  }

  /**
   * Same as getOccurrencesInRange, but narrows to rows whose ref_kind is in
   * the given list. Pass undefined to include all rows.
   */
  getOccurrencesInRangeFiltered(
    fileId: number,
    startLine: number,
    endLine: number,
    refKinds: string[] | undefined,
  ): (OccurrenceRow & { id: number })[] {
    if (!refKinds || refKinds.length === 0) {
      return this.getOccurrencesInRange(fileId, startLine, endLine);
    }
    const placeholders = refKinds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT * FROM occurrences
         WHERE file_id = ?
           AND line BETWEEN ? AND ?
           AND ref_kind IN (${placeholders})
         ORDER BY line, col`,
      )
      .all(fileId, startLine, endLine, ...refKinds) as (OccurrenceRow & { id: number })[];
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

  /**
   * Find the smallest symbol whose [line, end_line] range contains `line`.
   * Used by callers/definition_at to identify the function/class enclosing a position.
   */
  getEnclosingSymbol(
    fileId: number,
    line: number,
  ): (SymbolRow & { id: number }) | undefined {
    return this.db
      .prepare(
        `SELECT *
         FROM symbols
         WHERE file_id = ?
           AND line <= ?
           AND end_line IS NOT NULL
           AND end_line >= ?
         ORDER BY (end_line - line) ASC
         LIMIT 1`,
      )
      .get(fileId, line, line) as (SymbolRow & { id: number }) | undefined;
  }

  /**
   * All exports across the index (kind='export' module edges joined to file).
   * Optional path prefix filter. Excludes re-exports — those are pass-throughs.
   */
  getAllExports(pathPrefix?: string): {
    file_id: number;
    file_path: string;
    name: string;
    line: number;
    symbol_id: number | null;
    is_default: number;
    is_star: number;
  }[] {
    const sql = `
      SELECT e.file_id, f.path AS file_path, e.name, e.line, e.symbol_id,
             e.is_default, e.is_star
      FROM module_edges e
      JOIN files f ON e.file_id = f.id
      WHERE e.kind = 'export'
        AND e.name IS NOT NULL
        ${pathPrefix ? 'AND f.path LIKE ?' : ''}
      ORDER BY f.path, e.line`;
    const params = pathPrefix ? [`${pathPrefix}%`] : [];
    return this.db.prepare(sql).all(...params) as ReturnType<NexusStore['getAllExports']>;
  }

  /**
   * List symbols of a kind, optionally restricted to files under a path prefix.
   */
  getSymbolsByKindAndPath(kind: string, pathPrefix?: string): SymbolWithFile[] {
    if (pathPrefix) {
      return this.db
        .prepare(
          `SELECT s.*, f.path AS file_path, f.language AS file_language
           FROM symbols s
           JOIN files f ON s.file_id = f.id
           WHERE s.kind = ?
             AND f.path LIKE ?
           ORDER BY f.path, s.line, s.col`,
        )
        .all(kind, `${pathPrefix}%`) as SymbolWithFile[];
    }
    return this.db
      .prepare(
        `SELECT s.*, f.path AS file_path, f.language AS file_language
         FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE s.kind = ?
         ORDER BY f.path, s.line, s.col`,
      )
      .all(kind) as SymbolWithFile[];
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
