import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDatabase, applySchema, initializeMeta, SCHEMA_VERSION, EXTRACTOR_VERSION } from '../db/schema.js';
import { NexusStore } from '../db/store.js';
import type { FileRow, SymbolRow, ModuleEdgeRow, OccurrenceRow } from '../db/store.js';
import { IndexLock } from './state.js';
import { loadConfig, computeConfigHash } from '../config.js';
import type { NexusConfig } from '../config.js';
import { detectRoot, detectCaseSensitivity, getGitHead } from '../workspace/detector.js';
import { buildIgnoreMatcher } from '../workspace/ignores.js';
import { scanDirectory, buildExtraExtensions } from '../workspace/scanner.js';
import { detectChanges, summarizeChanges } from '../workspace/changes.js';
import type { FileChange } from '../workspace/changes.js';
import { extractFile } from '../analysis/extractor.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface IndexResult {
  mode: 'full' | 'incremental';
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  durationMs: number;
}

/**
 * Buffer for extracted file data, accumulated during Phase 1.
 */
interface FileBuffer {
  fileRow: FileRow;
  symbols: Omit<SymbolRow, 'id' | 'file_id'>[];
  edges: Omit<ModuleEdgeRow, 'id' | 'file_id' | 'symbol_id' | 'resolved_file_id'>[];
  occurrences: Omit<OccurrenceRow, 'id' | 'file_id'>[];
}

// ── Orchestrator ────────────────────────────────────────────────────────

/**
 * Run a full or incremental index rebuild.
 *
 * Two-phase design:
 *   Phase 1 — Scan + parse (no DB write lock): filesystem scan, change
 *     detection, tree-sitter extraction. All results held in memory.
 *   Phase 2 — Publish (short atomic transaction): delete stale rows,
 *     insert new data, update meta. Readers see old or new, never partial.
 *
 * @param startDir — Directory to detect project root from (defaults to cwd)
 * @param forceRebuild — If true, skip invalidation checks and do a full rebuild
 */
export function runIndex(startDir?: string, forceRebuild = false): IndexResult {
  const start = Date.now();

  // ── Setup ───────────────────────────────────────────────────────────
  const rootDir = detectRoot(startDir ?? process.cwd());
  const config = loadConfig(rootDir);
  const configHash = computeConfigHash(config);
  const caseSensitive = detectCaseSensitivity(rootDir);
  const gitHead = getGitHead(rootDir);

  const dbPath = path.join(rootDir, '.nexus', 'index.db');
  ensureDir(path.dirname(dbPath));

  const db = openDatabase(dbPath);
  applySchema(db);
  const store = new NexusStore(db);

  // ── Lock ────────────────────────────────────────────────────────────
  const lock = new IndexLock(db);
  if (!lock.acquire()) {
    db.close();
    throw new Error('Index is locked by another process');
  }

  try {
    // ── Invalidation check ──────────────────────────────────────────
    const mode = determineMode(store, rootDir, configHash, forceRebuild);

    if (mode === 'full') {
      // Initialize/reset meta for full rebuild
      initializeMeta(db, rootDir, caseSensitive);
      store.setMeta('config_hash', configHash);
      if (gitHead) store.setMeta('git_head', gitHead);
    }

    // ── Phase 1: Scan + Parse (no write lock) ───────────────────────
    const isIgnored = buildIgnoreMatcher(rootDir, config.exclude);
    const extraExt = buildExtraExtensions(config.languages);
    const scannedFiles = scanDirectory(rootDir, isIgnored, {
      maxFileSize: config.maxFileSize,
      minifiedLineLength: config.minifiedLineLength,
      extraExtensions: extraExt,
    });

    const dbFiles = mode === 'full' ? [] : store.getAllFiles();
    const changes = mode === 'full'
      ? scannedFiles.map(f => ({
          file: f,
          dbRow: null,
          action: 'add' as const,
          hash: hashFileSync(f.absolutePath),
        }))
      : detectChanges(scannedFiles, dbFiles, caseSensitive);

    const summary = summarizeChanges(
      mode === 'full' ? changes : changes,
    );

    // Extract data for new/changed files
    const addBuffers: FileBuffer[] = [];
    const updateBuffers: FileBuffer[] = [];
    const deleteIds: number[] = [];
    const hashOnlyChanges: FileChange[] = [];
    const now = new Date().toISOString();
    let filesErrored = 0;

    for (const change of changes) {
      switch (change.action) {
        case 'add': {
          const buf = extractAndBuffer(change, caseSensitive, now);
          if (buf) {
            addBuffers.push(buf);
          } else {
            filesErrored++;
          }
          break;
        }
        case 'update': {
          if (change.dbRow) deleteIds.push(change.dbRow.id);
          const buf = extractAndBuffer(change, caseSensitive, now);
          if (buf) {
            updateBuffers.push(buf);
          } else {
            filesErrored++;
          }
          break;
        }
        case 'delete': {
          if (change.dbRow) deleteIds.push(change.dbRow.id);
          break;
        }
        case 'hash_only': {
          hashOnlyChanges.push(change);
          break;
        }
        // 'unchanged' — nothing to do
      }
    }

    // Heartbeat before Phase 2
    lock.heartbeat();

    // ── Phase 2: Publish (atomic transaction) ───────────────────────
    const startedAt = new Date().toISOString();
    const runId = store.insertIndexRun({
      started_at: startedAt,
      mode,
      files_scanned: scannedFiles.length,
      files_indexed: 0,
      files_skipped: 0,
      files_errored: filesErrored,
      status: 'running',
    });

    store.runInTransaction(() => {
      // Delete stale/updated files (CASCADE removes children)
      if (mode === 'full') {
        // For full rebuild, delete ALL existing files
        const allFiles = store.getAllFiles();
        const allIds = allFiles.map(f => f.id);
        if (allIds.length > 0) {
          store.deleteFilesByIds(allIds);
        }
      } else if (deleteIds.length > 0) {
        store.deleteFilesByIds(deleteIds);
      }

      // Insert new/updated files + their children
      for (const buf of [...addBuffers, ...updateBuffers]) {
        const fileId = store.insertFile(buf.fileRow);

        if (buf.symbols.length > 0) {
          store.insertSymbols(
            buf.symbols.map(s => ({ ...s, file_id: fileId })),
          );
        }
        if (buf.edges.length > 0) {
          store.insertModuleEdges(
            buf.edges.map(e => ({
              ...e,
              file_id: fileId,
              symbol_id: null,
              resolved_file_id: null,
            })),
          );
        }
        if (buf.occurrences.length > 0) {
          store.insertOccurrences(
            buf.occurrences.map(o => ({ ...o, file_id: fileId })),
          );
        }
      }

      // Update mtime/size for hash_only changes
      for (const change of hashOnlyChanges) {
        if (change.dbRow && change.file) {
          store.updateFileMtime(change.dbRow.id, change.file.mtime, change.file.size);
        }
      }

      // Update meta
      store.setMeta('last_indexed_at', new Date().toISOString());
      if (gitHead) store.setMeta('git_head', gitHead);
      store.setMeta('config_hash', configHash);
    });

    // Finalize index run
    const filesIndexed = addBuffers.length + updateBuffers.length;
    store.updateIndexRun(runId, {
      completed_at: new Date().toISOString(),
      files_indexed: filesIndexed,
      files_skipped: summary.unchanged + summary.hashOnly,
      files_errored: filesErrored,
      status: 'completed',
    });

    const durationMs = Date.now() - start;

    return {
      mode,
      filesScanned: scannedFiles.length,
      filesIndexed,
      filesSkipped: summary.unchanged + summary.hashOnly,
      filesErrored,
      durationMs,
    };
  } finally {
    lock.release();
    db.close();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Determine if we need a full or incremental rebuild.
 */
function determineMode(
  store: NexusStore,
  rootDir: string,
  configHash: string,
  forceRebuild: boolean,
): 'full' | 'incremental' {
  if (forceRebuild) return 'full';

  const storedSchema = store.getMeta('schema_version');
  const storedExtractor = store.getMeta('extractor_version');
  const storedConfig = store.getMeta('config_hash');
  const storedRoot = store.getMeta('root_path');

  // No meta at all → fresh DB
  if (!storedSchema) return 'full';

  // Invalidation checks
  if (storedSchema !== String(SCHEMA_VERSION)) return 'full';
  if (storedExtractor !== String(EXTRACTOR_VERSION)) return 'full';
  if (storedConfig !== configHash) return 'full';
  if (storedRoot !== rootDir) return 'full';

  return 'incremental';
}

/**
 * Extract a file and buffer the results for Phase 2.
 */
function extractAndBuffer(
  change: FileChange,
  caseSensitive: boolean,
  indexedAt: string,
): FileBuffer | null {
  const file = change.file!;
  const result = extractFile(file.absolutePath, file.path, file.language);

  const pathKey = caseSensitive ? file.path : file.path.toLowerCase();

  if (!result.parsed) {
    // Return an error file row with no children
    return {
      fileRow: {
        path: file.path,
        path_key: pathKey,
        hash: change.hash ?? '',
        mtime: file.mtime,
        size: file.size,
        language: file.language,
        status: 'error',
        error: result.error,
        indexed_at: indexedAt,
      },
      symbols: [],
      edges: [],
      occurrences: [],
    };
  }

  return {
    fileRow: {
      path: file.path,
      path_key: pathKey,
      hash: change.hash ?? '',
      mtime: file.mtime,
      size: file.size,
      language: file.language,
      status: 'indexed',
      error: null,
      indexed_at: indexedAt,
    },
    symbols: result.symbols,
    edges: result.edges,
    occurrences: result.occurrences,
  };
}

/**
 * Synchronous file hash (re-exported from changes module).
 */
import { hashFile as hashFileSync } from '../workspace/changes.js';

/**
 * Ensure a directory exists.
 */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
