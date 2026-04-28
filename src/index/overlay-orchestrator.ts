/**
 * Overlay orchestrator — builds `<worktree>/.nexus/overlay.db` containing only
 * the files that diverge from the parent's `.nexus/index.db`. Falls back to a
 * full per-worktree index (`worktree-isolated`) when any compat gate fails.
 *
 * See plan: phases E + F. The merged TEMP views in `Store.attachOverlay()`
 * shadow `files`/`symbols`/`module_edges`/`occurrences` so existing query
 * code in `engine.ts` works unchanged.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION, EXTRACTOR_VERSION, openDatabase } from '../db/schema.js';
import { openOverlayWriter } from '../db/overlay.js';
import {
  gitHead,
  gitDiffNameStatus,
  gitDiffStaged,
  gitDiffUnstaged,
  gitLsFilesUntracked,
  gitMergeBaseIsAncestor,
  detectCaseSensitivity,
  type WorktreeWorkspaceInfo,
  type GitChange,
} from '../workspace/detector.js';
import { loadConfig } from '../config.js';
import { classifyPath, type ClassifyConfig } from '../workspace/classify.js';
import { extractSource } from '../analysis/extractor.js';
import type { ExtractedRelationEdge } from '../analysis/languages/registry.js';
import { readAndHash } from '../workspace/changes.js';
import { runIndex, resolveModulePath, type IndexResult } from './orchestrator.js';
import type { OverlayRelationRow } from '../db/overlay.js';
import type { SymbolRow, ModuleEdgeRow } from '../db/store.js';

export const MAX_OVERLAY_FILES = 500;

const CONFIG_FILES = new Set<string>([
  '.nexus.json',
  '.nexusignore',
  '.gitignore',
  'package.json',
  'tsconfig.json',
]);

export type OverlayBuildOutcome =
  | { kind: 'overlay'; result: IndexResult }
  | { kind: 'isolated'; result: IndexResult; reason: string };

/**
 * Compute the overlay-vs-isolated decision and build the appropriate index.
 * Always returns a usable index — never throws on gate failures (those become
 * worktree-isolated builds with `degraded_reason` recorded).
 */
export function buildWorktreeIndex(info: WorktreeWorkspaceInfo): OverlayBuildOutcome {
  const start = Date.now();
  const indexedAt = new Date().toISOString();

  const parentMeta = readParentMeta(info.baseIndexPath);
  const wtHead = gitHead(info.root);

  // Compat gate 1+2+3: parent index sanity.
  const parentGate = checkParentGate(parentMeta);
  if (parentGate) return fallbackToIsolated(info, parentGate, start);

  // We can only safely use parent_git_head as the diff base if it's an
  // ancestor of the worktree's HEAD.
  const base = parentMeta!.git_head!;
  if (!gitMergeBaseIsAncestor(info.root, base, 'HEAD')) {
    return fallbackToIsolated(info, 'diff_base_unreachable', start);
  }

  const changeSet = computeChangeSet(info.root, base);

  // Compat gate 4: config diverged.
  if (changeSet.some((c) => CONFIG_FILES.has(c.path))) {
    return fallbackToIsolated(info, 'config_diverged', start);
  }

  // Compat gate 5: change-set size cap.
  if (changeSet.length > MAX_OVERLAY_FILES) {
    return fallbackToIsolated(info, 'too_many_changes', start);
  }

  // Build overlay.
  const config = loadConfig(info.root);
  const caseSensitive = detectCaseSensitivity(info.root);
  const classifyConfig: ClassifyConfig = { languages: config.languages };
  const writer = openOverlayWriter(info.overlayPath);

  let scanned = 0;
  let indexed = 0;
  let skipped = 0;
  let errored = 0;
  const deleted: { path: string; path_key: string }[] = [];
  // Per-file relation context, deferred until all overlay files are inserted
  // so cross-file resolution can see every overlay path before falling back
  // to the parent index.
  const pendingRelations: PendingRelationFile[] = [];

  try {
    for (const change of changeSet) {
      scanned++;
      const pathKey = caseSensitive ? change.path : change.path.toLowerCase();

      if (change.status === 'D') {
        deleted.push({ path: change.path, path_key: pathKey });
        continue;
      }

      // Classify the path (extension/basename → language). Skip non-source.
      const basename = path.basename(change.path);
      const kind = classifyPath(change.path, basename, classifyConfig);
      if (kind.kind !== 'source') {
        skipped++;
        continue;
      }

      const fullPath = path.join(info.root, change.path);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        // File disappeared between diff and stat → treat as a deletion.
        deleted.push({ path: change.path, path_key: pathKey });
        continue;
      }
      if (!stat.isFile()) { skipped++; continue; }
      if (stat.size > config.maxFileSize) { skipped++; continue; }

      let source: string;
      let hash: string;
      try {
        ({ source, hash } = readAndHash(fullPath));
      } catch {
        errored++;
        continue;
      }

      const result = extractSource(source, change.path, kind.language);
      const fileId = writer.insertFile({
        path: change.path,
        path_key: pathKey,
        hash,
        mtime: stat.mtimeMs,
        size: stat.size,
        language: kind.language,
        status: result.parsed ? 'indexed' : 'error',
        error: result.parsed ? null : result.error,
        indexed_at: indexedAt,
      });

      if (result.parsed) {
        const { idsByName, idsByIndex } = writer.insertSymbols(fileId, result.symbols);
        writer.insertModuleEdges(fileId, result.edges, idsByName);
        writer.insertOccurrences(fileId, result.occurrences);
        if ((result.relations ?? []).length > 0) {
          pendingRelations.push({
            fileId,
            filePath: change.path,
            pathKey,
            relations: result.relations ?? [],
            edges: result.edges,
            symbols: result.symbols,
            symbolIdsByIndex: idsByIndex,
          });
        }
        indexed++;
      } else {
        errored++;
      }
    }

    // Resolve relation edges across overlay+parent and insert in one batch.
    if (pendingRelations.length > 0) {
      const rows = resolvePendingRelations(pendingRelations, info, caseSensitive);
      writer.insertRelationEdges(rows);
    }

    if (deleted.length > 0) writer.recordDeleted(deleted);

    writer.setMeta({
      parent_index_path: info.baseIndexPath,
      parent_git_head: base,
      git_head: wtHead,
      built_at: indexedAt,
      index_mode: 'overlay-on-parent',
      root_path: info.root,
      fs_case_sensitive: caseSensitive,
    });

    writer.publish();
  } catch (err) {
    writer.abort();
    // Last-resort fallback: try a full per-worktree index. Surface the
    // underlying error in degraded_reason so doctor can show it.
    const reason = `overlay_build_failed: ${err instanceof Error ? err.message : String(err)}`;
    return fallbackToIsolated(info, reason, start);
  }

  return {
    kind: 'overlay',
    result: {
      mode: 'overlay-on-parent',
      filesScanned: scanned,
      filesIndexed: indexed,
      filesSkipped: skipped + deleted.length,
      filesErrored: errored,
      durationMs: Date.now() - start,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface ParentMeta {
  git_head: string | null;
  clean_at_index_time: boolean | null;
  schema_version: string | null;
  extractor_version: string | null;
}

function readParentMeta(parentIndexPath: string): ParentMeta | null {
  if (!fs.existsSync(parentIndexPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = openDatabase(parentIndexPath, { readonly: true });
    const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      git_head: map.get('git_head') ?? null,
      clean_at_index_time: map.has('clean_at_index_time')
        ? map.get('clean_at_index_time') === 'true'
        : null,
      schema_version: map.get('schema_version') ?? null,
      extractor_version: map.get('extractor_version') ?? null,
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function checkParentGate(parentMeta: ParentMeta | null): string | null {
  if (!parentMeta) return 'parent_index_missing';
  if (!parentMeta.git_head) return 'parent_git_head_missing';
  if (parentMeta.clean_at_index_time !== true) return 'parent_dirty_at_index_time';
  if (parentMeta.schema_version !== String(SCHEMA_VERSION)) return 'schema_mismatch';
  if (parentMeta.extractor_version !== String(EXTRACTOR_VERSION)) return 'schema_mismatch';
  return null;
}

/**
 * Union of all four diff sources. Later sources override earlier on the same
 * path: committed → staged → unstaged → untracked. Untracked files are always
 * `A` (added).
 */
function computeChangeSet(rootDir: string, base: string): GitChange[] {
  const merged = new Map<string, GitChange>();
  const add = (c: GitChange): void => { merged.set(c.path, c); };
  for (const c of gitDiffNameStatus(rootDir, base)) add(c);
  for (const c of gitDiffStaged(rootDir)) add(c);
  for (const c of gitDiffUnstaged(rootDir)) add(c);
  for (const p of gitLsFilesUntracked(rootDir)) add({ status: 'A', path: p });
  return [...merged.values()];
}

/**
 * Build a full per-worktree index at `<worktree>/.nexus/index.db` using the
 * existing orchestrator, then stamp `index_mode = 'worktree-isolated'` and
 * `degraded_reason = <gate>` into its meta so `doctor` and the merged-view
 * layer can surface the reason.
 */
function fallbackToIsolated(
  info: WorktreeWorkspaceInfo,
  reason: string,
  start: number,
): OverlayBuildOutcome {
  // If a stale overlay exists from a prior successful build, remove it so it
  // doesn't shadow the now-authoritative isolated index.
  for (const p of [info.overlayPath, `${info.overlayPath}-wal`, `${info.overlayPath}-shm`]) {
    try { fs.unlinkSync(p); } catch { /* missing is fine */ }
  }

  const result = runIndex(info.root);

  // Stamp degradation flags onto the freshly-built isolated index.
  const isolatedDbPath = path.join(info.root, '.nexus', 'index.db');
  let db: Database.Database | null = null;
  try {
    db = new Database(isolatedDbPath);
    const stmt = db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)`);
    stmt.run('index_mode', 'worktree-isolated');
    stmt.run('degraded_reason', reason);
  } catch {
    /* meta stamp failure is non-fatal — runIndex already produced a working index */
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }

  return {
    kind: 'isolated',
    reason,
    result: { ...result, durationMs: Date.now() - start },
  };
}

// ─── Cross-file relation resolution (T12) ────────────────────────────

type ExtractedSymbol = Omit<SymbolRow, 'id' | 'file_id'>;
type ExtractedEdge = Omit<ModuleEdgeRow, 'id' | 'file_id' | 'symbol_id' | 'resolved_file_id'>;

interface PendingRelationFile {
  fileId: number;
  /** POSIX path of the file (used to derive importer dir for resolution). */
  filePath: string;
  /** path_key of this file (for same-file target resolution). */
  pathKey: string;
  relations: ExtractedRelationEdge[];
  edges: ExtractedEdge[];
  symbols: ExtractedSymbol[];
  /** Parallel to symbols — DB ids assigned at insert time. */
  symbolIdsByIndex: number[];
}

/**
 * Resolve overlay relation edges (same-file + cross-file) to path_keys.
 *
 * Strategy:
 *   1. Build a Map<pathKey, pathKey> covering all overlay files PLUS unchanged
 *      parent files (read once from the parent index, joined with the overlay's
 *      `deleted_files` mask).
 *   2. For each pending relation:
 *      a. If target_name is a top-level class/interface/type in the same file,
 *         set target_path_key = file's own path_key.
 *      b. Else, look up the file's import edges for one whose alias-or-name
 *         matches `target_name` (or the namespace prefix for `ns.X`).
 *      c. Resolve the import's raw `source` against the merged path_key map
 *         using the same trial-extension logic as the parent orchestrator.
 *      d. Set target_path_key = resolved path_key (or null if unresolved).
 *
 * The merged TEMP view in `Store.attachOverlay()` finishes the job: it takes
 * the path_key + target_name and looks up the actual symbol id in either
 * `overlay.symbols` or `main.symbols`.
 */
function resolvePendingRelations(
  pending: PendingRelationFile[],
  info: WorktreeWorkspaceInfo,
  caseSensitive: boolean,
): OverlayRelationRow[] {
  // Build the merged path_key map: overlay files override parent files; deleted
  // overlay paths mask parent files; otherwise parent files are reachable.
  const pathKeyMap = new Map<string, string>();
  for (const f of pending) pathKeyMap.set(f.pathKey, f.pathKey);

  // Read parent file path_keys (cheap — one query, no joins).
  const parentDb = openDatabase(info.baseIndexPath, { readonly: true });
  try {
    const parentPaths = parentDb
      .prepare("SELECT path_key FROM files WHERE status = 'indexed'")
      .all() as { path_key: string }[];
    for (const r of parentPaths) {
      if (!pathKeyMap.has(r.path_key)) pathKeyMap.set(r.path_key, r.path_key);
    }
  } finally {
    try { parentDb.close(); } catch { /* ignore */ }
  }

  const out: OverlayRelationRow[] = [];

  for (const file of pending) {
    // Same-file lookup: name → first matching top-level type id position.
    const localTypeNames = new Set<string>();
    for (const s of file.symbols) {
      if (s.kind === 'class' || s.kind === 'interface' || s.kind === 'type') {
        localTypeNames.add(s.name);
      }
    }

    // Build per-file import lookups (alias-or-name → import edge).
    const namedImports = new Map<string, ExtractedEdge>();
    const starImports = new Map<string, ExtractedEdge>();
    for (const e of file.edges) {
      if (e.kind !== 'import' && e.kind !== 'dynamic-import' && e.kind !== 'require') continue;
      if (e.is_star && e.alias) {
        starImports.set(e.alias, e);
      } else {
        const local = e.alias ?? e.name;
        if (local && !namedImports.has(local)) namedImports.set(local, e);
      }
    }

    const importerDir = file.filePath.includes('/')
      ? file.filePath.slice(0, file.filePath.lastIndexOf('/'))
      : '';

    for (const r of file.relations) {
      if (r.source_symbol_index < 0 || r.source_symbol_index >= file.symbolIdsByIndex.length) {
        continue;
      }
      const sourceId = file.symbolIdsByIndex[r.source_symbol_index];
      let targetPathKey: string | null = null;

      if (localTypeNames.has(r.target_name)) {
        // Same-file target.
        targetPathKey = file.pathKey;
      } else {
        const dotIdx = r.target_name.indexOf('.');
        let importEdge: ExtractedEdge | undefined;

        if (dotIdx > 0) {
          // ns.Name → namespace import.
          const ns = r.target_name.slice(0, dotIdx);
          const tail = r.target_name.slice(dotIdx + 1);
          if (!tail.includes('.')) {
            importEdge = starImports.get(ns);
          }
        } else if (/^[A-Za-z_$][\w$]*$/.test(r.target_name)) {
          // Bare identifier → named import.
          importEdge = namedImports.get(r.target_name);
        }
        // Call expressions / unsupported syntax → leave unresolved.

        if (importEdge && importEdge.source) {
          const resolved = resolveModulePath(
            importEdge.source, importerDir, caseSensitive, pathKeyMap,
          );
          if (resolved !== undefined) targetPathKey = resolved;
        }
      }

      out.push({
        file_id: file.fileId,
        source_id: sourceId,
        kind: r.kind,
        target_name: r.target_name,
        target_path_key: targetPathKey,
        confidence: r.confidence,
        line: r.line,
      });
    }
  }

  return out;
}
