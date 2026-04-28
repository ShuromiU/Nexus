import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDatabase, applySchema, initializeMeta, SCHEMA_VERSION, EXTRACTOR_VERSION } from '../db/schema.js';
import { NexusStore } from '../db/store.js';
import type { FileRow, SymbolRow, ModuleEdgeRow, OccurrenceRow } from '../db/store.js';
import { IndexLock } from './state.js';
import { loadConfig, computeConfigHash } from '../config.js';
import type { NexusConfig } from '../config.js';
import { detectRoot, detectCaseSensitivity, getGitHead, gitStatusClean } from '../workspace/detector.js';
import { buildIgnoreMatcher } from '../workspace/ignores.js';
import { scanDirectory } from '../workspace/scanner.js';
import { detectChanges, summarizeChanges, readAndHash } from '../workspace/changes.js';
import type { FileChange } from '../workspace/changes.js';
import { extractFile, extractSource } from '../analysis/extractor.js';
import type { ExtractedRelationEdge } from '../analysis/languages/registry.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface IndexResult {
  mode: 'full' | 'incremental' | 'overlay-on-parent' | 'worktree-isolated';
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
  relations: ExtractedRelationEdge[];
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

  // Compute clean_at_index_time BEFORE we touch .nexus/ — we ignore .nexus/
  // artifacts (Nexus's own DB) but DO count .nexus.json / .nexusignore as
  // user config that affects indexing.
  const cleanAtIndexTime = gitStatusClean(rootDir, { ignorePaths: ['.nexus/'] });

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
    } else {
      // Incremental rebuild — refresh git_head so the meta reflects the
      // current snapshot the index was built against.
      if (gitHead) store.setMeta('git_head', gitHead);
    }
    // Always record the cleanliness of the working tree at index time.
    // This is the gate that decides whether a worktree session can use this
    // index as an overlay base (Phase E: overlay-orchestrator). Captured
    // before any .nexus/ writes — see `cleanAtIndexTime` above.
    store.setMeta('clean_at_index_time', cleanAtIndexTime ? 'true' : 'false');
    store.setMeta('index_mode', 'full');

    // ── Phase 1: Scan + Parse (no write lock) ───────────────────────
    const isIgnored = buildIgnoreMatcher(rootDir, config.exclude);
    const scannedFiles = scanDirectory(rootDir, isIgnored, {
      maxFileSize: config.maxFileSize,
      minifiedLineLength: config.minifiedLineLength,
      languages: config.languages,
    });

    const dbFiles = mode === 'full' ? [] : store.getAllFiles();
    const changes: FileChange[] = mode === 'full'
      ? scannedFiles.map(f => {
          const { hash, source } = readAndHash(f.absolutePath);
          return { file: f, dbRow: null, action: 'add' as const, hash, source };
        })
      : detectChanges(scannedFiles, dbFiles, caseSensitive);

    const summary = summarizeChanges(changes);

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
        store.deleteAllFiles();
      } else if (deleteIds.length > 0) {
        store.deleteFilesByIds(deleteIds);
      }

      // Insert new/updated files + their children
      for (const buf of [...addBuffers, ...updateBuffers]) {
        const fileId = store.insertFile(buf.fileRow);

        let symbolIds: number[] = [];
        if (buf.symbols.length > 0) {
          symbolIds = store.insertSymbols(
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
        if (buf.relations.length > 0) {
          // Build same-file lookup: name → first matching top-level type id.
          // Only class/interface/type kinds are valid relation targets.
          const localTargetByName = new Map<string, number>();
          for (let i = 0; i < buf.symbols.length; i++) {
            const s = buf.symbols[i];
            if (s.kind === 'class' || s.kind === 'interface' || s.kind === 'type') {
              if (!localTargetByName.has(s.name)) {
                localTargetByName.set(s.name, symbolIds[i]);
              }
            }
          }
          const rows = buf.relations
            .filter(r => r.source_symbol_index >= 0 && r.source_symbol_index < symbolIds.length)
            .map(r => ({
              file_id: fileId,
              source_id: symbolIds[r.source_symbol_index],
              kind: r.kind,
              target_name: r.target_name,
              target_id: localTargetByName.get(r.target_name) ?? null,
              confidence: r.confidence,
              line: r.line,
            }));
          if (rows.length > 0) store.insertRelationEdges(rows);
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

    // ── Phase 3: Resolve Import Edges ─────────────────────────────────
    resolveImportEdges(store, caseSensitive);

    // ── Phase 4: Resolve Relation Edge Targets (B2 v1) ─────────────────
    // Runs after Phase 3 so import resolution is available — relations
    // whose target_name was imported get linked to the export's declaration.
    resolveRelationTargets(store);

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
  // Use pre-read source when available (avoids double file read)
  const result = change.source
    ? extractSource(change.source, file.path, file.language)
    : extractFile(file.absolutePath, file.path, file.language);

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
      relations: [],
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
    relations: result.relations ?? [],
  };
}

/**
 * Phase 3: Resolve relative import specifiers to file IDs.
 * Looks up './utils' → files table path_key match for actual indexed file.
 */
/**
 * B2 v1: resolve relation_edges.target_id by looking up the target_name
 * in the importer's resolved imports, then in the imported file's
 * top-level class/interface/type symbols.
 *
 * Handles three patterns:
 *   class B extends Base       — bare identifier; matches import alias.
 *   class B extends ns.Base    — member expression; matches namespace import.
 *   class B implements IUser   — same as bare identifier.
 *
 * Skips call expressions (`Mixin(Base)`) — they remain unresolved.
 */
function resolveRelationTargets(store: NexusStore): void {
  const unresolved = store.getUnresolvedRelationEdges();
  if (unresolved.length === 0) return;

  // Group by file to amortize per-file import lookups.
  const byFile = new Map<number, typeof unresolved>();
  for (const e of unresolved) {
    const list = byFile.get(e.file_id);
    if (list) list.push(e);
    else byFile.set(e.file_id, [e]);
  }

  for (const [fileId, edges] of byFile) {
    const imports = store.getImportsByFileId(fileId);
    if (imports.length === 0) continue;

    // alias-or-name → import row (first wins; collisions are rare and
    // only matter at the syntactic level).
    const namedImports = new Map<string, typeof imports[number]>();
    const starImports = new Map<string, typeof imports[number]>();
    for (const imp of imports) {
      if (imp.is_star && imp.alias) {
        starImports.set(imp.alias, imp);
      } else {
        const local = imp.alias ?? imp.name;
        if (local && !namedImports.has(local)) namedImports.set(local, imp);
      }
    }

    for (const edge of edges) {
      const dotIdx = edge.target_name.indexOf('.');
      let importRow: typeof imports[number] | undefined;
      let exportName: string;

      if (dotIdx > 0) {
        // ns.Name → look up star import "ns", then symbol "Name" in target file.
        const ns = edge.target_name.slice(0, dotIdx);
        const tail = edge.target_name.slice(dotIdx + 1);
        if (tail.includes('.')) continue; // multi-dot unsupported v1
        importRow = starImports.get(ns);
        exportName = tail;
      } else if (/^[A-Za-z_$][\w$]*$/.test(edge.target_name)) {
        // Bare identifier → look up named import (alias or original).
        importRow = namedImports.get(edge.target_name);
        // Original export name = import row's `name` field
        // (e.g. `import { Foo as Bar }` → name='Foo', alias='Bar').
        exportName = importRow?.name ?? edge.target_name;
      } else {
        // Call expression / unsupported syntax — skip.
        continue;
      }

      if (!importRow || importRow.resolved_file_id == null) continue;

      const targetId = store.findTopLevelTypeByFileAndName(importRow.resolved_file_id, exportName);
      if (targetId !== null) {
        store.updateRelationTargetId(edge.id, targetId);
      }
    }
  }
}

function resolveImportEdges(store: NexusStore, caseSensitive: boolean): void {
  const unresolvedEdges = store.getUnresolvedRelativeEdges();
  if (unresolvedEdges.length === 0) return;

  // Build file path lookup: path_key → file id
  const allFiles = store.getAllFiles();
  const fileByPathKey = new Map<string, number>();
  for (const f of allFiles) {
    fileByPathKey.set(f.path_key, f.id);
    // Also index normalized POSIX path
    const posix = f.path.replace(/\\/g, '/');
    const key = caseSensitive ? posix : posix.toLowerCase();
    fileByPathKey.set(key, f.id);
  }

  // Build lookup from file_id → directory path (for resolving relative imports)
  const fileDirById = new Map<number, string>();
  for (const f of allFiles) {
    const posix = f.path.replace(/\\/g, '/');
    const dir = posix.includes('/') ? posix.slice(0, posix.lastIndexOf('/')) : '';
    fileDirById.set(f.id, dir);
  }

  const updates: { edgeId: number; resolvedFileId: number }[] = [];

  for (const edge of unresolvedEdges) {
    const importerDir = fileDirById.get(edge.file_id);
    if (importerDir === undefined) continue;

    const resolvedId = resolveModulePath(edge.source, importerDir, caseSensitive, fileByPathKey);
    if (resolvedId !== undefined) {
      updates.push({ edgeId: edge.id, resolvedFileId: resolvedId });
    }
  }

  store.resolveEdgesBatch(updates);
}

/** Common extensions to try when resolving import specifiers */
const RESOLVE_EXTENSIONS = [
  '', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
  '.py', '.go', '.rs', '.java', '.cs', '.css',
];

/**
 * Resolve a relative import specifier to a file ID.
 * Tries the specifier as-is, then with common extensions appended.
 */
function resolveModulePath(
  source: string,
  importerDir: string,
  caseSensitive: boolean,
  fileByPathKey: Map<string, number>,
): number | undefined {
  // Normalize: join importer dir + relative specifier
  const parts = (importerDir ? importerDir + '/' + source : source).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  const basePath = resolved.join('/');

  // TS-ESM imports use .js extensions referring to .ts source files
  // (`import { X } from './foo.js'` → ./foo.ts). Try the source-extension
  // variants first when the specifier ends in a JS extension.
  const baseVariants = [basePath];
  const jsExtMatch = basePath.match(/\.(js|jsx|mjs|cjs)$/);
  if (jsExtMatch) {
    const stripped = basePath.slice(0, -jsExtMatch[0].length);
    const tsExt = jsExtMatch[1] === 'jsx' ? '.tsx' : (jsExtMatch[1] === 'mjs' ? '.mts' : (jsExtMatch[1] === 'cjs' ? '.cts' : '.ts'));
    baseVariants.unshift(stripped + tsExt);
    baseVariants.unshift(stripped); // also try without extension (e.g. for /index.ts lookup)
  }

  for (const candidateBase of baseVariants) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = candidateBase + ext;
      const key = caseSensitive ? candidate : candidate.toLowerCase();
      const fileId = fileByPathKey.get(key);
      if (fileId !== undefined) return fileId;
    }
  }

  return undefined;
}

/**
 * Ensure a directory exists.
 */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
