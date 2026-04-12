import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { NexusStore } from '../db/store.js';
import type { SymbolRow, FileRow, ModuleEdgeRow, SymbolWithFile, OccurrenceWithFile, ImportEdgeWithFile } from '../db/store.js';
import { getAllAdapters } from '../analysis/languages/registry.js';
import { SCHEMA_VERSION, EXTRACTOR_VERSION } from '../db/schema.js';
import { fuzzyScore, multiFieldScore, getSuggestions, rankResults } from './ranking.js';

// ── Result Types ──────────────────────────────────────────────────────

export interface NexusResult<T> {
  query: string;
  type: 'find' | 'occurrences' | 'exports' | 'imports' | 'tree' | 'search' | 'stats' | 'grep' | 'outline' | 'source' | 'deps' | 'slice';
  results: T[];
  count: number;
  suggestions?: string[];
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

export interface GrepResult {
  file: string;
  line: number;
  col: number;
  match: string;
  context: string;
  language: string;
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

export interface OutlineEntry {
  name: string;
  kind: string;
  line: number;
  end_line?: number;
  signature?: string;
  doc_summary?: string;
  children?: OutlineEntry[];
}

export interface OutlineResult {
  file: string;
  language: string;
  lines: number;
  imports: { source: string; names: string[]; is_type: boolean }[];
  exports: string[];
  outline: OutlineEntry[];
}

export interface BatchOutlineResult {
  outlines: Record<string, OutlineResult>;
  missing?: string[];
}

export interface SourceResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  end_line: number;
  language: string;
  source: string;
  signature?: string;
  doc?: string;
}

export interface SliceResult {
  root: SourceResult;
  references: SourceResult[];
  disambiguation?: SymbolResult[];
  truncated?: boolean;
}

export interface DepNode {
  file: string;
  language: string;
  exports?: string[];
  deps: DepNode[];
}

export interface DepsResult {
  root: string;
  direction: 'imports' | 'importers';
  depth: number;
  tree: DepNode;
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

    // Try exact match first (single JOIN query instead of N+1)
    let joined = this.store.getSymbolsWithFile(name, kind);

    // Fall back to case-insensitive if exact match returns nothing
    if (joined.length === 0) {
      joined = this.store.getSymbolsWithFileCaseInsensitive(name, kind);
    }

    const results: SymbolResult[] = joined.map(row => symbolWithFileToResult(row));

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

    const rows = this.store.getOccurrencesWithFile(name);

    const results: OccurrenceResult[] = rows.map(row => ({
      name: row.name,
      file: row.file_path,
      line: row.line,
      col: row.col,
      context: row.context ?? '',
      confidence: row.confidence as 'exact' | 'heuristic',
    }));

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

    // Try resolved_file_id first (precise, uses indexed edges from Phase 3)
    const targetFile = this.findFile(source);
    let rows: ImportEdgeWithFile[] = [];
    if (targetFile) {
      rows = this.store.getImportersByResolvedFileId(targetFile.id);
    }

    // Fall back to source string matching if resolution didn't find anything
    if (rows.length === 0) {
      rows = this.store.getImportEdgesWithFile(source);
    }

    // Fallback to substring match if no exact hits
    if (rows.length === 0) {
      rows = this.store.getImportEdgesWithFileLike(source);
    }

    // Group by file_id → one result per file
    const byFile = new Map<number, ImportEdgeWithFile[]>();
    for (const row of rows) {
      const arr = byFile.get(row.file_id) ?? [];
      arr.push(row);
      byFile.set(row.file_id, arr);
    }

    const results: ImporterResult[] = [];
    for (const [_fileId, edges] of byFile) {
      const names = edges
        .map(e => e.name ?? (e.is_star ? '*' : null))
        .filter((n): n is string => n !== null);

      results.push({
        file: edges[0].file_path,
        language: edges[0].file_language,
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

    const prefix = pathPrefix ? normalizePath(pathPrefix) : undefined;
    const treeRows = this.store.getTreeData(prefix);

    // Batch-fetch export names for all files in one query
    const fileIds = treeRows.map(r => r.id);
    const exportsByFile = this.store.getExportNamesByFileIds(fileIds);

    const results: TreeEntry[] = treeRows.map(f => ({
      path: f.path,
      language: f.language,
      symbol_count: f.symbol_count,
      exports: exportsByFile.get(f.id) ?? [],
      status: f.status as 'indexed' | 'skipped' | 'error',
    }));

    return this.wrap('tree', `tree${pathPrefix ? ` ${pathPrefix}` : ''}`, results, start);
  }

  /**
   * Fuzzy search across symbol names, file paths, scopes, and docstrings.
   * Single-word queries match symbol names first, with path/doc fallback.
   * Multi-word queries tokenize and match each token across all fields.
   * Returns "did you mean?" suggestions when no results are found.
   */
  search(
    query: string,
    limit = 20,
    kind?: string,
    pathPrefix?: string,
  ): NexusResult<SymbolResult & { _score: number }> {
    const start = performance.now();
    const trimmed = query.trim();
    const isMultiWord = trimmed.includes(' ');
    const tokens = isMultiWord ? trimmed.split(/\s+/).filter(t => t.length > 0) : [trimmed];
    const normalizedPathPrefix = pathPrefix ? normalizePath(pathPrefix).toLowerCase() : null;

    // Get symbols — filter by kind in SQL when possible
    const allSymbols = kind
      ? this.db.prepare('SELECT * FROM symbols WHERE kind = ?').all(kind) as (SymbolRow & { id: number })[]
      : this.db.prepare('SELECT * FROM symbols').all() as (SymbolRow & { id: number })[];

    // Pre-load file map for path-based scoring (avoids N+1 queries)
    const fileMap = new Map<number, FileRow & { id: number }>();
    for (const f of this.store.getAllFiles()) {
      fileMap.set(f.id, f);
    }

    const scored: (SymbolResult & { _score: number })[] = [];

    for (const row of allSymbols) {
      const file = fileMap.get(row.file_id);
      if (!file) continue;
      if (
        normalizedPathPrefix &&
        !normalizePath(file.path).toLowerCase().startsWith(normalizedPathPrefix)
      ) {
        continue;
      }

      // Extract searchable path basename: "KanbanBoard" from "components/KanbanBoard.tsx"
      const pathSegments = file.path.split(/[\\/]/);
      const basename = pathSegments[pathSegments.length - 1]?.replace(/\.[^.]+$/, '') ?? '';
      // Truncate doc to first 200 chars to avoid noise from long docstrings
      const docSnippet = row.doc ? row.doc.slice(0, 200) : '';

      let matchScore: number;

      if (isMultiWord) {
        // Multi-word: match tokens across name, path, scope, doc
        const fields = [
          { text: row.name, weight: 1.0 },
          { text: basename, weight: 0.7 },
          ...(row.scope ? [{ text: row.scope, weight: 0.6 }] : []),
          ...(docSnippet ? [{ text: docSnippet, weight: 0.4 }] : []),
        ];
        const match = multiFieldScore(tokens, fields);
        if (!match.matched) continue;
        matchScore = match.score;
      } else {
        // Single-word: name first, then path/doc fallback
        const nameMatch = fuzzyScore(trimmed, row.name);
        if (nameMatch.matched) {
          matchScore = nameMatch.score;
        } else {
          // Fallback: check basename and docstring
          const pathMatch = fuzzyScore(trimmed, basename);
          const docMatch = docSnippet ? fuzzyScore(trimmed, docSnippet) : { score: 0, matched: false };

          const bestFallback = Math.max(
            pathMatch.matched ? pathMatch.score * 0.7 : 0,
            docMatch.matched ? docMatch.score * 0.4 : 0,
          );
          if (bestFallback === 0) continue;
          matchScore = bestFallback;
        }
      }

      scored.push({
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
        _score: matchScore,
      });
    }

    const ranked = rankResults(scored).slice(0, limit);

    const result = this.wrap(
      'search',
      `search ${query}${kind ? ` --kind ${kind}` : ''}${pathPrefix ? ` --path ${pathPrefix}` : ''}`,
      ranked,
      start,
    );

    // Generate suggestions when no results found
    if (ranked.length === 0) {
      const allNames = allSymbols.map(s => s.name);
      result.suggestions = getSuggestions(trimmed, allNames);
    }

    return result;
  }

  /**
   * Search file contents with regex. Reads indexed files from disk
   * (respects ignore rules via the files table). Use for string literals,
   * CSS values, comments, config values — anything not a symbol name.
   */
  grep(pattern: string, pathPrefix?: string, language?: string, limit = 50): NexusResult<GrepResult> {
    const start = performance.now();

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      return this.wrap('grep', `grep ${pattern}`, [], start);
    }

    const root = this.store.getMeta('root_path') ?? '';
    const files = this.store.getFilePaths({
      language: language ?? undefined,
      pathPrefix: pathPrefix ?? undefined,
    });

    const results: GrepResult[] = [];

    for (const file of files) {
      if (results.length >= limit) break;

      const absPath = path.resolve(root, file.path);
      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue; // file deleted since indexing, skip
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= limit) break;

        const line = lines[i];
        regex.lastIndex = 0;
        const m = regex.exec(line);
        if (m) {
          results.push({
            file: file.path,
            line: i + 1,
            col: m.index,
            match: m[0],
            context: line.length > 200 ? line.slice(0, 200) : line,
            language: file.language,
          });
        }
      }
    }

    return this.wrap('grep', `grep ${pattern}`, results, start);
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

  /**
   * Structural outline of a file: symbols organized by scope, with signatures
   * and line ranges. Replaces reading a full file to understand its structure.
   */
  outline(filePath: string): NexusResult<OutlineResult> {
    const start = performance.now();
    const file = this.findFile(filePath);

    if (!file) {
      return this.wrap('outline', `outline ${filePath}`, [], start);
    }

    // Get all symbols sorted by line
    const symbols = this.store.getSymbolsByFileId(file.id);
    symbols.sort((a, b) => a.line - b.line);

    // Build import summary: group by source
    const importEdges = this.store.getImportsByFileId(file.id);
    const importMap = new Map<string, { names: string[]; is_type: boolean }>();
    for (const edge of importEdges) {
      const src = edge.source ?? '<unknown>';
      const existing = importMap.get(src) ?? { names: [], is_type: true };
      if (edge.name) existing.names.push(edge.name);
      else if (edge.is_star) existing.names.push('*');
      if (!edge.is_type) existing.is_type = false;
      importMap.set(src, existing);
    }
    const imports = [...importMap.entries()].map(([source, info]) => ({
      source,
      names: info.names,
      is_type: info.is_type,
    }));

    // Build export list
    const exportEdges = this.store.getExportsByFileId(file.id);
    const exportNames = exportEdges
      .map(e => e.name ?? (e.is_default ? '<default>' : e.is_star ? '*' : null))
      .filter((n): n is string => n !== null);

    // Build symbol tree: scope=null → top-level, else child of parent
    const topLevel: OutlineEntry[] = [];
    const byName = new Map<string, OutlineEntry>();

    for (const sym of symbols) {
      const entry: OutlineEntry = {
        name: sym.name,
        kind: sym.kind,
        line: sym.line,
        ...(sym.end_line != null ? { end_line: sym.end_line } : {}),
        ...(sym.signature ? { signature: sym.signature } : {}),
        ...(sym.doc ? { doc_summary: sym.doc.split('\n')[0].replace(/^\/\*\*?\s*/, '').replace(/\s*\*\/$/, '').trim() } : {}),
      };

      if (!sym.scope) {
        topLevel.push(entry);
        byName.set(sym.name, entry);
      } else {
        const parent = byName.get(sym.scope);
        if (parent) {
          if (!parent.children) parent.children = [];
          parent.children.push(entry);
        } else {
          topLevel.push(entry);
        }
      }
    }

    // Count lines from disk
    const root = this.store.getMeta('root_path') ?? '';
    let lineCount = 0;
    try {
      const content = fs.readFileSync(path.resolve(root, file.path), 'utf-8');
      lineCount = content.split('\n').length;
    } catch {
      // File may have been deleted since indexing
    }

    const result: OutlineResult = {
      file: file.path,
      language: file.language,
      lines: lineCount,
      imports,
      exports: exportNames,
      outline: topLevel,
    };

    return this.wrap('outline', `outline ${filePath}`, [result], start);
  }

  /**
   * Structural outline for multiple files in one call.
   */
  outlineMany(files: string[]): NexusResult<BatchOutlineResult> {
    const start = performance.now();
    const resolved = new Map<string, OutlineResult>();
    const missing = new Set<string>();

    for (const input of files) {
      const result = this.outline(input);
      if (result.results.length === 0) {
        missing.add(input);
        continue;
      }

      const outline = result.results[0];
      if (!resolved.has(outline.file)) {
        resolved.set(outline.file, outline);
      }
    }

    const outlines: Record<string, OutlineResult> = {};
    for (const filePath of [...resolved.keys()].sort((a, b) => a.localeCompare(b))) {
      outlines[filePath] = resolved.get(filePath)!;
    }

    const missingList = [...missing].sort((a, b) => a.localeCompare(b));
    const { status, health } = this.getIndexState();

    return {
      query: `outline ${files.join(' ')}`,
      type: 'outline',
      results: [{
        outlines,
        ...(missingList.length > 0 ? { missing: missingList } : {}),
      }],
      count: Object.keys(outlines).length,
      index_status: status,
      index_health: health,
      timing_ms: Math.round((performance.now() - start) * 100) / 100,
    };
  }

  /**
   * Extract source code for a specific symbol. Returns just the lines where
   * the symbol is defined, avoiding full file reads.
   */
  source(name: string, filePath?: string): NexusResult<SourceResult> {
    const start = performance.now();

    // Find matching symbols
    let joined = this.store.getSymbolsWithFile(name);
    if (joined.length === 0) {
      joined = this.store.getSymbolsWithFileCaseInsensitive(name);
    }

    // Filter by file if specified
    if (filePath && joined.length > 0) {
      const normalized = normalizePath(filePath);
      const filtered = joined.filter(s =>
        normalizePath(s.file_path).endsWith(normalized),
      );
      if (filtered.length > 0) joined = filtered;
    }

    const root = this.store.getMeta('root_path') ?? '';
    const results: SourceResult[] = [];

    // Group by file to avoid re-reading
    const byFile = new Map<string, typeof joined>();
    for (const sym of joined) {
      const arr = byFile.get(sym.file_path) ?? [];
      arr.push(sym);
      byFile.set(sym.file_path, arr);
    }

    for (const [fp, syms] of byFile) {
      let lines: string[];
      try {
        const content = fs.readFileSync(path.resolve(root, fp), 'utf-8');
        lines = content.split('\n');
      } catch {
        continue; // File deleted since indexing
      }

      // All symbols in this file, sorted by line (for end_line fallback)
      const allFileSymbols = this.store.getSymbolsByFileId(syms[0].file_id);
      allFileSymbols.sort((a, b) => a.line - b.line);

      for (const sym of syms) {
        const startLine = sym.line;
        let endLine = sym.end_line;

        if (endLine == null) {
          const idx = allFileSymbols.findIndex(s => s.id === sym.id);
          if (idx >= 0 && idx < allFileSymbols.length - 1) {
            endLine = allFileSymbols[idx + 1].line - 1;
          } else {
            endLine = Math.min(startLine + 49, lines.length);
          }
        }

        const sourceCode = lines.slice(startLine - 1, endLine).join('\n');

        results.push({
          name: sym.name,
          kind: sym.kind,
          file: fp,
          line: startLine,
          end_line: endLine,
          language: sym.file_language,
          source: sourceCode,
          ...(sym.signature ? { signature: sym.signature } : {}),
          ...(sym.doc ? { doc: sym.doc } : {}),
        });
      }
    }

    results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

    return this.wrap('source', `source ${name}${filePath ? ` --file ${filePath}` : ''}`, results, start);
  }

  /**
   * Extract a symbol and the named symbols it references inside its body.
   * This is a name-based approximation designed to save file reads.
   */
  slice(name: string, opts?: { file?: string; limit?: number }): NexusResult<SliceResult> {
    const start = performance.now();
    let joined = this.store.getSymbolsWithFile(name);
    if (joined.length === 0) {
      joined = this.store.getSymbolsWithFileCaseInsensitive(name);
    }

    if (opts?.file && joined.length > 0) {
      const normalized = normalizePath(opts.file);
      joined = joined.filter(s =>
        normalizePath(s.file_path).endsWith(normalized) ||
        normalizePath(s.file_path).toLowerCase().endsWith(normalized.toLowerCase()),
      );
    }

    if (joined.length === 0) {
      return this.wrap('slice', buildSliceQuery(name, opts), [], start);
    }

    joined.sort(
      (a, b) => a.file_path.localeCompare(b.file_path) || a.line - b.line || a.col - b.col,
    );

    const root = joined[0];
    const rootSource = this.getSourceForSymbol(root);
    if (!rootSource) {
      return this.wrap('slice', buildSliceQuery(name, opts), [], start);
    }

    const occurrences = this.store.getOccurrencesInRange(
      root.file_id,
      rootSource.line,
      rootSource.end_line,
    );
    const referencedNames: string[] = [];
    const seenNames = new Set<string>();

    for (const occ of occurrences) {
      if (occ.name === root.name || occ.name.length <= 1 || seenNames.has(occ.name)) {
        continue;
      }
      seenNames.add(occ.name);
      referencedNames.push(occ.name);
    }

    const importedFileIds = new Set(
      this.store
        .getImportsByFileId(root.file_id)
        .map(edge => edge.resolved_file_id)
        .filter((id): id is number => id != null),
    );
    const matchesByName = new Map<string, SymbolWithFile[]>();
    for (const symbol of this.store.findSymbolsByNames(referencedNames)) {
      if (symbol.id === root.id) continue;
      if (
        symbol.file_id === root.file_id &&
        symbol.line >= rootSource.line &&
        symbol.line <= rootSource.end_line
      ) {
        continue;
      }
      const matches = matchesByName.get(symbol.name) ?? [];
      matches.push(symbol);
      matchesByName.set(symbol.name, matches);
    }

    const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 50);
    const references: SourceResult[] = [];
    const selectedIds = new Set<number>();
    let truncated = false;

    for (const refName of referencedNames) {
      if (references.length >= limit) {
        truncated = true;
        break;
      }

      const candidates = (matchesByName.get(refName) ?? [])
        .slice()
        .sort((a, b) => {
          const aScore = getSlicePreferenceScore(a, root.file_id, importedFileIds);
          const bScore = getSlicePreferenceScore(b, root.file_id, importedFileIds);
          return (
            aScore - bScore ||
            a.file_path.localeCompare(b.file_path) ||
            a.line - b.line ||
            a.col - b.col
          );
        });

      const best = candidates.find(candidate => !selectedIds.has(candidate.id));
      if (!best) continue;

      const reference = this.getSourceForSymbol(best);
      if (!reference) continue;

      references.push(reference);
      selectedIds.add(best.id);
    }

    return this.wrap('slice', buildSliceQuery(name, opts), [{
      root: rootSource,
      references,
      ...(joined.length > 1 && !opts?.file
        ? { disambiguation: joined.slice(1).map(symbolWithFileToResult) }
        : {}),
      ...(truncated ? { truncated: true } : {}),
    }], start);
  }

  /**
   * Transitive dependency graph from a file. Follows imports or importers
   * up to a given depth. Replaces multiple sequential import/importer calls.
   */
  deps(filePath: string, direction: 'imports' | 'importers' = 'imports', depth = 2): NexusResult<DepsResult> {
    const start = performance.now();
    const file = this.findFile(filePath);

    if (!file) {
      return this.wrap('deps', `deps ${filePath}`, [], start);
    }

    const maxDepth = Math.min(depth, 5);
    const visited = new Set<number>();
    const nodeMap = new Map<number, DepNode>();

    const buildNode = (fileId: number, currentDepth: number): DepNode => {
      const f = this.store.getFileById(fileId);
      if (!f) return { file: '<unknown>', language: '', deps: [] };

      visited.add(fileId);
      const node: DepNode = {
        file: f.path,
        language: f.language,
        deps: [],
      };
      nodeMap.set(fileId, node);

      if (currentDepth >= maxDepth) return node;

      let targetIds: number[];
      if (direction === 'imports') {
        const edges = this.store.getImportsByFileId(fileId);
        targetIds = [...new Set(
          edges
            .map(e => e.resolved_file_id)
            .filter((id): id is number => id != null && !visited.has(id)),
        )];
      } else {
        const importerEdges = this.store.getImportersByResolvedFileId(fileId);
        targetIds = [...new Set(
          importerEdges
            .map(e => e.file_id)
            .filter(id => !visited.has(id)),
        )];
      }

      // Mark all targets as visited before processing to preserve
      // direct dependencies (prevent deep traversal from stealing them)
      for (const id of targetIds) {
        visited.add(id);
      }

      for (const targetId of targetIds) {
        node.deps.push(buildNode(targetId, currentDepth + 1));
      }

      return node;
    };

    const tree = buildNode(file.id, 0);

    // Batch-fetch exports for all visited files
    const exportsByFile = this.store.getExportNamesByFileIds([...nodeMap.keys()]);
    for (const [fileId, names] of exportsByFile) {
      const node = nodeMap.get(fileId);
      if (node && names.length > 0) {
        node.exports = names;
      }
    }

    const result: DepsResult = {
      root: file.path,
      direction,
      depth: maxDepth,
      tree,
    };

    return this.wrap('deps', `deps ${filePath}`, [result], start);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

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
   * Read a symbol's source from disk, using the next symbol as an end-line
   * fallback when the extractor did not record one.
   */
  private getSourceForSymbol(symbol: SymbolWithFile): SourceResult | null {
    const root = this.store.getMeta('root_path') ?? '';
    let lines: string[];
    try {
      const content = fs.readFileSync(path.resolve(root, symbol.file_path), 'utf-8');
      lines = content.split('\n');
    } catch {
      return null;
    }

    const allFileSymbols = this.store.getSymbolsByFileId(symbol.file_id);
    allFileSymbols.sort((a, b) => a.line - b.line || a.col - b.col);

    const startLine = symbol.line;
    let endLine = symbol.end_line;

    if (endLine == null) {
      const idx = allFileSymbols.findIndex(s => s.id === symbol.id);
      if (idx >= 0 && idx < allFileSymbols.length - 1) {
        endLine = allFileSymbols[idx + 1].line - 1;
      } else {
        endLine = Math.min(startLine + 49, lines.length);
      }
    }

    return {
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file_path,
      line: startLine,
      end_line: endLine,
      language: symbol.file_language,
      source: lines.slice(startLine - 1, endLine).join('\n'),
      ...(symbol.signature ? { signature: symbol.signature } : {}),
      ...(symbol.doc ? { doc: symbol.doc } : {}),
    };
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

function symbolWithFileToResult(row: SymbolWithFile): SymbolResult {
  return {
    name: row.name,
    kind: row.kind,
    file: row.file_path,
    line: row.line,
    col: row.col,
    ...(row.end_line != null ? { end_line: row.end_line } : {}),
    ...(row.signature ? { signature: row.signature } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.doc ? { doc: row.doc } : {}),
    language: row.file_language,
  };
}

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

function buildSliceQuery(
  name: string,
  opts?: { file?: string; limit?: number },
): string {
  return `slice ${name}${opts?.file ? ` --file ${opts.file}` : ''}${opts?.limit ? ` --limit ${opts.limit}` : ''}`;
}

function getSlicePreferenceScore(
  symbol: SymbolWithFile,
  rootFileId: number,
  importedFileIds: Set<number>,
): number {
  if (symbol.file_id === rootFileId) return 0;
  if (importedFileIds.has(symbol.file_id)) return 1;
  return 2;
}
