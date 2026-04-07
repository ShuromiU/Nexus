import type Database from 'better-sqlite3';
import { NexusStore } from '../db/store.js';
import type { SymbolRow, FileRow, ModuleEdgeRow } from '../db/store.js';
import { getAllAdapters } from '../analysis/languages/registry.js';
import { SCHEMA_VERSION, EXTRACTOR_VERSION } from '../db/schema.js';
import { fuzzyScore, rankResults } from './ranking.js';

// ── Result Types ──────────────────────────────────────────────────────

export interface NexusResult<T> {
  query: string;
  type: 'find' | 'occurrences' | 'exports' | 'imports' | 'tree' | 'search' | 'stats';
  results: T[];
  count: number;
  index_status: 'current' | 'stale' | 'reindexing';
  index_health: 'ok' | 'partial';
  timing_ms: number;
}

export interface SymbolResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  col: number;
  end_line?: number;
  signature?: string;
  scope?: string;
  doc?: string;
  language: string;
}

export interface OccurrenceResult {
  name: string;
  file: string;
  line: number;
  col: number;
  context: string;
  confidence: 'exact' | 'heuristic';
}

export interface ModuleEdgeResult {
  kind: 'import' | 'export' | 're-export';
  name: string | null;
  alias?: string;
  source?: string;
  line: number;
  is_default: boolean;
  is_star: boolean;
  is_type: boolean;
}

export interface ImporterResult {
  file: string;
  language: string;
  source: string;
  line: number;
  names: string[];
  is_type: boolean;
  is_default: boolean;
  is_star: boolean;
}

export interface TreeEntry {
  path: string;
  language: string;
  symbol_count: number;
  exports: string[];
  status: 'indexed' | 'skipped' | 'error';
}

export interface IndexStats {
  root: string;
  files: { total: number; indexed: number; skipped: number; errored: number };
  symbols_total: number;
  languages: Record<string, {
    files: number;
    symbols: number;
    capabilities: {
      definitions: true;
      imports: boolean;
      exports: boolean;
      occurrences: boolean;
      occurrenceQuality: 'exact' | 'heuristic';
      typeExports: boolean;
      docstrings: boolean;
      signatures: boolean;
    };
  }>;
  index_status: 'current' | 'stale' | 'reindexing';
  index_health: 'ok' | 'partial';
  last_indexed_at: string;
  schema_version: number;
  extractor_version: number;
}

// ── Query Engine ──────────────────────────────────────────────────────

export class QueryEngine {
  private store: NexusStore;
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.store = new NexusStore(db);
  }

  /**
   * Find symbols by name, optionally filtered by kind.
   * Tries exact match first, then case-insensitive fallback.
   */
  find(name: string, kind?: string): NexusResult<SymbolResult> {
    const start = performance.now();

    // Try exact match first
    let rows = kind
      ? this.store.getSymbolsByNameAndKind(name, kind)
      : this.store.getSymbolsByName(name);

    // Fall back to case-insensitive if exact match returns nothing
    if (rows.length === 0) {
      rows = this.store.getSymbolsByNameCaseInsensitive(name);
      if (kind) {
        rows = rows.filter(r => r.kind === kind);
      }
    }

    const results: SymbolResult[] = rows.map(row => this.symbolRowToResult(row));

    return this.wrap('find', `find ${name}${kind ? ` --kind ${kind}` : ''}`, results, start);
  }

  /**
   * List all symbols in a file, optionally filtered by kind.
   */
  symbols(filePath: string, kind?: string): NexusResult<SymbolResult> {
    const start = performance.now();
    const file = this.findFile(filePath);

    if (!file) {
      return this.wrap('find', `symbols ${filePath}`, [], start);
    }

    const rows = kind
      ? this.store.getSymbolsByFileIdAndKind(file.id, kind)
      : this.store.getSymbolsByFileId(file.id);

    const results: SymbolResult[] = rows.map(row => ({
      name: row.name,
      kind: row.kind,
      file: file.path,
      line: row.line,
      col: row.col,
      ...(row.end_line != null ? { end_line: row.end_line } : {}),
      ...(row.signature ? { signature: row.signature } : {}),
      ...(row.scope ? { scope: row.scope } : {}),
      ...(row.doc ? { doc: row.doc } : {}),
      language: file.language,
    }));

    return this.wrap('find', `symbols ${filePath}${kind ? ` --kind ${kind}` : ''}`, results, start);
  }

  /**
   * Find all occurrences of an identifier (aliased as `refs`).
   */
  occurrences(name: string): NexusResult<OccurrenceResult> {
    const start = performance.now();

    const rows = this.store.getOccurrencesByName(name);

    const results: OccurrenceResult[] = rows.map(row => {
      const file = this.store.getFileById(row.file_id)!;
      return {
        name: row.name,
        file: file.path,
        line: row.line,
        col: row.col,
        context: row.context ?? '',
        confidence: row.confidence as 'exact' | 'heuristic',
      };
    });

    return this.wrap('occurrences', `refs ${name}`, results, start);
  }

  /**
   * Get all exports (and re-exports) from a file.
   */
  exports(filePath: string): NexusResult<ModuleEdgeResult> {
    const start = performance.now();
    const file = this.findFile(filePath);

    if (!file) {
      return this.wrap('exports', `exports ${filePath}`, [], start);
    }

    const rows = this.store.getExportsByFileId(file.id);
    const results = rows.map(edgeToResult);

    return this.wrap('exports', `exports ${filePath}`, results, start);
  }

  /**
   * Get all imports for a file.
   */
  imports(filePath: string): NexusResult<ModuleEdgeResult> {
    const start = performance.now();
    const file = this.findFile(filePath);

    if (!file) {
      return this.wrap('imports', `imports ${filePath}`, [], start);
    }

    const rows = this.store.getImportsByFileId(file.id);
    const results = rows.map(edgeToResult);

    return this.wrap('imports', `imports ${filePath}`, results, start);
  }

  /**
   * Find all files that import from a given source module.
   * Tries exact match first, then substring (LIKE) fallback.
   */
  importers(source: string): NexusResult<ImporterResult> {
    const start = performance.now();

    // Try exact match first
    let rows = this.store.getImportsBySourceExact(source);

    // Fallback to substring match if no exact hits
    if (rows.length === 0) {
      rows = this.store.getImportsBySourceLike(source);
    }

    // Group by file_id → one result per file
    const byFile = new Map<number, typeof rows>();
    for (const row of rows) {
      const arr = byFile.get(row.file_id) ?? [];
      arr.push(row);
      byFile.set(row.file_id, arr);
    }

    const results: ImporterResult[] = [];
    for (const [fileId, edges] of byFile) {
      const file = this.store.getFileById(fileId);
      if (!file) continue;

      const names = edges
        .map(e => e.name ?? (e.is_star ? '*' : null))
        .filter((n): n is string => n !== null);

      results.push({
        file: file.path,
        language: file.language,
        source: edges[0].source ?? source,
        line: edges[0].line,
        names,
        is_type: edges.every(e => !!e.is_type),
        is_default: edges.some(e => !!e.is_default),
        is_star: edges.some(e => !!e.is_star),
      });
    }

    // Sort by file path for deterministic output
    results.sort((a, b) => a.file.localeCompare(b.file));

    return this.wrap('imports', `importers ${source}`, results, start);
  }

  /**
   * List indexed files under a path prefix with export summaries.
   */
  tree(pathPrefix?: string): NexusResult<TreeEntry> {
    const start = performance.now();

    let files = this.store.getAllFiles();

    if (pathPrefix) {
      const prefix = normalizePath(pathPrefix);
      files = files.filter(f => normalizePath(f.path).startsWith(prefix));
    }

    // Sort by path for consistent tree output
    files.sort((a, b) => a.path.localeCompare(b.path));

    const results: TreeEntry[] = files.map(f => {
      const exports = this.store.getExportsByFileId(f.id);
      const exportNames = exports
        .map(e => e.name ?? (e.is_default ? '<default>' : e.is_star ? '*' : null))
        .filter((n): n is string => n !== null);
      const symbolCount = this.store.getSymbolsByFileId(f.id).length;

      return {
        path: f.path,
        language: f.language,
        symbol_count: symbolCount,
        exports: exportNames,
        status: f.status as 'indexed' | 'skipped' | 'error',
      };
    });

    return this.wrap('tree', `tree${pathPrefix ? ` ${pathPrefix}` : ''}`, results, start);
  }

  /**
   * Fuzzy search across symbol names, optionally filtered by kind.
   */
  search(query: string, limit = 20, kind?: string): NexusResult<SymbolResult & { _score: number }> {
    const start = performance.now();

    // Get symbols — filter by kind in SQL when possible
    const allSymbols = kind
      ? this.db.prepare('SELECT * FROM symbols WHERE kind = ?').all(kind) as (SymbolRow & { id: number })[]
      : this.db.prepare('SELECT * FROM symbols').all() as (SymbolRow & { id: number })[];

    const scored: (SymbolResult & { _score: number })[] = [];

    for (const row of allSymbols) {
      const match = fuzzyScore(query, row.name);
      if (!match.matched) continue;

      const file = this.store.getFileById(row.file_id);
      if (!file) continue;

      scored.push({
        ...this.symbolRowToResult(row),
        _score: match.score,
      });
    }

    const ranked = rankResults(scored).slice(0, limit);

    return this.wrap('search', `search ${query}`, ranked, start);
  }

  /**
   * Full index summary with per-language capabilities.
   */
  stats(): NexusResult<IndexStats> {
    const start = performance.now();

    const fileCounts = this.store.getFileCount();
    const symbolCount = this.store.getSymbolCount();
    const langStats = this.store.getLanguageStats();
    const root = this.store.getMeta('root_path') ?? '';
    const lastIndexed = this.store.getMeta('last_indexed_at') ?? '';
    const { status, health } = this.getIndexState();

    // Build language map with capabilities from registered adapters
    const adapters = getAllAdapters();
    const adapterMap = new Map(adapters.map(a => [a.language, a.capabilities]));

    const languages: IndexStats['languages'] = {};
    for (const [lang, counts] of Object.entries(langStats)) {
      const caps = adapterMap.get(lang);
      languages[lang] = {
        files: counts.files,
        symbols: counts.symbols,
        capabilities: caps ?? {
          definitions: true as const,
          imports: false,
          exports: false,
          occurrences: false,
          occurrenceQuality: 'heuristic' as const,
          typeExports: false,
          docstrings: false,
          signatures: false,
        },
      };
    }

    const statsResult: IndexStats = {
      root,
      files: fileCounts,
      symbols_total: symbolCount,
      languages,
      index_status: status,
      index_health: health,
      last_indexed_at: lastIndexed,
      schema_version: SCHEMA_VERSION,
      extractor_version: EXTRACTOR_VERSION,
    };

    return this.wrap('stats', 'stats', [statsResult], start);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private symbolRowToResult(row: SymbolRow & { id: number }): SymbolResult {
    const file = this.store.getFileById(row.file_id)!;
    return {
      name: row.name,
      kind: row.kind,
      file: file.path,
      line: row.line,
      col: row.col,
      ...(row.end_line != null ? { end_line: row.end_line } : {}),
      ...(row.signature ? { signature: row.signature } : {}),
      ...(row.scope ? { scope: row.scope } : {}),
      ...(row.doc ? { doc: row.doc } : {}),
      language: file.language,
    };
  }

  /**
   * Find a file row by path or path_key. Tries exact match first,
   * then case-insensitive, then suffix match (for partial paths).
   */
  private findFile(filePath: string): (FileRow & { id: number }) | undefined {
    const normalized = normalizePath(filePath);

    // Try exact path_key
    const exact = this.store.getFileByPathKey(normalized);
    if (exact) return exact;

    // Try lowercase
    const lower = this.store.getFileByPathKey(normalized.toLowerCase());
    if (lower) return lower;

    // Suffix match: find files whose path ends with the given path
    const allFiles = this.store.getAllFiles();
    return allFiles.find(f =>
      normalizePath(f.path).endsWith(normalized) ||
      normalizePath(f.path).endsWith(normalized.toLowerCase()),
    );
  }

  /**
   * Determine index freshness and health.
   */
  private getIndexState(): { status: 'current' | 'stale' | 'reindexing'; health: 'ok' | 'partial' } {
    const lastRun = this.store.getLastIndexRun();
    let status: 'current' | 'stale' | 'reindexing' = 'stale';

    if (lastRun) {
      if (lastRun.status === 'running') {
        status = 'reindexing';
      } else if (lastRun.status === 'completed') {
        status = 'current';
      }
    }

    const health: 'ok' | 'partial' = this.store.hasErrors() ? 'partial' : 'ok';

    return { status, health };
  }

  /**
   * Wrap results in the NexusResult envelope.
   */
  private wrap<T>(
    type: NexusResult<T>['type'],
    query: string,
    results: T[],
    startTime: number,
  ): NexusResult<T> {
    const { status, health } = this.getIndexState();
    return {
      query,
      type,
      results,
      count: results.length,
      index_status: status,
      index_health: health,
      timing_ms: Math.round((performance.now() - startTime) * 100) / 100,
    };
  }
}

// ── Module-level helpers ──────────────────────────────────────────────

function edgeToResult(edge: ModuleEdgeRow & { id: number }): ModuleEdgeResult {
  return {
    kind: edge.kind as ModuleEdgeResult['kind'],
    name: edge.name ?? null,
    ...(edge.alias ? { alias: edge.alias } : {}),
    ...(edge.source ? { source: edge.source } : {}),
    line: edge.line,
    is_default: !!edge.is_default,
    is_star: !!edge.is_star,
    is_type: !!edge.is_type,
  };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}
