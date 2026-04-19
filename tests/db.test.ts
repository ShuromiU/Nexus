import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import {
  openDatabase,
  applySchema,
  initializeMeta,
  SCHEMA_VERSION,
  EXTRACTOR_VERSION,
} from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import type { FileRow, SymbolRow, ModuleEdgeRow, OccurrenceRow } from '../src/db/store.js';
import {
  quickCheck,
  fullIntegrityCheck,
  openWithIntegrityCheck,
  repair,
} from '../src/db/integrity.js';
import { IndexLock } from '../src/index/state.js';

function tmpDb(): string {
  return path.join(os.tmpdir(), `nexus-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

// ── Schema Tests ──────────────────────────────────────────────────────

describe('Schema', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = tmpDb();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanup(dbPath);
  });

  it('creates database with WAL mode', () => {
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('enables foreign keys', () => {
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('applies schema without errors', () => {
    expect(() => applySchema(db)).not.toThrow();
  });

  it('creates all expected tables', () => {
    applySchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('meta');
    expect(names).toContain('files');
    expect(names).toContain('symbols');
    expect(names).toContain('module_edges');
    expect(names).toContain('occurrences');
    expect(names).toContain('index_runs');
    expect(names).toContain('index_lock');
  });

  it('creates all expected indexes', () => {
    applySchema(db);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);

    expect(names).toContain('idx_symbols_name');
    expect(names).toContain('idx_symbols_file_kind');
    expect(names).toContain('idx_edges_file');
    expect(names).toContain('idx_edges_source');
    expect(names).toContain('idx_edges_name');
    expect(names).toContain('idx_edges_resolved');
    expect(names).toContain('idx_occur_name');
    expect(names).toContain('idx_occur_file');
    expect(names).toContain('idx_files_language');
  });

  it('is idempotent — applying schema twice is fine', () => {
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
  });

  it('initializes meta with correct values', () => {
    applySchema(db);
    initializeMeta(db, '/test/root', true);

    const store = new NexusStore(db);
    expect(store.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
    expect(store.getMeta('extractor_version')).toBe(String(EXTRACTOR_VERSION));
    expect(store.getMeta('root_path')).toBe('/test/root');
    expect(store.getMeta('fs_case_sensitive')).toBe('true');
  });
});

// ── Store CRUD Tests ──────────────────────────────────────────────────

describe('NexusStore', () => {
  let dbPath: string;
  let db: Database.Database;
  let store: NexusStore;

  beforeEach(() => {
    dbPath = tmpDb();
    db = openDatabase(dbPath);
    applySchema(db);
    store = new NexusStore(db);
  });

  afterEach(() => {
    db.close();
    cleanup(dbPath);
  });

  // ── Meta ──

  describe('meta', () => {
    it('gets and sets meta values', () => {
      store.setMeta('test_key', 'test_value');
      expect(store.getMeta('test_key')).toBe('test_value');
    });

    it('returns undefined for missing key', () => {
      expect(store.getMeta('nonexistent')).toBeUndefined();
    });

    it('upserts existing keys', () => {
      store.setMeta('key', 'v1');
      store.setMeta('key', 'v2');
      expect(store.getMeta('key')).toBe('v2');
    });
  });

  // ── Files ──

  describe('files', () => {
    const testFile: FileRow = {
      path: 'src/index.ts',
      path_key: 'src/index.ts',
      hash: 'abc123',
      mtime: 1700000000,
      size: 1024,
      language: 'typescript',
      status: 'indexed',
      indexed_at: '2026-01-01T00:00:00Z',
    };

    it('inserts and retrieves a file', () => {
      const id = store.insertFile(testFile);
      expect(id).toBeGreaterThan(0);

      const retrieved = store.getFileByPathKey('src/index.ts');
      expect(retrieved).toBeDefined();
      expect(retrieved!.path).toBe('src/index.ts');
      expect(retrieved!.hash).toBe('abc123');
      expect(retrieved!.language).toBe('typescript');
    });

    it('retrieves by id', () => {
      const id = store.insertFile(testFile);
      const retrieved = store.getFileById(id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(id);
    });

    it('lists all files', () => {
      store.insertFile(testFile);
      store.insertFile({ ...testFile, path: 'src/other.ts', path_key: 'src/other.ts', hash: 'def456' });
      const all = store.getAllFiles();
      expect(all).toHaveLength(2);
    });

    it('updates mtime', () => {
      const id = store.insertFile(testFile);
      store.updateFileMtime(id, 1800000000, 2048);
      const retrieved = store.getFileById(id);
      expect(retrieved!.mtime).toBe(1800000000);
      expect(retrieved!.size).toBe(2048);
    });

    it('deletes a file', () => {
      const id = store.insertFile(testFile);
      store.deleteFile(id);
      expect(store.getFileById(id)).toBeUndefined();
    });

    it('enforces unique path_key', () => {
      store.insertFile(testFile);
      expect(() => store.insertFile(testFile)).toThrow();
    });

    it('cascades delete to symbols', () => {
      const fileId = store.insertFile(testFile);
      store.insertSymbol({
        file_id: fileId,
        name: 'foo',
        kind: 'function',
        line: 1,
        col: 0,
      });
      expect(store.getSymbolsByFileId(fileId)).toHaveLength(1);

      store.deleteFile(fileId);
      expect(store.getSymbolsByFileId(fileId)).toHaveLength(0);
    });
  });

  // ── Symbols ──

  describe('symbols', () => {
    let fileId: number;

    beforeEach(() => {
      fileId = store.insertFile({
        path: 'src/test.ts',
        path_key: 'src/test.ts',
        hash: 'abc',
        mtime: 1700000000,
        size: 100,
        language: 'typescript',
        status: 'indexed',
        indexed_at: '2026-01-01T00:00:00Z',
      });
    });

    it('inserts and retrieves a symbol', () => {
      const id = store.insertSymbol({
        file_id: fileId,
        name: 'myFunction',
        kind: 'function',
        line: 10,
        col: 0,
        signature: '(a: string) => void',
        doc: 'A test function',
      });
      expect(id).toBeGreaterThan(0);

      const results = store.getSymbolsByName('myFunction');
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe('function');
      expect(results[0].signature).toBe('(a: string) => void');
    });

    it('bulk inserts symbols', () => {
      const symbols: SymbolRow[] = [
        { file_id: fileId, name: 'a', kind: 'function', line: 1, col: 0 },
        { file_id: fileId, name: 'b', kind: 'class', line: 10, col: 0 },
        { file_id: fileId, name: 'c', kind: 'interface', line: 20, col: 0 },
      ];
      store.insertSymbols(symbols);
      expect(store.getSymbolsByFileId(fileId)).toHaveLength(3);
    });

    it('queries by name and kind', () => {
      store.insertSymbols([
        { file_id: fileId, name: 'Foo', kind: 'class', line: 1, col: 0 },
        { file_id: fileId, name: 'Foo', kind: 'interface', line: 10, col: 0 },
      ]);
      const classes = store.getSymbolsByNameAndKind('Foo', 'class');
      expect(classes).toHaveLength(1);
      expect(classes[0].kind).toBe('class');
    });
  });

  // ── Module Edges ──

  describe('module edges', () => {
    let fileId: number;

    beforeEach(() => {
      fileId = store.insertFile({
        path: 'src/test.ts',
        path_key: 'src/test.ts',
        hash: 'abc',
        mtime: 1700000000,
        size: 100,
        language: 'typescript',
        status: 'indexed',
        indexed_at: '2026-01-01T00:00:00Z',
      });
    });

    it('inserts and retrieves an import edge', () => {
      store.insertModuleEdge({
        file_id: fileId,
        kind: 'import',
        name: 'useState',
        source: 'react',
        line: 1,
        is_default: false,
        is_star: false,
        is_type: false,
      });

      const imports = store.getImportsByFileId(fileId);
      expect(imports).toHaveLength(1);
      expect(imports[0].name).toBe('useState');
      expect(imports[0].source).toBe('react');
    });

    it('inserts and retrieves an export edge', () => {
      store.insertModuleEdge({
        file_id: fileId,
        kind: 'export',
        name: 'MyComponent',
        line: 5,
        is_default: true,
        is_star: false,
        is_type: false,
      });

      const exports = store.getExportsByFileId(fileId);
      expect(exports).toHaveLength(1);
      expect(exports[0].is_default).toBe(1); // SQLite stores as integer
    });

    it('bulk inserts edges', () => {
      const edges: ModuleEdgeRow[] = [
        { file_id: fileId, kind: 'import', name: 'a', source: 'mod-a', line: 1, is_default: false, is_star: false, is_type: false },
        { file_id: fileId, kind: 'import', name: 'b', source: 'mod-b', line: 2, is_default: false, is_star: false, is_type: true },
        { file_id: fileId, kind: 'export', name: 'c', line: 3, is_default: false, is_star: false, is_type: false },
      ];
      store.insertModuleEdges(edges);
      expect(store.getEdgesByFileId(fileId)).toHaveLength(3);
    });

    it('queries by source', () => {
      store.insertModuleEdge({
        file_id: fileId,
        kind: 'import',
        name: 'foo',
        source: './utils',
        line: 1,
        is_default: false,
        is_star: false,
        is_type: false,
      });
      const results = store.getEdgesBySource('./utils');
      expect(results).toHaveLength(1);
    });

    it('cascades delete from file', () => {
      store.insertModuleEdge({
        file_id: fileId,
        kind: 'import',
        name: 'x',
        source: 'y',
        line: 1,
        is_default: false,
        is_star: false,
        is_type: false,
      });
      store.deleteFile(fileId);
      expect(store.getEdgesByFileId(fileId)).toHaveLength(0);
    });
  });

  // ── Occurrences ──

  describe('occurrences', () => {
    let fileId: number;

    beforeEach(() => {
      fileId = store.insertFile({
        path: 'src/test.ts',
        path_key: 'src/test.ts',
        hash: 'abc',
        mtime: 1700000000,
        size: 100,
        language: 'typescript',
        status: 'indexed',
        indexed_at: '2026-01-01T00:00:00Z',
      });
    });

    it('inserts and retrieves occurrences', () => {
      store.insertOccurrence({
        file_id: fileId,
        name: 'useState',
        line: 5,
        col: 10,
        context: 'const [state, setState] = useState(0)',
        confidence: 'exact',
      });

      const results = store.getOccurrencesByName('useState');
      expect(results).toHaveLength(1);
      expect(results[0].context).toBe('const [state, setState] = useState(0)');
    });

    it('bulk inserts occurrences', () => {
      const occs: OccurrenceRow[] = [
        { file_id: fileId, name: 'a', line: 1, col: 0, confidence: 'heuristic' },
        { file_id: fileId, name: 'b', line: 2, col: 0, confidence: 'exact' },
      ];
      store.insertOccurrences(occs);
      expect(store.getOccurrencesByFileId(fileId)).toHaveLength(2);
    });

    it('cascades delete from file', () => {
      store.insertOccurrence({
        file_id: fileId,
        name: 'x',
        line: 1,
        col: 0,
        confidence: 'heuristic',
      });
      store.deleteFile(fileId);
      expect(store.getOccurrencesByFileId(fileId)).toHaveLength(0);
    });
  });

  // ── Index Runs ──

  describe('index runs', () => {
    it('inserts and retrieves an index run', () => {
      const id = store.insertIndexRun({
        started_at: '2026-01-01T00:00:00Z',
        mode: 'full',
        files_scanned: 100,
        files_indexed: 95,
        files_skipped: 3,
        files_errored: 2,
        status: 'completed',
      });
      expect(id).toBeGreaterThan(0);

      const last = store.getLastIndexRun();
      expect(last).toBeDefined();
      expect(last!.mode).toBe('full');
      expect(last!.files_indexed).toBe(95);
    });

    it('updates an index run', () => {
      const id = store.insertIndexRun({
        started_at: '2026-01-01T00:00:00Z',
        mode: 'incremental',
        files_scanned: 0,
        files_indexed: 0,
        files_skipped: 0,
        files_errored: 0,
        status: 'completed',
      });
      store.updateIndexRun(id, {
        completed_at: '2026-01-01T00:01:00Z',
        files_scanned: 50,
        files_indexed: 48,
      });

      const last = store.getLastIndexRun();
      expect(last!.files_scanned).toBe(50);
      expect(last!.completed_at).toBe('2026-01-01T00:01:00Z');
    });
  });

  // ── Aggregate Queries ──

  describe('aggregates', () => {
    it('counts files by status', () => {
      store.insertFile({ path: 'a.ts', path_key: 'a.ts', hash: 'h1', mtime: 0, size: 10, language: 'typescript', status: 'indexed', indexed_at: '' });
      store.insertFile({ path: 'b.ts', path_key: 'b.ts', hash: 'h2', mtime: 0, size: 10, language: 'typescript', status: 'indexed', indexed_at: '' });
      store.insertFile({ path: 'c.min.js', path_key: 'c.min.js', hash: 'h3', mtime: 0, size: 10, language: 'javascript', status: 'skipped', indexed_at: '' });
      store.insertFile({ path: 'd.ts', path_key: 'd.ts', hash: 'h4', mtime: 0, size: 10, language: 'typescript', status: 'error', error: 'parse error', indexed_at: '' });

      const counts = store.getFileCount();
      expect(counts.total).toBe(4);
      expect(counts.indexed).toBe(2);
      expect(counts.skipped).toBe(1);
      expect(counts.errored).toBe(1);
    });

    it('counts symbols', () => {
      const fileId = store.insertFile({ path: 'a.ts', path_key: 'a.ts', hash: 'h1', mtime: 0, size: 10, language: 'typescript', status: 'indexed', indexed_at: '' });
      store.insertSymbols([
        { file_id: fileId, name: 'x', kind: 'function', line: 1, col: 0 },
        { file_id: fileId, name: 'y', kind: 'class', line: 2, col: 0 },
      ]);
      expect(store.getSymbolCount()).toBe(2);
    });

    it('reports language stats', () => {
      const f1 = store.insertFile({ path: 'a.ts', path_key: 'a.ts', hash: 'h1', mtime: 0, size: 10, language: 'typescript', status: 'indexed', indexed_at: '' });
      const f2 = store.insertFile({ path: 'b.py', path_key: 'b.py', hash: 'h2', mtime: 0, size: 10, language: 'python', status: 'indexed', indexed_at: '' });
      store.insertSymbol({ file_id: f1, name: 'x', kind: 'function', line: 1, col: 0 });
      store.insertSymbol({ file_id: f2, name: 'y', kind: 'function', line: 1, col: 0 });
      store.insertSymbol({ file_id: f2, name: 'z', kind: 'class', line: 2, col: 0 });

      const stats = store.getLanguageStats();
      expect(stats['typescript'].files).toBe(1);
      expect(stats['typescript'].symbols).toBe(1);
      expect(stats['python'].files).toBe(1);
      expect(stats['python'].symbols).toBe(2);
    });

    it('detects errors', () => {
      expect(store.hasErrors()).toBe(false);
      store.insertFile({ path: 'bad.ts', path_key: 'bad.ts', hash: 'h', mtime: 0, size: 10, language: 'typescript', status: 'error', error: 'oops', indexed_at: '' });
      expect(store.hasErrors()).toBe(true);
    });
  });

  // ── Bulk Publish ──

  describe('publishBatch', () => {
    it('atomically publishes files with children', () => {
      // Insert initial file
      const oldId = store.insertFile({ path: 'a.ts', path_key: 'a.ts', hash: 'old', mtime: 0, size: 10, language: 'typescript', status: 'indexed', indexed_at: '' });
      store.insertSymbol({ file_id: oldId, name: 'oldSym', kind: 'function', line: 1, col: 0 });

      // Publish new version — delete old, insert new
      const newFile: FileRow = { path: 'a.ts', path_key: 'a.ts', hash: 'new', mtime: 1, size: 20, language: 'typescript', status: 'indexed', indexed_at: '' };
      const newSymbols: SymbolRow[] = [{ file_id: -1, name: 'newSym', kind: 'class', line: 1, col: 0 }];

      const fileIdMap = store.publishBatch(
        [oldId],
        [newFile],
        new Map(),
        new Map(),
        new Map(),
      );

      const newId = fileIdMap.get('a.ts');
      expect(newId).toBeDefined();

      // Old symbol should be gone (cascade delete)
      expect(store.getSymbolsByName('oldSym')).toHaveLength(0);

      // New file should exist
      const file = store.getFileByPathKey('a.ts');
      expect(file!.hash).toBe('new');
    });
  });
});

// ── Integrity Tests ───────────────────────────────────────────────────

describe('Integrity', () => {
  let dbPath: string;

  afterEach(() => {
    cleanup(dbPath);
  });

  it('quick_check passes on a healthy database', () => {
    dbPath = tmpDb();
    const db = openDatabase(dbPath);
    applySchema(db);
    const result = quickCheck(db);
    db.close();
    expect(result.ok).toBe(true);
  });

  it('full integrity_check passes on a healthy database', () => {
    dbPath = tmpDb();
    const db = openDatabase(dbPath);
    applySchema(db);
    const result = fullIntegrityCheck(db);
    db.close();
    expect(result.ok).toBe(true);
  });

  it('openWithIntegrityCheck creates fresh DB if file does not exist', () => {
    dbPath = tmpDb();
    const { db, wasCorrupt } = openWithIntegrityCheck(dbPath, '/root', true);
    expect(wasCorrupt).toBe(false);
    // Schema should be applied
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);
    db.close();
  });

  it('openWithIntegrityCheck rebuilds corrupt database', () => {
    dbPath = tmpDb();
    // Write garbage to simulate corruption
    fs.writeFileSync(dbPath, 'THIS IS NOT A SQLITE FILE');

    const { db, wasCorrupt } = openWithIntegrityCheck(dbPath, '/root', false);
    expect(wasCorrupt).toBe(true);

    // Should be usable now
    const store = new NexusStore(db);
    expect(store.getMeta('root_path')).toBe('/root');
    expect(store.getMeta('fs_case_sensitive')).toBe('false');
    db.close();
  });

  it('repair returns no rebuild needed for healthy DB', () => {
    dbPath = tmpDb();
    const db = openDatabase(dbPath);
    applySchema(db);
    db.close();

    const result = repair(dbPath, '/root', true);
    expect(result.needsRebuild).toBe(false);
  });

  it('repair rebuilds corrupt DB', () => {
    dbPath = tmpDb();
    fs.writeFileSync(dbPath, 'CORRUPT DATA');

    const result = repair(dbPath, '/root', true);
    expect(result.needsRebuild).toBe(true);
    expect(result.message).toContain('rebuilt');
  });
});

// ── Lock Tests ────────────────────────────────────────────────────────

describe('IndexLock', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = tmpDb();
    db = openDatabase(dbPath);
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    cleanup(dbPath);
  });

  it('acquires lock successfully', () => {
    const lock = new IndexLock(db);
    expect(lock.acquire()).toBe(true);
    expect(lock.isLocked()).toBe(true);
    lock.release();
  });

  it('prevents second acquisition', () => {
    const lock1 = new IndexLock(db);
    const lock2 = new IndexLock(db);

    expect(lock1.acquire()).toBe(true);
    expect(lock2.acquire()).toBe(false);

    lock1.release();
  });

  it('allows acquisition after release', () => {
    const lock1 = new IndexLock(db);
    const lock2 = new IndexLock(db);

    expect(lock1.acquire()).toBe(true);
    lock1.release();

    expect(lock2.acquire()).toBe(true);
    lock2.release();
  });

  it('releases only own lock', () => {
    const lock1 = new IndexLock(db);
    const lock2 = new IndexLock(db);

    lock1.acquire();
    // lock2 trying to release lock1's lock should not work
    lock2.release();

    expect(lock1.isLocked()).toBe(true);
    lock1.release();
  });

  it('returns lock info', () => {
    const lock = new IndexLock(db);
    expect(lock.getLockInfo()).toBeNull();

    lock.acquire();
    const info = lock.getLockInfo();
    expect(info).not.toBeNull();
    expect(info!.holder_id).toBe(lock.id);
    lock.release();
  });

  it('heartbeat succeeds and keeps lock valid', () => {
    const lock = new IndexLock(db);
    lock.acquire();

    // Manual heartbeat should succeed
    const success = lock.heartbeat();
    expect(success).toBe(true);

    // Lock should still be valid after heartbeat
    expect(lock.isLocked()).toBe(true);
    const info = lock.getLockInfo();
    expect(info).not.toBeNull();
    expect(info!.holder_id).toBe(lock.id);

    lock.release();
  });

  it('lock info is null after release', () => {
    const lock = new IndexLock(db);
    lock.acquire();
    lock.release();
    expect(lock.getLockInfo()).toBeNull();
  });
});

describe('schema v2 ref_kind', () => {
  it('SCHEMA_VERSION is 2', async () => {
    const { SCHEMA_VERSION } = await import('../src/db/schema.js');
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('occurrences table has a nullable ref_kind column', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const cols = db.prepare("PRAGMA table_info('occurrences')").all() as {
      name: string;
      type: string;
      notnull: number;
    }[];
    const refKind = cols.find(c => c.name === 'ref_kind');
    expect(refKind).toBeDefined();
    expect(refKind!.type.toUpperCase()).toBe('TEXT');
    expect(refKind!.notnull).toBe(0);
  });

  it('accepts NULL ref_kind via insert', () => {
    const db = new Database(':memory:');
    applySchema(db);
    initializeMeta(db, '/test', true);
    const store = new NexusStore(db);
    const fid = store.insertFile({
      path: 'a.ts', path_key: 'a.ts', hash: 'h', mtime: 1, size: 1,
      language: 'typescript', status: 'indexed', indexed_at: '2026-04-19T00:00:00Z',
    });
    store.insertOccurrence({
      file_id: fid, name: 'foo', line: 1, col: 0, confidence: 'heuristic',
    });
    const row = db.prepare('SELECT ref_kind FROM occurrences WHERE name = ?').get('foo') as { ref_kind: string | null };
    expect(row.ref_kind).toBeNull();
  });
});
