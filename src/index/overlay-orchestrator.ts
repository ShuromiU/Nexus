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
import { readAndHash } from '../workspace/changes.js';
import { runIndex, type IndexResult } from './orchestrator.js';

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
        const symMap = writer.insertSymbols(fileId, result.symbols);
        writer.insertModuleEdges(fileId, result.edges, symMap);
        writer.insertOccurrences(fileId, result.occurrences);
        indexed++;
      } else {
        errored++;
      }
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
