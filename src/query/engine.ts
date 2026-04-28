import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { NexusStore } from '../db/store.js';
import type { SymbolRow, FileRow, ModuleEdgeRow, SymbolWithFile, OccurrenceWithFile, ImportEdgeWithFile, RelationJoinedRow } from '../db/store.js';
import { getAllAdapters } from '../analysis/languages/registry.js';
import type { LanguageCapabilities } from '../analysis/languages/registry.js';
import { extractSource } from '../analysis/extractor.js';
import { SCHEMA_VERSION, EXTRACTOR_VERSION } from '../db/schema.js';
import { fuzzyScore, multiFieldScore, getSuggestions, rankResults } from './ranking.js';
import { diffDocAgainstSignature } from './stale-docs.js';
import { BudgetLedger } from './budget-ledger.js';
import type { BudgetSummary, BudgetEntry } from './budget-ledger.js';
import { classifyPath, classifyTestPath } from '../workspace/classify.js';
import {
  loadPackageJson, loadTsconfig, loadGenericJson,
  loadGhaWorkflow, loadGenericYaml,
  loadCargoToml, loadGenericToml,
  loadYarnLock, loadPackageLock, loadPnpmLock, loadCargoLock,
} from '../analysis/documents/index.js';

// ── Result Types ──────────────────────────────────────────────────────

export type NexusResultType =
  | 'find'
  | 'occurrences'
  | 'exports'
  | 'imports'
  | 'tree'
  | 'search'
  | 'stats'
  | 'grep'
  | 'outline'
  | 'source'
  | 'deps'
  | 'slice'
  | 'callers'
  | 'pack'
  | 'changed'
  | 'diff_outline'
  | 'signatures'
  | 'definition_at'
  | 'unused_exports'
  | 'private_dead'
  | 'tests_for'
  | 'stale_docs'
  | 'kind_index'
  | 'doc'
  | 'batch'
  | 'structured_query'
  | 'structured_outline'
  | 'lockfile_deps'
  | 'relations'
  | 'rename_safety'
  | 'refactor_preview'
  | 'clarify'
  | 'policy_check';

export interface NexusResult<T> {
  query: string;
  type: NexusResultType;
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
  ref_kind?: string | null;
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
    capabilities: LanguageCapabilities;
  }>;
  index_status: 'current' | 'stale' | 'reindexing';
  index_health: 'ok' | 'partial';
  last_indexed_at: string;
  schema_version: number;
  extractor_version: number;
  /** Present only when `stats({ session: true })` is requested (D4). */
  session?: {
    summary: BudgetSummary;
    recent: BudgetEntry[];
    capacity: number;
  };
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

// ── New tool result types ─────────────────────────────────────────────

export interface CallerCallSite {
  line: number;
  col: number;
  context: string;
  ref_kind?: string | null;
}

export interface CallerResult {
  caller: SymbolResult;
  call_sites: CallerCallSite[];
  callers?: CallerResult[]; // populated when depth > 1
}

export interface CallersResult {
  target: SymbolResult;
  callers: CallerResult[];
  disambiguation?: SymbolResult[];
  truncated?: boolean;
}

export interface PackedItem {
  file: string;
  kind: 'outline' | 'source';
  name?: string;        // symbol name when kind === 'source'
  tokens: number;
  payload: OutlineResult | SourceResult;
}

export interface PackResult {
  query: string;
  budget_tokens: number;
  total_tokens: number;
  included: PackedItem[];
  skipped: { file: string; kind: 'outline' | 'source'; name?: string; reason: string }[];
}

export interface ChangedFile {
  path: string;
  change_type: 'A' | 'M' | 'D';
  outline?: OutlineResult;
}

export interface ChangedResult {
  ref: string;
  source: 'git' | 'mtime';
  files: ChangedFile[];
}

export interface DiffOutlineEntry {
  name: string;
  kind: string;
  line?: number;
  signature?: string;
}

export interface DiffOutlineFile {
  path: string;
  added: DiffOutlineEntry[];
  removed: DiffOutlineEntry[];
  modified: { name: string; kind: string; before: DiffOutlineEntry; after: DiffOutlineEntry }[];
}

export interface DiffOutlineResult {
  ref_a: string;
  ref_b: string;
  files: DiffOutlineFile[];
}

export interface SignatureResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  language: string;
  signature?: string;
  doc_summary?: string;
}

export interface UnusedExportResult {
  file: string;
  name: string;
  kind: string;
  line: number;
}

export interface PrivateDeadResult {
  file: string;
  name: string;
  kind: string;
  line: number;
  end_line?: number;
}

export interface StaleDocResult {
  file: string;
  name: string;
  kind: string;
  line: number;
  issues: { kind: 'unknown_param' | 'undocumented_param'; detail: string }[];
}

export interface TestsForResult {
  source_file: string;
  test_file: string;
  imported_name?: string;
  imported_alias?: string;
  is_default: boolean;
  is_star: boolean;
  is_type: boolean;
  line: number;
  confidence: 'declared' | 'derived';
}

export interface DocResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  doc?: string;
}

export interface BatchSubResult {
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BatchResult {
  results: BatchSubResult[];
}

export interface StructuredQueryResult {
  file: string;
  path: string;
  kind: string;
  found: boolean;
  value?: unknown;
  error?: string;
  limit?: number;
  actual?: number;
}

export type StructuredValueKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface StructuredOutlineEntry {
  key: string;
  value_kind: StructuredValueKind;
  preview?: string;
  length?: number;
}

export interface StructuredOutlineFileResult {
  file: string;
  kind: string;
  entries: StructuredOutlineEntry[];
  error?: string;
}

export interface LockfileDepsResult {
  file: string;
  kind: string;
  entries: { name: string; version: string }[];
  error?: string;
  limit?: number;
  actual?: number;
}

export interface RelationEdgeResult {
  source: { name: string; kind: string; file: string; line: number };
  kind: string; // 'extends_class' | 'implements' | 'extends_interface'
  target: {
    name: string;
    resolved_name?: string;
    kind?: string;
    file?: string;
    line?: number;
    resolved: boolean;
  };
  confidence: string;
  line: number;
  depth: number;
}

export interface RelationsResult {
  query: { name: string; direction: string; kind?: string; depth: number };
  results: RelationEdgeResult[];
  count: number;
}

// ── Rename safety (B6) ────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RenameRiskInputs {
  callerCount: number;
  refKinds: Record<string, number>;
  importerCount: number;
  childCount: number;
  parentCount: number;
  sameFileCollisions: number;
  sameModuleCollisions: number;
}

/**
 * Pure risk classifier — exported for testability. Order matters: high gates
 * are checked first, then medium, then default low.
 */
export function classifyRenameRisk(input: RenameRiskInputs): {
  risk: RiskLevel;
  reasons: string[];
} {
  const reasons: string[] = [];
  let risk: RiskLevel = 'low';

  // High gates.
  if (input.childCount > 0) {
    reasons.push(`has_children:${input.childCount}`);
    risk = 'high';
  }
  if (input.importerCount > 0) {
    reasons.push(`has_importers:${input.importerCount}`);
    risk = 'high';
  }
  if (input.sameModuleCollisions > 0) {
    reasons.push(`same_module_collision:${input.sameModuleCollisions}`);
    risk = 'high';
  }
  if (risk === 'high') return { risk, reasons };

  // Medium gates.
  if (input.callerCount > 0) {
    reasons.push(`has_callers:${input.callerCount}`);
    risk = 'medium';
  }
  const typeRefs = input.refKinds['type-ref'] ?? 0;
  if (typeRefs > 0 && !reasons.some(r => r.startsWith('has_callers'))) {
    reasons.push(`has_type_refs:${typeRefs}`);
    risk = 'medium';
  }
  if (input.parentCount > 0) {
    reasons.push(`has_parents:${input.parentCount}`);
    risk = risk === 'low' ? 'medium' : risk;
  }
  if (input.sameFileCollisions > 0) {
    reasons.push(`same_file_collision:${input.sameFileCollisions}`);
    risk = risk === 'low' ? 'medium' : risk;
  }

  if (risk === 'low') reasons.push('no_external_refs');
  return { risk, reasons };
}

// ── Clarify (D2) ──────────────────────────────────────────────────────

export interface ClarifyCandidate {
  file: string;
  line: number;
  kind: string;
  scope?: string;
  signature?: string;
  language: string;
  is_export: boolean;
  importer_count: number;
  relation_summary?: string;
}

export interface ClarifyResult {
  name: string;
  candidates: ClarifyCandidate[];
  count: number;
  unique_disambiguators: {
    files: string[];
    kinds: string[];
    scopes: string[];
  };
  /** Heuristic picks ranked by usage + structural prominence. */
  suggested_picks: { rationale: string; index: number }[];
}

/**
 * One concrete change site that a rename would touch. `role` describes how
 * the site relates to the renamed symbol; `ref_kind` is present for occurrence
 * sites when the language adapter classifies them.
 */
export interface RefactorPreviewEdit {
  line: number;
  col: number;
  role: 'definition' | 'caller' | 'importer' | 'override' | 'subclass' | 'implementer';
  context: string;
  ref_kind?: string;
}

/**
 * Per-file aggregation of edits a rename would produce. `kinds` is a
 * deduplicated set of edit roles found in this file (cheap summary for
 * UIs that don't render every edit).
 */
export interface RefactorPreviewFile {
  file: string;
  edits: RefactorPreviewEdit[];
  kinds: string[];
}

/**
 * Composed dry-run preview for a rename refactor (B6 v2). Carries the same
 * risk verdict as renameSafety (no double work), plus the per-site edit list
 * a tooling layer needs to *render* the rename without performing it.
 */
export interface RefactorPreviewResult {
  symbol: { name: string; kind: string; file: string; line: number; language: string };
  new_name: string | null;
  risk: RiskLevel;
  reasons: string[];
  blast_radius: number;
  files_affected: number;
  edits_total: number;
  by_file: RefactorPreviewFile[];
  /**
   * When `new_name` is present, lists collisions just like renameSafety so
   * the caller doesn't need a second call. Empty arrays when no new_name.
   */
  collisions: {
    same_file: { name: string; kind: string; line: number }[];
    same_module: { name: string; kind: string; file: string; line: number }[];
  };
}

export interface RenameSafetyResult {
  symbol: { name: string; kind: string; file: string; line: number; language: string };
  callers: {
    count: number;
    ref_kinds: Record<string, number>;
    files: string[];
  };
  importers: {
    count: number;
    files: string[];
  };
  relations: {
    children: { count: number; kinds: Record<string, number> };
    parents: { count: number; kinds: Record<string, number> };
  };
  collisions: {
    same_file: { name: string; kind: string; line: number }[];
    same_module: { name: string; kind: string; file: string; line: number }[];
  };
  blast_radius: number;
  risk: RiskLevel;
  reasons: string[];
}

// ── Query Engine ──────────────────────────────────────────────────────

export interface QueryEngineOptions {
  /**
   * Override the source-file root used by methods that read disk content
   * (grep, source, outline line counts, structured/lockfile loaders, etc.).
   *
   * Defaults to `store.getMeta('root_path')` when unset, which matches the
   * pre-worktree behavior. In a worktree session, callers should pass
   * `info.sourceRoot` from `detectWorkspace()` so source reads hit the
   * worktree's checkout even when the index DB lives at the parent root.
   */
  sourceRoot?: string;
  /** Inject a shared BudgetLedger (e.g. process-level) — defaults to a fresh per-engine one. */
  budgetLedger?: BudgetLedger;
}

export class QueryEngine {
  private store: NexusStore;
  private db: Database.Database;
  private sourceRootOverride: string | null;
  /** Per-session pack() ring buffer (D4). Surfaced via `stats({ session: true })`. */
  readonly budgetLedger: BudgetLedger;

  constructor(db: Database.Database, opts: QueryEngineOptions = {}) {
    this.db = db;
    this.store = new NexusStore(db);
    this.sourceRootOverride = opts.sourceRoot ?? null;
    this.budgetLedger = opts.budgetLedger ?? new BudgetLedger();
  }

  /**
   * Returns the on-disk root for source reads. Prefers the constructor
   * override (set in worktree mode); falls back to `meta.root_path` for
   * backward-compat with callers that didn't supply one.
   */
  private getSourceRoot(): string {
    return this.sourceRootOverride ?? this.store.getMeta('root_path') ?? '';
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
  occurrences(
    name: string,
    opts?: { ref_kinds?: string[] },
  ): NexusResult<OccurrenceResult> {
    const start = performance.now();

    const rows = this.store.getOccurrencesWithFileFiltered(name, opts?.ref_kinds);

    const refKindSuffix = opts?.ref_kinds?.length
      ? ` --ref-kinds ${opts.ref_kinds.join(',')}`
      : '';

    const results: OccurrenceResult[] = rows.map(row => ({
      name: row.name,
      file: row.file_path,
      line: row.line,
      col: row.col,
      context: row.context ?? '',
      confidence: row.confidence as 'exact' | 'heuristic',
      ...(row.ref_kind !== undefined ? { ref_kind: row.ref_kind } : {}),
    }));

    return this.wrap('occurrences', `refs ${name}${refKindSuffix}`, results, start);
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

    const root = this.getSourceRoot();
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
   * Full index summary with per-language capabilities. When `opts.session`
   * is true, also include the per-process budget-accountant snapshot (D4):
   * a summary across recent pack() calls plus the recent entries
   * themselves (capped by `recent_limit`, default 10, max 50).
   */
  stats(opts?: { session?: boolean; recent_limit?: number }): NexusResult<IndexStats> {
    const start = performance.now();

    const fileCounts = this.store.getFileCount();
    const symbolCount = this.store.getSymbolCount();
    const langStats = this.store.getLanguageStats();
    const root = this.getSourceRoot();
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
          refKinds: [],
          relationKinds: [],
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

    if (opts?.session) {
      const recentLimit = Math.min(Math.max(opts.recent_limit ?? 10, 0), 50);
      statsResult.session = {
        summary: this.budgetLedger.summary(),
        recent: this.budgetLedger.entries(recentLimit),
        capacity: this.budgetLedger.capacity,
      };
    }

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
    const root = this.getSourceRoot();
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

    const root = this.getSourceRoot();
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
  slice(name: string, opts?: { file?: string; limit?: number; ref_kinds?: string[] }): NexusResult<SliceResult> {
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

    const occurrences = this.store.getOccurrencesInRangeFiltered(
      root.file_id,
      rootSource.line,
      rootSource.end_line,
      opts?.ref_kinds,
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
  // ── New token-saver tools ───────────────────────────────────────────

  /**
   * Batch signature lookup: returns name + signature + doc summary for each
   * input name, no body. Replaces N find/source calls when comparing siblings.
   */
  signatures(
    names: string[],
    opts?: { file?: string; kind?: string },
  ): NexusResult<SignatureResult> {
    const start = performance.now();
    const query = `signatures ${names.join(',')}${opts?.file ? ` --file ${opts.file}` : ''}${opts?.kind ? ` --kind ${opts.kind}` : ''}`;

    if (names.length === 0) {
      return this.wrap('signatures', query, [], start);
    }

    const rows = this.store.findSymbolsByNames(names);
    const fileNorm = opts?.file ? normalizePath(opts.file).toLowerCase() : null;
    const seen = new Set<string>();
    const results: SignatureResult[] = [];

    for (const row of rows) {
      if (opts?.kind && row.kind !== opts.kind) continue;
      if (fileNorm && !normalizePath(row.file_path).toLowerCase().endsWith(fileNorm)) continue;
      const dedupKey = `${row.name}\0${row.file_path}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      results.push({
        name: row.name,
        kind: row.kind,
        file: row.file_path,
        line: row.line,
        language: row.file_language,
        ...(row.signature ? { signature: row.signature } : {}),
        ...(row.doc ? { doc_summary: row.doc.split('\n')[0].trim() } : {}),
      });
    }

    return this.wrap('signatures', query, results, start);
  }

  /**
   * Just the docstring(s) for a symbol. Avoids reading source bodies when
   * all you need is the comment block.
   */
  doc(name: string, opts?: { file?: string }): NexusResult<DocResult> {
    const start = performance.now();
    const query = `doc ${name}${opts?.file ? ` --file ${opts.file}` : ''}`;

    let rows = this.store.getSymbolsWithFile(name);
    if (rows.length === 0) {
      rows = this.store.getSymbolsWithFileCaseInsensitive(name);
    }

    if (opts?.file && rows.length > 0) {
      const norm = normalizePath(opts.file).toLowerCase();
      rows = rows.filter(r => normalizePath(r.file_path).toLowerCase().endsWith(norm));
    }

    const results: DocResult[] = rows.map(row => ({
      name: row.name,
      kind: row.kind,
      file: row.file_path,
      line: row.line,
      ...(row.doc ? { doc: row.doc } : {}),
    }));

    return this.wrap('doc', query, results, start);
  }

  /**
   * All symbols of a given kind, optionally restricted to a path subtree.
   * Replaces grep/search chains for "show me every <kind> in this folder".
   */
  kindIndex(
    kind: string,
    opts?: { path?: string; limit?: number },
  ): NexusResult<SymbolResult> {
    const start = performance.now();
    const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 1000);
    const query = `kind_index ${kind}${opts?.path ? ` --path ${opts.path}` : ''}${opts?.limit ? ` --limit ${opts.limit}` : ''}`;

    const rows = this.store.getSymbolsByKindAndPath(kind, opts?.path);
    const results = rows.slice(0, limit).map(r => symbolWithFileToResult(r));
    return this.wrap('kind_index', query, results, start);
  }

  /**
   * Inverse of slice: find every function/class that calls this symbol,
   * grouped by caller, with one snippet per call site. Optional depth recurses
   * upward through the call graph (heuristic, occurrence-based — same precision
   * tier as nexus_slice).
   */
  callers(
    name: string,
    opts?: { file?: string; depth?: number; limit?: number; ref_kinds?: string[] },
  ): NexusResult<CallersResult> {
    const start = performance.now();
    const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 100);
    const depth = Math.min(Math.max(opts?.depth ?? 1, 1), 3);
    const refKindSuffix = opts?.ref_kinds?.length
      ? ` --ref-kinds ${opts.ref_kinds.join(',')}`
      : '';
    const query = `callers ${name}${opts?.file ? ` --file ${opts.file}` : ''}${opts?.depth ? ` --depth ${opts.depth}` : ''}${refKindSuffix}`;

    let defs = this.store.getSymbolsWithFile(name);
    if (defs.length === 0) {
      defs = this.store.getSymbolsWithFileCaseInsensitive(name);
    }

    if (opts?.file && defs.length > 0) {
      const norm = normalizePath(opts.file).toLowerCase();
      defs = defs.filter(d => normalizePath(d.file_path).toLowerCase().endsWith(norm));
    }

    if (defs.length === 0) {
      return this.wrap('callers', query, [], start);
    }

    defs.sort((a, b) => a.file_path.localeCompare(b.file_path) || a.line - b.line || a.col - b.col);
    const target = defs[0];

    const result: CallersResult = {
      target: symbolWithFileToResult(target),
      callers: this.findCallersForSymbol(target, depth, limit, new Set([target.id]), opts?.ref_kinds),
    };

    if (defs.length > 1 && !opts?.file) {
      result.disambiguation = defs.slice(1).map(symbolWithFileToResult);
    }
    if (result.callers.length >= limit) {
      result.truncated = true;
    }

    return this.wrap('callers', query, [result], start);
  }

  private findCallersForSymbol(
    target: SymbolWithFile,
    depth: number,
    limit: number,
    visited: Set<number>,
    refKinds: string[] | undefined,
  ): CallerResult[] {
    const occurrences = this.store.getOccurrencesByNameFiltered(target.name, refKinds);
    const callerMap = new Map<number, { caller: SymbolWithFile; sites: CallerCallSite[] }>();

    for (const occ of occurrences) {
      // Skip the def line itself
      if (occ.file_id === target.file_id && occ.line === target.line) continue;
      // Skip occurrences inside the target's own body (recursive self-refs)
      if (
        occ.file_id === target.file_id &&
        target.end_line != null &&
        occ.line >= target.line &&
        occ.line <= target.end_line
      ) {
        continue;
      }

      const enclosing = this.store.getEnclosingSymbol(occ.file_id, occ.line);
      if (!enclosing || enclosing.id === target.id) continue;
      if (visited.has(enclosing.id)) continue;

      const existing = callerMap.get(enclosing.id);
      const site: CallerCallSite = {
        line: occ.line,
        col: occ.col,
        context: occ.context ?? '',
        ...(occ.ref_kind !== undefined ? { ref_kind: occ.ref_kind } : {}),
      };

      if (existing) {
        existing.sites.push(site);
      } else {
        const filePath = this.store.getFileById(enclosing.file_id);
        if (!filePath) continue;
        callerMap.set(enclosing.id, {
          caller: {
            ...enclosing,
            file_path: filePath.path,
            file_language: filePath.language,
          },
          sites: [site],
        });
      }

      if (callerMap.size >= limit) break;
    }

    const callers: CallerResult[] = [];
    for (const { caller, sites } of callerMap.values()) {
      const entry: CallerResult = {
        caller: symbolWithFileToResult(caller),
        call_sites: sites,
      };
      if (depth > 1) {
        const nextVisited = new Set(visited);
        nextVisited.add(caller.id);
        const recursed = this.findCallersForSymbol(caller, depth - 1, limit, nextVisited, refKinds);
        if (recursed.length > 0) entry.callers = recursed;
      }
      callers.push(entry);
    }

    return callers;
  }

  /**
   * LSP-style go-to-definition. Best-effort: identifies the identifier at
   * (file, line, col?) and resolves it via the symbol table. Falls back to
   * first identifier on the line when col is not provided.
   */
  definitionAt(
    filePath: string,
    line: number,
    col?: number,
  ): NexusResult<SourceResult> {
    const start = performance.now();
    const query = `definition_at ${filePath}:${line}${col != null ? `:${col}` : ''}`;

    const file = this.findFile(filePath);
    if (!file) return this.wrap('definition_at', query, [], start);

    const root = this.getSourceRoot();
    let lineText: string;
    try {
      const content = fs.readFileSync(path.resolve(root, file.path), 'utf-8');
      const allLines = content.split('\n');
      if (line < 1 || line > allLines.length) {
        return this.wrap('definition_at', query, [], start);
      }
      lineText = allLines[line - 1];
    } catch {
      return this.wrap('definition_at', query, [], start);
    }

    const identifier = pickIdentifierAt(lineText, col);
    if (!identifier) return this.wrap('definition_at', query, [], start);

    let defs = this.store.getSymbolsWithFile(identifier);
    if (defs.length === 0) {
      defs = this.store.getSymbolsWithFileCaseInsensitive(identifier);
    }

    if (defs.length === 0) return this.wrap('definition_at', query, [], start);

    // Prefer same-file def, then imported file, then anywhere
    const importedFileIds = new Set(
      this.store.getImportsByFileId(file.id)
        .map(e => e.resolved_file_id)
        .filter((id): id is number => id != null),
    );
    defs.sort((a, b) => {
      const aScore = a.file_id === file.id ? 0 : importedFileIds.has(a.file_id) ? 1 : 2;
      const bScore = b.file_id === file.id ? 0 : importedFileIds.has(b.file_id) ? 1 : 2;
      return aScore - bScore || a.file_path.localeCompare(b.file_path) || a.line - b.line;
    });

    const source = this.getSourceForSymbol(defs[0]);
    return this.wrap('definition_at', query, source ? [source] : [], start);
  }

  /**
   * Find exports with no importers and no occurrences outside their own file.
   * Best-effort dead-code finder. Note: re-exports through index.ts will
   * appear unused if nothing imports them externally; filter by path to scope.
   *
   * mode='runtime_only' excludes type-only importers (is_type=1) and
   * type-ref occurrences (ref_kind='type-ref') from the "used" evidence,
   * surfacing exports that are runtime-dead even if consumed in type positions.
   */
  unusedExports(
    opts?: { path?: string; limit?: number; mode?: 'default' | 'runtime_only' },
  ): NexusResult<UnusedExportResult> {
    const start = performance.now();
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const mode = opts?.mode ?? 'default';
    const modeSuffix = mode === 'runtime_only' ? ' --mode runtime_only' : '';
    const query = `unused_exports${opts?.path ? ` --path ${opts.path}` : ''}${modeSuffix}`;

    const exports = this.store.getAllExports(opts?.path);
    const results: UnusedExportResult[] = [];

    for (const exp of exports) {
      if (results.length >= limit) break;
      if (exp.is_star) continue; // star exports are pass-throughs
      if (!exp.name) continue;

      // Check if any other file imports this file (resolved_file_id match)
      const importers = this.store.getImportersByResolvedFileId(exp.file_id);
      const namedImporters = importers.filter(imp => {
        if (imp.is_star || imp.is_default) return false;
        if (imp.name !== exp.name && imp.alias !== exp.name) return false;
        // In runtime_only mode, a type-only import (is_type=1) does not count
        // as a "use".
        if (mode === 'runtime_only' && imp.is_type) return false;
        return true;
      });
      if (namedImporters.length > 0) continue;

      // Check occurrences in OTHER files
      let externalOccurrences = this.store
        .getOccurrencesByName(exp.name)
        .filter(o => o.file_id !== exp.file_id);
      if (mode === 'runtime_only') {
        externalOccurrences = externalOccurrences.filter(o => o.ref_kind !== 'type-ref');
      }
      if (externalOccurrences.length > 0) continue;

      // Look up kind via local symbol if available
      let kind = 'export';
      if (exp.symbol_id != null) {
        const allFileSyms = this.store.getSymbolsByFileId(exp.file_id);
        const sym = allFileSyms.find(s => s.id === exp.symbol_id);
        if (sym) kind = sym.kind;
      }

      results.push({
        file: exp.file_path,
        name: exp.name,
        kind,
        line: exp.line,
      });
    }

    return this.wrap('unused_exports', query, results, start);
  }

  /**
   * Private dead code (B4) — top-level symbols that are NOT exported and have
   * zero references in their own file beyond the declaration site. Sister tool
   * to `unusedExports`: that finds public dead code (exported, no importer);
   * this finds private dead code (unexported, never used internally either).
   *
   * Heuristic: occurrences on the symbol's declaration line are treated as
   * the declaration site (the extractor emits an occurrence for the name in
   * the declaration itself, with col=name-position rather than col=0). Any
   * occurrence on a different line of the same file counts as evidence of
   * life. Cross-file occurrences are ignored — a private (non-exported)
   * symbol cannot be referenced from another file by import.
   */
  privateDeadCode(
    opts?: { path?: string; limit?: number; kinds?: string[] },
  ): NexusResult<PrivateDeadResult> {
    const start = performance.now();
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const kindSuffix = opts?.kinds?.length ? ` --kinds ${opts.kinds.join(',')}` : '';
    const query = `private_dead${opts?.path ? ` --path ${opts.path}` : ''}${kindSuffix}`;

    const candidates = this.store.getNonExportedTopLevelSymbols({
      pathPrefix: opts?.path,
      ...(opts?.kinds ? { kinds: opts.kinds } : {}),
    });
    const results: PrivateDeadResult[] = [];

    for (const sym of candidates) {
      if (results.length >= limit) break;

      const occurrences = this.store
        .getOccurrencesByName(sym.name)
        .filter(o => o.file_id === sym.file_id);
      const nonDecl = occurrences.filter(o => o.line !== sym.line);
      if (nonDecl.length > 0) continue;

      results.push({
        file: sym.file_path,
        name: sym.name,
        kind: sym.kind,
        line: sym.line,
        ...(sym.end_line != null ? { end_line: sym.end_line } : {}),
      });
    }

    return this.wrap('private_dead', query, results, start);
  }

  /**
   * Stale-doc detection (B3 v1) — flag symbols whose `@param` tags don't
   * agree with their actual signature. Pure post-hoc analysis; reuses the
   * extractor's already-stored `doc` and `signature` columns. Composes
   * `diffDocAgainstSignature` from `query/stale-docs.ts`.
   *
   * Skips symbols whose docstring has zero `@param` tags — fully
   * undocumented things are not flagged here (different concern). Default
   * kinds: `function`, `method`, `hook`, `component` (the kinds where
   * @param matters).
   */
  staleDocs(opts?: { path?: string; kinds?: string[]; limit?: number }): NexusResult<StaleDocResult> {
    const start = performance.now();
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const kindSuffix = opts?.kinds?.length ? ` --kinds ${opts.kinds.join(',')}` : '';
    const query = `stale_docs${opts?.path ? ` --path ${opts.path}` : ''}${kindSuffix}`;

    const candidates = this.store.getDocumentedSymbols({
      ...(opts?.path ? { pathPrefix: opts.path } : {}),
      ...(opts?.kinds ? { kinds: opts.kinds } : {}),
    });
    const results: StaleDocResult[] = [];

    for (const sym of candidates) {
      if (results.length >= limit) break;
      if (!sym.doc || !sym.signature) continue;
      const issues = diffDocAgainstSignature(sym.doc, sym.signature);
      if (issues.length === 0) continue;
      results.push({
        file: sym.file_path,
        name: sym.name,
        kind: sym.kind,
        line: sym.line,
        issues,
      });
    }

    return this.wrap('stale_docs', query, results, start);
  }

  /**
   * Test-to-source linkage (B5 v1) — given a source `name` or `file`, find
   * test files that import it. Computed at query time from existing import
   * edges + a path-based test classifier; no schema bump.
   *
   * Resolution:
   *   - `file`: resolved via `findFile` (exact path_key, lowercase, then
   *     suffix match).
   *   - `name`: resolved via `getSymbolsWithFile` to all files declaring a
   *     same-named symbol; the union of those files is queried for
   *     importers.
   *
   * Confidence:
   *   - `declared`: importer matches a strong test-file pattern (`*.test.*`,
   *     `*.spec.*`, `__tests__/`).
   *   - `derived`: importer lives under a top-level `tests/` or `test/`
   *     directory but lacks the filename pattern (Vitest convention).
   *
   * Non-test importers are filtered out. Star (`import *`) and re-export
   * importers are included — they still indicate a test pulling in the
   * module's surface.
   */
  testsFor(opts: { name?: string; file?: string; limit?: number }): NexusResult<TestsForResult> {
    const start = performance.now();
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const queryStr = `tests_for ${opts.name ? `--name ${opts.name}` : ''}${opts.file ? `--file ${opts.file}` : ''}`.trim();

    const sourceFileIds: { id: number; path: string }[] = [];

    if (opts.file) {
      const file = this.findFile(opts.file);
      if (file) sourceFileIds.push({ id: file.id, path: file.path });
    } else if (opts.name) {
      const decls = this.store.getSymbolsWithFile(opts.name);
      const seen = new Set<number>();
      for (const d of decls) {
        const fileId = (d as { file_id: number }).file_id;
        if (seen.has(fileId)) continue;
        seen.add(fileId);
        sourceFileIds.push({ id: fileId, path: d.file_path });
      }
    }

    const results: TestsForResult[] = [];
    const dedupe = new Set<string>();

    for (const src of sourceFileIds) {
      if (results.length >= limit) break;
      const importers = this.store.getImportersByResolvedFileId(src.id);
      for (const imp of importers) {
        if (results.length >= limit) break;
        const confidence = classifyTestPath(imp.file_path);
        if (!confidence) continue;
        const dedupeKey = `${src.id}|${imp.file_path}|${imp.line}|${imp.name ?? ''}`;
        if (dedupe.has(dedupeKey)) continue;
        dedupe.add(dedupeKey);
        results.push({
          source_file: src.path,
          test_file: imp.file_path,
          ...(imp.name ? { imported_name: imp.name } : {}),
          ...(imp.alias ? { imported_alias: imp.alias } : {}),
          is_default: !!imp.is_default,
          is_star: !!imp.is_star,
          is_type: !!imp.is_type,
          line: imp.line,
          confidence,
        });
      }
    }

    return this.wrap('tests_for', queryStr, results, start);
  }

  /**
   * Declared structural relationships (B2 v1).
   * `direction: 'parents'` — what does `name` extend or implement?
   * `direction: 'children'` — who extends or implements `name`?
   * `direction: 'both'` — union.
   * `kind` filters to one edge kind.
   * `depth` (1-5) recurses; cycle-safe via a visited set keyed on resolved id+kind.
   */
  relations(
    name: string,
    opts?: { direction?: 'parents' | 'children' | 'both'; kind?: string; depth?: number; limit?: number },
  ): NexusResult<RelationsResult> {
    const start = performance.now();
    const direction = opts?.direction ?? 'parents';
    const depth = Math.min(Math.max(opts?.depth ?? 1, 1), 5);
    const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
    const queryText = `relations ${name} --direction ${direction}${opts?.kind ? ` --kind ${opts.kind}` : ''} --depth ${depth}`;

    const out: RelationEdgeResult[] = [];
    const visited = new Set<string>();
    visited.add(name);

    const fanout = (currentName: string, currentDepth: number): void => {
      if (currentDepth > depth) return;
      if (out.length >= limit) return;

      let rows: RelationJoinedRow[] = [];
      if (direction === 'parents' || direction === 'both') {
        rows = rows.concat(this.store.getRelationsBySource(currentName, opts?.kind));
      }
      if (direction === 'children' || direction === 'both') {
        rows = rows.concat(this.store.getRelationsByTarget(currentName, opts?.kind));
      }

      for (const row of rows) {
        if (out.length >= limit) break;
        const result: RelationEdgeResult = {
          source: { name: row.source_name, kind: row.source_kind, file: row.source_file, line: row.source_line },
          kind: row.kind,
          target: {
            name: row.target_name,
            ...(row.target_resolved_name ? { resolved_name: row.target_resolved_name } : {}),
            ...(row.target_kind ? { kind: row.target_kind } : {}),
            ...(row.target_file ? { file: row.target_file } : {}),
            ...(row.target_line !== null && row.target_line !== undefined ? { line: row.target_line } : {}),
            resolved: row.target_id !== null,
          },
          confidence: row.confidence,
          line: row.line,
          depth: currentDepth,
        };
        out.push(result);

        if (currentDepth < depth) {
          // Walk further: parents → up via target name, children → down via source name.
          let nextName: string | null = null;
          if (direction === 'parents') {
            nextName = row.target_resolved_name ?? row.target_name;
          } else if (direction === 'children') {
            nextName = row.source_name;
          }
          if (nextName && !visited.has(nextName)) {
            visited.add(nextName);
            fanout(nextName, currentDepth + 1);
          }
        }
      }
    };

    fanout(name, 1);

    const result: RelationsResult = {
      query: { name, direction, ...(opts?.kind ? { kind: opts.kind } : {}), depth },
      results: out,
      count: out.length,
    };
    return this.wrap('relations', queryText, [result], start);
  }

  /**
   * Rename safety analysis (B6 v1) — composes refs (B1 ref_kind), importers,
   * relations (B2), and collision detection into a single risk verdict.
   *
   * Risk model:
   *   high   — has children edges (renaming breaks subclasses), OR has importers
   *            (cross-module surface), OR new_name collides with same-module symbol.
   *   medium — has callers/type-refs in same module, OR has parent edges, OR
   *            new_name collides only in same file.
   *   low    — no callers, no importers, no relations.
   */
  renameSafety(
    name: string,
    opts?: { file?: string; new_name?: string },
  ): NexusResult<RenameSafetyResult> {
    const start = performance.now();
    const queryText = `rename-safety ${name}${opts?.file ? ` --file ${opts.file}` : ''}${opts?.new_name ? ` --new ${opts.new_name}` : ''}`;

    // Resolve target symbol (disambiguate by file when provided).
    const candidates = this.store.getSymbolsWithFile(name);
    const sym = opts?.file
      ? candidates.find(c => c.file_path === opts.file || c.file_path.endsWith(opts.file!))
      : candidates[0];
    if (!sym) {
      const empty: RenameSafetyResult = {
        symbol: { name, kind: '', file: opts?.file ?? '', line: 0, language: '' },
        callers: { count: 0, ref_kinds: {}, files: [] },
        importers: { count: 0, files: [] },
        relations: {
          children: { count: 0, kinds: {} },
          parents: { count: 0, kinds: {} },
        },
        collisions: { same_file: [], same_module: [] },
        blast_radius: 0,
        risk: 'low',
        reasons: ['symbol_not_found'],
      };
      return this.wrap('rename_safety', queryText, [empty], start);
    }

    // Callers: occurrences excluding the declaration row itself.
    const occRows = this.store.getOccurrencesWithFile(name);
    const refKinds: Record<string, number> = {};
    const callerFiles = new Set<string>();
    let callerCount = 0;
    for (const o of occRows) {
      if (o.file_path === sym.file_path && o.line === sym.line) continue; // declaration
      const rk = o.ref_kind ?? 'unknown';
      refKinds[rk] = (refKinds[rk] ?? 0) + 1;
      callerFiles.add(o.file_path);
      callerCount++;
    }

    // Importers: any module_edge that resolves to this symbol's file.
    const imports = this.store.getImportersByResolvedFileId(sym.file_id);
    const importerFiles = new Set<string>();
    for (const e of imports) {
      // Only count if it imports this name (or is a star-import).
      if (e.is_star || e.name === name || e.alias === name) {
        importerFiles.add(e.file_path);
      }
    }

    // Relations: parents (what `name` extends/implements) + children (who extends `name`).
    const childRows = this.store.getRelationsByTarget(name);
    const parentRows = this.store.getRelationsBySource(name);
    const childKinds: Record<string, number> = {};
    const parentKinds: Record<string, number> = {};
    for (const r of childRows) childKinds[r.kind] = (childKinds[r.kind] ?? 0) + 1;
    for (const r of parentRows) parentKinds[r.kind] = (parentKinds[r.kind] ?? 0) + 1;

    // Collisions: only relevant when new_name supplied.
    const sameFileCollisions: { name: string; kind: string; line: number }[] = [];
    const sameModuleCollisions: { name: string; kind: string; file: string; line: number }[] = [];
    if (opts?.new_name && opts.new_name !== name) {
      const colliders = this.store.getSymbolsWithFile(opts.new_name);
      for (const c of colliders) {
        if (c.file_path === sym.file_path) {
          sameFileCollisions.push({ name: c.name, kind: c.kind, line: c.line });
        } else {
          // "Same module" v1 = same directory.
          const sd = sym.file_path.includes('/') ? sym.file_path.slice(0, sym.file_path.lastIndexOf('/')) : '';
          const cd = c.file_path.includes('/') ? c.file_path.slice(0, c.file_path.lastIndexOf('/')) : '';
          if (sd === cd) {
            sameModuleCollisions.push({ name: c.name, kind: c.kind, file: c.file_path, line: c.line });
          }
        }
      }
    }

    const { risk, reasons } = classifyRenameRisk({
      callerCount,
      refKinds,
      importerCount: importerFiles.size,
      childCount: childRows.length,
      parentCount: parentRows.length,
      sameFileCollisions: sameFileCollisions.length,
      sameModuleCollisions: sameModuleCollisions.length,
    });

    const result: RenameSafetyResult = {
      symbol: {
        name: sym.name,
        kind: sym.kind,
        file: sym.file_path,
        line: sym.line,
        language: sym.file_language,
      },
      callers: {
        count: callerCount,
        ref_kinds: refKinds,
        files: [...callerFiles].sort(),
      },
      importers: {
        count: importerFiles.size,
        files: [...importerFiles].sort(),
      },
      relations: {
        children: { count: childRows.length, kinds: childKinds },
        parents: { count: parentRows.length, kinds: parentKinds },
      },
      collisions: {
        same_file: sameFileCollisions,
        same_module: sameModuleCollisions,
      },
      blast_radius: callerCount + importerFiles.size + childRows.length,
      risk,
      reasons,
    };
    return this.wrap('rename_safety', queryText, [result], start);
  }

  /**
   * Refactor preview (B6 v2) — dry-run of a rename. Returns every edit site a
   * tooling layer would touch (definition + callers + importers + subclasses
   * + method overrides) grouped by file, plus the same risk verdict as
   * renameSafety so the caller doesn't make two queries.
   *
   * Composes existing store queries (no new SQL): occurrences for caller
   * sites, module_edges for importer sites, relation_edges (kind='extends_class'
   * or 'implements') for subclass/implementer sites, relation_edges
   * (kind='overrides_method') for method overrides.
   *
   * Notes:
   * - "edits" are *suggested* sites. The renamer must still walk the source
   *   to confirm — Nexus reports occurrences with line+col, not byte offsets.
   * - Importer rows produce one synthetic edit per (file, line) pair pointing
   *   at the import statement; the actual identifier offset is best-effort.
   * - Subclass/implementer/override roles are surfaced as informational sites
   *   (line of the heritage clause / method declaration).
   */
  refactorPreview(
    name: string,
    opts?: { file?: string; new_name?: string },
  ): NexusResult<RefactorPreviewResult> {
    const start = performance.now();
    const queryText = `refactor-preview ${name}${opts?.file ? ` --file ${opts.file}` : ''}${opts?.new_name ? ` --new ${opts.new_name}` : ''}`;

    const candidates = this.store.getSymbolsWithFile(name);
    const sym = opts?.file
      ? candidates.find(c => c.file_path === opts.file || c.file_path.endsWith(opts.file!))
      : candidates[0];
    if (!sym) {
      const empty: RefactorPreviewResult = {
        symbol: { name, kind: '', file: opts?.file ?? '', line: 0, language: '' },
        new_name: opts?.new_name ?? null,
        risk: 'low',
        reasons: ['symbol_not_found'],
        blast_radius: 0,
        files_affected: 0,
        edits_total: 0,
        by_file: [],
        collisions: { same_file: [], same_module: [] },
      };
      return this.wrap('refactor_preview', queryText, [empty], start);
    }

    // ── Aggregate edits by file ────────────────────────────────────────
    const byFileMap = new Map<string, { edits: RefactorPreviewEdit[]; kinds: Set<string> }>();
    const ensure = (file: string): { edits: RefactorPreviewEdit[]; kinds: Set<string> } => {
      const existing = byFileMap.get(file);
      if (existing) return existing;
      const fresh = { edits: [] as RefactorPreviewEdit[], kinds: new Set<string>() };
      byFileMap.set(file, fresh);
      return fresh;
    };

    // Definition edit (always first edit in the symbol's file).
    {
      const bucket = ensure(sym.file_path);
      bucket.edits.push({
        line: sym.line,
        col: sym.col,
        role: 'definition',
        context: sym.signature ?? sym.name,
      });
      bucket.kinds.add('definition');
    }

    // Caller / type-ref / read / write edits — every occurrence except the
    // declaration row at (file, line) of the symbol itself.
    const occRows = this.store.getOccurrencesWithFile(name);
    const callerFiles = new Set<string>();
    let callerCount = 0;
    const refKinds: Record<string, number> = {};
    for (const o of occRows) {
      if (o.file_path === sym.file_path && o.line === sym.line) continue;
      const bucket = ensure(o.file_path);
      bucket.edits.push({
        line: o.line,
        col: o.col,
        role: 'caller',
        context: o.context ?? '',
        ...(o.ref_kind ? { ref_kind: o.ref_kind } : {}),
      });
      bucket.kinds.add('caller');
      callerFiles.add(o.file_path);
      callerCount++;
      const rk = o.ref_kind ?? 'unknown';
      refKinds[rk] = (refKinds[rk] ?? 0) + 1;
    }

    // Importer edits — one per importing module_edge that names this symbol.
    const imports = this.store.getImportersByResolvedFileId(sym.file_id);
    const importerFiles = new Set<string>();
    for (const e of imports) {
      if (!(e.is_star || e.name === name || e.alias === name)) continue;
      const bucket = ensure(e.file_path);
      bucket.edits.push({
        line: e.line,
        col: 0,
        role: 'importer',
        context: e.source ? `import from '${e.source}'` : 'import',
      });
      bucket.kinds.add('importer');
      importerFiles.add(e.file_path);
    }

    // Subclass / implementer / override sites — surfaces children edges
    // grouped by their relation kind.
    const childRows = this.store.getRelationsByTarget(name);
    for (const r of childRows) {
      const bucket = ensure(r.source_file);
      let role: RefactorPreviewEdit['role'];
      if (r.kind === 'extends_class') role = 'subclass';
      else if (r.kind === 'implements') role = 'implementer';
      else if (r.kind === 'overrides_method') role = 'override';
      else continue;
      bucket.edits.push({
        line: r.line,
        col: 0,
        role,
        context: `${r.kind} ${r.source_name}`,
      });
      bucket.kinds.add(role);
    }

    // Collisions for new_name (mirrors renameSafety).
    const sameFileCollisions: { name: string; kind: string; line: number }[] = [];
    const sameModuleCollisions: { name: string; kind: string; file: string; line: number }[] = [];
    if (opts?.new_name && opts.new_name !== name) {
      const colliders = this.store.getSymbolsWithFile(opts.new_name);
      for (const c of colliders) {
        if (c.file_path === sym.file_path) {
          sameFileCollisions.push({ name: c.name, kind: c.kind, line: c.line });
        } else {
          const sd = sym.file_path.includes('/')
            ? sym.file_path.slice(0, sym.file_path.lastIndexOf('/'))
            : '';
          const cd = c.file_path.includes('/')
            ? c.file_path.slice(0, c.file_path.lastIndexOf('/'))
            : '';
          if (sd === cd) {
            sameModuleCollisions.push({ name: c.name, kind: c.kind, file: c.file_path, line: c.line });
          }
        }
      }
    }

    // Risk verdict — same classifier as renameSafety so the two are aligned.
    const parentRows = this.store.getRelationsBySource(name);
    const { risk, reasons } = classifyRenameRisk({
      callerCount,
      refKinds,
      importerCount: importerFiles.size,
      childCount: childRows.length,
      parentCount: parentRows.length,
      sameFileCollisions: sameFileCollisions.length,
      sameModuleCollisions: sameModuleCollisions.length,
    });

    // Materialize by_file: sort files alphabetically, edits within a file
    // by (line, col) for stable preview output.
    const byFile: RefactorPreviewFile[] = [...byFileMap.entries()]
      .map(([file, b]) => ({
        file,
        edits: [...b.edits].sort((a, c) => a.line - c.line || a.col - c.col),
        kinds: [...b.kinds].sort(),
      }))
      .sort((a, b) => a.file.localeCompare(b.file));

    const editsTotal = byFile.reduce((acc, f) => acc + f.edits.length, 0);

    const result: RefactorPreviewResult = {
      symbol: {
        name: sym.name,
        kind: sym.kind,
        file: sym.file_path,
        line: sym.line,
        language: sym.file_language,
      },
      new_name: opts?.new_name ?? null,
      risk,
      reasons,
      blast_radius: callerCount + importerFiles.size + childRows.length,
      files_affected: byFile.length,
      edits_total: editsTotal,
      by_file: byFile,
      collisions: {
        same_file: sameFileCollisions,
        same_module: sameModuleCollisions,
      },
    };
    return this.wrap('refactor_preview', queryText, [result], start);
  }

  /**
   * Clarify (D2 v1) — given a name with multiple definitions, return every
   * candidate plus the disambiguators an agent needs to pick precisely
   * (file/kind/scope/signature/exported/importer count/relation summary).
   *
   * Ranking heuristic for `suggested_picks`:
   *   1. Highest importer_count → "most-used".
   *   2. Has children edges (extends/implements) → "base type for the hierarchy".
   *   3. Alphabetic file path tie-breaker for determinism.
   */
  clarify(name: string): NexusResult<ClarifyResult> {
    const start = performance.now();
    const queryText = `clarify ${name}`;

    const rows = this.store.getSymbolsWithFile(name);
    const candidates: ClarifyCandidate[] = rows.map(row => {
      // Importer count: number of distinct files that import row's file
      // and reference this name (or star-import). Cheap heuristic for "popularity".
      let importerCount = 0;
      try {
        const importers = this.store.getImportersByResolvedFileId(row.file_id);
        const seen = new Set<string>();
        for (const e of importers) {
          if (e.is_star || e.name === name || e.alias === name) seen.add(e.file_path);
        }
        importerCount = seen.size;
      } catch { /* best-effort */ }

      // Relation summary: parent + child edge counts (only for class/interface).
      let relationSummary: string | undefined;
      if (row.kind === 'class' || row.kind === 'interface') {
        try {
          const children = this.store.getRelationsByTarget(name);
          const parents = this.store.getRelationsBySource(name);
          // Filter children to those whose target file matches this row.
          const childCount = children.filter(c =>
            c.target_file === row.file_path || c.target_file === undefined
          ).length;
          const parentCount = parents.filter(p => p.source_file === row.file_path).length;
          const parts: string[] = [];
          if (parentCount > 0) parts.push(`extends/implements ${parentCount}`);
          if (childCount > 0) parts.push(`${childCount} child${childCount === 1 ? '' : 'ren'}`);
          if (parts.length > 0) relationSummary = parts.join(', ');
        } catch { /* best-effort */ }
      }

      return {
        file: row.file_path,
        line: row.line,
        kind: row.kind,
        ...(row.scope ? { scope: row.scope } : {}),
        ...(row.signature ? { signature: row.signature } : {}),
        language: row.file_language,
        is_export: this.isExportedSymbol(row.file_id, name),
        importer_count: importerCount,
        ...(relationSummary ? { relation_summary: relationSummary } : {}),
      };
    });

    // Build suggested_picks with deterministic ordering.
    const suggestedPicks: { rationale: string; index: number }[] = [];
    if (candidates.length > 1) {
      const indexed = candidates.map((c, i) => ({ c, i }));
      const mostUsed = indexed
        .filter(x => x.c.importer_count > 0)
        .sort((a, b) =>
          b.c.importer_count - a.c.importer_count || a.c.file.localeCompare(b.c.file)
        )[0];
      if (mostUsed) {
        suggestedPicks.push({
          rationale: `most-used (${mostUsed.c.importer_count} importer${mostUsed.c.importer_count === 1 ? '' : 's'})`,
          index: mostUsed.i,
        });
      }
      const baseType = indexed
        .filter(x => x.c.relation_summary?.includes('child'))
        .sort((a, b) => a.c.file.localeCompare(b.c.file))[0];
      if (baseType && baseType.i !== mostUsed?.i) {
        suggestedPicks.push({
          rationale: `base type for the hierarchy (${baseType.c.relation_summary})`,
          index: baseType.i,
        });
      }
    }

    const uniqueFiles = [...new Set(candidates.map(c => c.file))].sort();
    const uniqueKinds = [...new Set(candidates.map(c => c.kind))].sort();
    const uniqueScopes = [...new Set(candidates.map(c => c.scope).filter((s): s is string => !!s))].sort();

    const result: ClarifyResult = {
      name,
      candidates,
      count: candidates.length,
      unique_disambiguators: {
        files: uniqueFiles,
        kinds: uniqueKinds,
        scopes: uniqueScopes,
      },
      suggested_picks: suggestedPicks,
    };
    return this.wrap('clarify', queryText, [result], start);
  }

  /**
   * Helper for clarify(): does this file_id export `name`? Checks module_edges
   * for an export row matching the name, or any export with is_default=1
   * when the symbol is the file's default export.
   */
  private isExportedSymbol(fileId: number, name: string): boolean {
    const exports = this.store.getExportsByFileId(fileId);
    return exports.some(e => e.name === name || e.alias === name);
  }

  /**
   * Token-budget-aware context bundler. Greedy: outlines first (cheap, high
   * coverage), then top-ranked sources, then directly-imported file outlines.
   * Token estimate is chars/4 — deterministic and fast, deliberately rough.
   */
  pack(
    queryText: string,
    opts?: { budget_tokens?: number; paths?: string[] },
  ): NexusResult<PackResult> {
    const start = performance.now();
    const budget = Math.min(Math.max(opts?.budget_tokens ?? 4000, 200), 50000);
    const queryStr = `pack ${queryText} --budget ${budget}${opts?.paths ? ` --paths ${opts.paths.join(',')}` : ''}`;

    const ranked: (SymbolWithFile & { _score: number })[] = [];
    const paths = opts?.paths && opts.paths.length > 0 ? opts.paths : [undefined];

    for (const p of paths) {
      const search = this.search(queryText, 30, undefined, p);
      for (const r of search.results) {
        // Re-look up the row so we have the SymbolWithFile shape
        const matches = this.store.getSymbolsWithFile(r.name);
        for (const m of matches) {
          if (m.file_path === r.file && m.line === r.line) {
            ranked.push({ ...m, _score: (r as { _score?: number })._score ?? 0 });
            break;
          }
        }
      }
    }

    ranked.sort((a, b) => b._score - a._score);

    const included: PackedItem[] = [];
    const skipped: PackResult['skipped'] = [];
    let totalTokens = 0;
    const seenOutlines = new Set<string>();
    const seenSources = new Set<string>();

    const tryAdd = (item: PackedItem, cap: number): boolean => {
      if (totalTokens + item.tokens > cap) {
        skipped.push({
          file: item.file,
          kind: item.kind,
          ...(item.name ? { name: item.name } : {}),
          reason: 'budget',
        });
        return false;
      }
      included.push(item);
      totalTokens += item.tokens;
      return true;
    };

    // Phase A — file outlines for every file containing a top hit (~30%)
    const phaseACap = Math.floor(budget * 0.3);
    for (const sym of ranked) {
      if (seenOutlines.has(sym.file_path)) continue;
      const outline = this.outline(sym.file_path);
      if (outline.results.length === 0) continue;
      const payload = outline.results[0];
      const tokens = estimateTokens(JSON.stringify(payload));
      if (!tryAdd({ file: sym.file_path, kind: 'outline', tokens, payload }, phaseACap)) break;
      seenOutlines.add(sym.file_path);
    }

    // Phase B — top symbol sources (~60% cumulative)
    const phaseBCap = Math.floor(budget * 0.6);
    for (const sym of ranked) {
      const key = `${sym.file_path}\0${sym.name}`;
      if (seenSources.has(key)) continue;
      const source = this.getSourceForSymbol(sym);
      if (!source) continue;
      const tokens = estimateTokens(source.source);
      if (!tryAdd({ file: sym.file_path, kind: 'source', name: sym.name, tokens, payload: source }, phaseBCap)) {
        if (totalTokens >= phaseBCap) break;
        continue;
      }
      seenSources.add(key);
    }

    // Phase C — direct imports of files we've touched (remaining budget)
    const touchedFileIds = new Set<number>();
    for (const sym of ranked) touchedFileIds.add(sym.file_id);
    for (const fileId of touchedFileIds) {
      const importEdges = this.store.getImportsByFileId(fileId);
      for (const edge of importEdges) {
        if (edge.resolved_file_id == null) continue;
        const importedFile = this.store.getFileById(edge.resolved_file_id);
        if (!importedFile) continue;
        if (seenOutlines.has(importedFile.path)) continue;
        const outline = this.outline(importedFile.path);
        if (outline.results.length === 0) continue;
        const payload = outline.results[0];
        const tokens = estimateTokens(JSON.stringify(payload));
        if (!tryAdd({ file: importedFile.path, kind: 'outline', tokens, payload }, budget)) break;
        seenOutlines.add(importedFile.path);
      }
      if (totalTokens >= budget) break;
    }

    const result: PackResult = {
      query: queryText,
      budget_tokens: budget,
      total_tokens: totalTokens,
      included,
      skipped,
    };
    const wrapped = this.wrap('pack', queryStr, [result], start);
    this.budgetLedger.record({
      query: queryText,
      budget_tokens: budget,
      total_tokens: totalTokens,
      included_count: included.length,
      skipped_count: skipped.length,
      timing_ms: wrapped.timing_ms,
      timestamp: new Date().toISOString(),
    });
    return wrapped;
  }

  /**
   * Files changed since `ref` (default HEAD~1) with their current outlines.
   * Uses git when available; falls back to mtime > last_index_run.completed_at.
   */
  changed(opts?: { ref?: string }): NexusResult<ChangedResult> {
    const start = performance.now();
    const ref = opts?.ref ?? 'HEAD~1';
    const queryStr = `changed --ref ${ref}`;

    const root = this.getSourceRoot();
    const indexedByPath = new Map<string, FileRow & { id: number }>();
    for (const f of this.store.getAllFiles()) {
      indexedByPath.set(normalizePath(f.path), f);
    }

    let files: ChangedFile[] = [];
    let source: 'git' | 'mtime' = 'mtime';

    try {
      const out = execFileSync('git', ['diff', '--name-status', `${ref}...HEAD`], {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      source = 'git';
      const lines = out.split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.split(/\s+/);
        const status = parts[0];
        const filePath = normalizePath(parts[parts.length - 1]);
        const change_type: 'A' | 'M' | 'D' =
          status.startsWith('A') ? 'A' : status.startsWith('D') ? 'D' : 'M';
        const indexed = indexedByPath.get(filePath);
        if (change_type !== 'D' && indexed) {
          const outline = this.outline(filePath);
          files.push({
            path: filePath,
            change_type,
            ...(outline.results[0] ? { outline: outline.results[0] } : {}),
          });
        } else {
          files.push({ path: filePath, change_type });
        }
      }
    } catch {
      // mtime fallback
      const lastRun = this.store.getLastIndexRun();
      const cutoff = lastRun?.completed_at ? Date.parse(lastRun.completed_at) / 1000 : 0;
      for (const file of indexedByPath.values()) {
        if (file.mtime > cutoff) {
          const outline = this.outline(file.path);
          files.push({
            path: file.path,
            change_type: 'M',
            ...(outline.results[0] ? { outline: outline.results[0] } : {}),
          });
        }
      }
    }

    return this.wrap('changed', queryStr, [{ ref, source, files }], start);
  }

  /**
   * Semantic diff: which symbols were added/removed/modified between two refs.
   * Re-parses historical content via `git show` through the live extractor.
   */
  diffOutline(
    refA: string,
    refB?: string,
  ): NexusResult<DiffOutlineResult> {
    const start = performance.now();
    const target = refB ?? 'HEAD';
    const queryStr = `diff_outline ${refA} ${target}`;

    const root = this.getSourceRoot();
    const indexedByPath = new Map<string, FileRow & { id: number }>();
    for (const f of this.store.getAllFiles()) {
      indexedByPath.set(normalizePath(f.path), f);
    }

    let changedPaths: { path: string; status: string }[] = [];
    try {
      const out = execFileSync('git', ['diff', '--name-status', `${refA}..${target}`], {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      changedPaths = out
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const parts = line.split(/\s+/);
          return { status: parts[0], path: normalizePath(parts[parts.length - 1]) };
        });
    } catch (err) {
      return this.wrap('diff_outline', queryStr, [{
        ref_a: refA,
        ref_b: target,
        files: [],
      }], start);
    }

    const files: DiffOutlineFile[] = [];

    for (const { path: filePath, status } of changedPaths) {
      const indexed = indexedByPath.get(filePath);
      if (!indexed) continue;

      const beforeSyms = readHistoricalSymbols(root, refA, filePath, indexed.language);
      const afterSyms = status.startsWith('D')
        ? []
        : readHistoricalSymbols(root, target, filePath, indexed.language);

      const beforeMap = new Map(beforeSyms.map(s => [`${s.kind}\0${s.name}`, s]));
      const afterMap = new Map(afterSyms.map(s => [`${s.kind}\0${s.name}`, s]));

      const added: DiffOutlineEntry[] = [];
      const removed: DiffOutlineEntry[] = [];
      const modified: DiffOutlineFile['modified'] = [];

      for (const [key, after] of afterMap) {
        if (!beforeMap.has(key)) {
          added.push(after);
        } else {
          const before = beforeMap.get(key)!;
          if ((before.signature ?? '') !== (after.signature ?? '')) {
            modified.push({ name: after.name, kind: after.kind, before, after });
          }
        }
      }
      for (const [key, before] of beforeMap) {
        if (!afterMap.has(key)) removed.push(before);
      }

      if (added.length || removed.length || modified.length) {
        files.push({ path: filePath, added, removed, modified });
      }
    }

    return this.wrap('diff_outline', queryStr, [{ ref_a: refA, ref_b: target, files }], start);
  }

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
    const root = this.getSourceRoot();
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
   * Read a structured file and extract the value at a dotted path.
   * Path syntax: dotted keys; numeric segments index into arrays.
   *   "scripts.test", "dependencies.react", "jobs.test.steps.0.run"
   * Keys containing dots are not supported; use structuredOutline to confirm structure.
   */
  structuredQuery(filePath: string, queryPath: string): NexusResult<StructuredQueryResult> {
    const start = performance.now();
    const root = this.getSourceRoot();
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
    const basename = path.basename(filePath);
    const rel = root ? normalizePath(path.relative(root, absPath)) : normalizePath(filePath);
    const kind = classifyPath(rel, basename, { languages: {} });

    const make = (r: Partial<StructuredQueryResult>): NexusResult<StructuredQueryResult> => {
      const result: StructuredQueryResult = {
        file: filePath, path: queryPath, kind: kind.kind, found: false, ...r,
      };
      return this.wrap('structured_query', `structured_query ${filePath} ${queryPath}`, [result], start);
    };

    const loaded = loadStructuredFile(absPath, kind.kind);
    if (loaded === null) return make({ error: 'not a structured file' });
    const err = asLoadError(loaded);
    if (err) {
      return make({
        error: err.error,
        ...(err.limit !== undefined ? { limit: err.limit } : {}),
        ...(err.actual !== undefined ? { actual: err.actual } : {}),
      });
    }

    const value = resolveDottedPath(loaded, queryPath);
    if (value === undefined) return make({ found: false });
    return make({ found: true, value });
  }

  /**
   * Read a structured file and list its top-level keys with value kinds.
   * Shallow only — no recursion, no line anchors (V3 spec defers anchors).
   */
  structuredOutline(filePath: string): NexusResult<StructuredOutlineFileResult> {
    const start = performance.now();
    const root = this.getSourceRoot();
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
    const basename = path.basename(filePath);
    const rel = root ? normalizePath(path.relative(root, absPath)) : normalizePath(filePath);
    const kind = classifyPath(rel, basename, { languages: {} });

    const make = (r: Partial<StructuredOutlineFileResult>): NexusResult<StructuredOutlineFileResult> => {
      const result: StructuredOutlineFileResult = {
        file: filePath, kind: kind.kind, entries: [], ...r,
      };
      return this.wrap('structured_outline', `structured_outline ${filePath}`, [result], start);
    };

    const loaded = loadStructuredFile(absPath, kind.kind);
    if (loaded === null) return make({ error: 'not a structured file' });
    const err = asLoadError(loaded);
    if (err) return make({ error: err.error });

    if (loaded === undefined || loaded === null || typeof loaded !== 'object') {
      return make({ error: 'root is not a mapping' });
    }

    const entries: StructuredOutlineEntry[] = [];
    if (Array.isArray(loaded)) {
      for (let i = 0; i < loaded.length; i++) {
        entries.push(describeEntry(String(i), loaded[i]));
      }
    } else {
      for (const [k, v] of Object.entries(loaded as Record<string, unknown>)) {
        entries.push(describeEntry(k, v));
      }
    }
    return make({ entries });
  }

  /**
   * List `{name, version}` entries from a lockfile. Supported kinds:
   *   - yarn.lock
   *   - package-lock.json (lockfileVersion 1/2/3)
   *   - pnpm-lock.yaml (v6+ and legacy v5 keys)
   *   - Cargo.lock
   *
   * If `name` is provided, entries are filtered to exact matches (multiple
   * versions of the same package are preserved).
   */
  lockfileDeps(filePath: string, name?: string): NexusResult<LockfileDepsResult> {
    const start = performance.now();
    const root = this.getSourceRoot();
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
    const basename = path.basename(filePath);
    const rel = root ? normalizePath(path.relative(root, absPath)) : normalizePath(filePath);
    const kind = classifyPath(rel, basename, { languages: {} });

    const make = (r: Partial<LockfileDepsResult>): NexusResult<LockfileDepsResult> => {
      const result: LockfileDepsResult = {
        file: filePath, kind: kind.kind, entries: [], ...r,
      };
      return this.wrap('lockfile_deps', `lockfile_deps ${filePath}${name ? ' ' + name : ''}`, [result], start);
    };

    const loaded = loadLockfile(absPath, kind.kind);
    if (loaded === null) return make({ error: 'not a lockfile' });
    const err = asLoadError(loaded);
    if (err) {
      return make({
        error: err.error,
        ...(err.limit !== undefined ? { limit: err.limit } : {}),
        ...(err.actual !== undefined ? { actual: err.actual } : {}),
      });
    }

    const entries = (loaded as { entries: { name: string; version: string }[] }).entries;
    const filtered = name ? entries.filter(e => e.name === name) : entries;
    return make({ entries: filtered });
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
  opts?: { file?: string; limit?: number; ref_kinds?: string[] },
): string {
  return `slice ${name}${opts?.file ? ` --file ${opts.file}` : ''}${opts?.limit ? ` --limit ${opts.limit}` : ''}${opts?.ref_kinds?.length ? ` --ref-kinds ${opts.ref_kinds.join(',')}` : ''}`;
}

/** Cheap deterministic token estimate (chars / 4). */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Read a file at a historical git ref and re-extract its top-level symbols.
 * Returns an empty array when the file did not exist at that ref.
 */
function readHistoricalSymbols(
  root: string,
  ref: string,
  filePath: string,
  language: string,
): DiffOutlineEntry[] {
  let content: string;
  try {
    content = execFileSync('git', ['show', `${ref}:${filePath}`], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return [];
  }

  const result = extractSource(content, filePath, language);
  if (!result.parsed) return [];

  return result.symbols.map(s => ({
    name: s.name,
    kind: s.kind,
    line: s.line,
    ...(s.signature ? { signature: s.signature } : {}),
  }));
}

/** Extract the identifier (word boundary) at column `col` from a line. */
function pickIdentifierAt(lineText: string, col?: number): string | null {
  const idRegex = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  const matches: { word: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = idRegex.exec(lineText)) !== null) {
    matches.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (matches.length === 0) return null;
  if (col == null) return matches[0].word;

  // Columns from MCP/CLI are typically 1-based; line offsets are 0-based.
  const offset = Math.max(0, col - 1);
  const hit = matches.find(x => offset >= x.start && offset <= x.end);
  if (hit) return hit.word;
  // Nearest fallback
  let nearest = matches[0];
  let best = Math.abs(offset - nearest.start);
  for (const m of matches) {
    const d = Math.min(Math.abs(offset - m.start), Math.abs(offset - m.end));
    if (d < best) { best = d; nearest = m; }
  }
  return nearest.word;
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

/**
 * Dispatch to the right A2 loader based on FileKind. Returns:
 *   - parsed value on success (object / array / scalar / null)
 *   - `{ error, limit?, actual? }` on loader error
 *   - `null` if the kind isn't a supported structured file
 */
function loadStructuredFile(absPath: string, kindStr: string): unknown {
  switch (kindStr) {
    case 'package_json': return loadPackageJson(absPath);
    case 'tsconfig_json': return loadTsconfig(absPath);
    case 'cargo_toml': return loadCargoToml(absPath);
    case 'gha_workflow': return loadGhaWorkflow(absPath);
    case 'json_generic': return loadGenericJson(absPath);
    case 'yaml_generic': return loadGenericYaml(absPath);
    case 'toml_generic': return loadGenericToml(absPath);
    default: return null;
  }
}

/**
 * Dispatch to the right lockfile loader based on FileKind. Returns:
 *   - ParsedXxxLock on success
 *   - `{ error, limit?, actual? }` on loader error
 *   - `null` if the kind isn't a supported lockfile
 */
function loadLockfile(absPath: string, kindStr: string): unknown {
  switch (kindStr) {
    case 'yarn_lock': return loadYarnLock(absPath);
    case 'package_lock': return loadPackageLock(absPath);
    case 'pnpm_lock': return loadPnpmLock(absPath);
    case 'cargo_lock': return loadCargoLock(absPath);
    default: return null;
  }
}

/** Narrow a loader return to an error object if it is one. */
function asLoadError(v: unknown): { error: string; limit?: number; actual?: number } | null {
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.error !== 'string') return null;
  const out: { error: string; limit?: number; actual?: number } = { error: obj.error };
  if (typeof obj.limit === 'number') out.limit = obj.limit;
  if (typeof obj.actual === 'number') out.actual = obj.actual;
  return out;
}

/**
 * Walk a dotted path ("a.b.0.c") into a parsed structured value.
 * Numeric segments index into arrays when the current node is an array.
 * Returns undefined on any missing step.
 */
function resolveDottedPath(root: unknown, dotted: string): unknown {
  const parts = dotted.split('.').filter(p => p.length > 0);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function describeEntry(key: string, value: unknown): StructuredOutlineEntry {
  const kind = valueKind(value);
  const entry: StructuredOutlineEntry = { key, value_kind: kind };
  if (kind === 'array' && Array.isArray(value)) entry.length = value.length;
  const preview = makePreview(value, kind);
  if (preview !== null) entry.preview = preview;
  return entry;
}

function valueKind(v: unknown): StructuredValueKind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  if (t === 'object') return 'object';
  return 'null';
}

function makePreview(v: unknown, kind: StructuredValueKind): string | null {
  switch (kind) {
    case 'string': {
      const s = v as string;
      return JSON.stringify(s.length > 78 ? s.slice(0, 75) + '...' : s);
    }
    case 'number':
    case 'boolean':
    case 'null':
      return JSON.stringify(v);
    case 'array':
    case 'object':
      return null;
  }
}
