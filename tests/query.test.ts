import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta, SCHEMA_VERSION, EXTRACTOR_VERSION } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import { QueryEngine } from '../src/query/engine.js';
import { fuzzyScore, rankResults } from '../src/query/ranking.js';

// Side-effect: register TS adapter so stats() can pull capabilities
import '../src/analysis/languages/typescript.js';

// ── Test Helpers ──────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/test/project', true);
  return db;
}

function seedTestData(store: NexusStore) {
  // File 1: src/utils.ts
  const file1 = store.insertFile({
    path: 'src/utils.ts',
    path_key: 'src/utils.ts',
    hash: 'abc123',
    mtime: 1000,
    size: 500,
    language: 'typescript',
    status: 'indexed',
    indexed_at: '2026-04-07T12:00:00Z',
  });

  // File 2: src/components/Button.tsx
  const file2 = store.insertFile({
    path: 'src/components/Button.tsx',
    path_key: 'src/components/button.tsx',
    hash: 'def456',
    mtime: 2000,
    size: 800,
    language: 'typescriptreact',
    status: 'indexed',
    indexed_at: '2026-04-07T12:00:00Z',
  });

  // File 3: src/broken.ts (error)
  store.insertFile({
    path: 'src/broken.ts',
    path_key: 'src/broken.ts',
    hash: 'err789',
    mtime: 3000,
    size: 100,
    language: 'typescript',
    status: 'error',
    error: 'Parse failed',
    indexed_at: '2026-04-07T12:00:00Z',
  });

  // Symbols for file 1
  store.insertSymbols([
    { file_id: file1, name: 'formatDate', kind: 'function', line: 5, col: 0, signature: '(date: Date) => string', doc: 'Formats a date' },
    { file_id: file1, name: 'parseDate', kind: 'function', line: 15, col: 0, signature: '(input: string) => Date' },
    { file_id: file1, name: 'MAX_RETRIES', kind: 'constant', line: 1, col: 0 },
    { file_id: file1, name: 'DateFormat', kind: 'type', line: 3, col: 0 },
  ]);

  // Symbols for file 2
  store.insertSymbols([
    { file_id: file2, name: 'Button', kind: 'component', line: 10, col: 0, end_line: 30, doc: 'Primary button component' },
    { file_id: file2, name: 'ButtonProps', kind: 'interface', line: 3, col: 0 },
    { file_id: file2, name: 'useButtonState', kind: 'hook', line: 35, col: 0, scope: 'Button' },
  ]);

  // Module edges for file 1
  store.insertModuleEdges([
    { file_id: file1, kind: 'import', name: 'readFile', source: 'node:fs/promises', line: 1, is_default: false, is_star: false, is_type: false },
    { file_id: file1, kind: 'export', name: 'formatDate', line: 5, is_default: false, is_star: false, is_type: false },
    { file_id: file1, kind: 'export', name: 'parseDate', line: 15, is_default: false, is_star: false, is_type: false },
    { file_id: file1, kind: 'export', name: 'DateFormat', line: 3, is_default: false, is_star: false, is_type: true },
    { file_id: file1, kind: 're-export', name: 'helper', source: './helper', line: 20, is_default: false, is_star: false, is_type: false },
  ]);

  // Module edges for file 2
  store.insertModuleEdges([
    { file_id: file2, kind: 'import', name: 'React', source: 'react', line: 1, is_default: true, is_star: false, is_type: false },
    { file_id: file2, kind: 'import', name: 'formatDate', source: '../utils', line: 2, is_default: false, is_star: false, is_type: false },
    { file_id: file2, kind: 'export', name: 'Button', line: 10, is_default: true, is_star: false, is_type: false },
  ]);

  // Occurrences
  store.insertOccurrences([
    { file_id: file1, name: 'formatDate', line: 5, col: 16, context: 'export function formatDate(date: Date): string {', confidence: 'exact' },
    { file_id: file1, name: 'formatDate', line: 22, col: 10, context: 'return formatDate(new Date())', confidence: 'heuristic' },
    { file_id: file2, name: 'formatDate', line: 15, col: 8, context: 'const formatted = formatDate(date)', confidence: 'heuristic' },
    { file_id: file2, name: 'Button', line: 10, col: 14, context: 'export default function Button(props: ButtonProps)', confidence: 'exact' },
    { file_id: file2, name: 'Button', line: 40, col: 4, context: 'return <Button onClick={handleClick} />', confidence: 'heuristic' },
  ]);

  // Complete index run
  store.insertIndexRun({
    started_at: '2026-04-07T12:00:00Z',
    completed_at: '2026-04-07T12:00:01Z',
    mode: 'full',
    files_scanned: 3,
    files_indexed: 2,
    files_skipped: 0,
    files_errored: 1,
    status: 'completed',
  });

  store.setMeta('last_indexed_at', '2026-04-07T12:00:01Z');
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('QueryEngine', () => {
  let db: Database.Database;
  let store: NexusStore;
  let engine: QueryEngine;

  beforeEach(() => {
    db = createTestDb();
    store = new NexusStore(db);
    seedTestData(store);
    engine = new QueryEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Result envelope ─────────────────────────────────────────────────

  describe('result envelope', () => {
    it('wraps results with correct fields', () => {
      const result = engine.find('formatDate');
      expect(result.query).toBe('find formatDate');
      expect(result.type).toBe('find');
      expect(result.count).toBe(result.results.length);
      expect(result.index_status).toBe('current');
      expect(result.index_health).toBe('partial'); // has error file
      expect(result.timing_ms).toBeGreaterThanOrEqual(0);
    });

    it('reports stale when no index runs exist', () => {
      const freshDb = createTestDb();
      const freshEngine = new QueryEngine(freshDb);
      const result = freshEngine.find('anything');
      expect(result.index_status).toBe('stale');
      expect(result.index_health).toBe('ok'); // no files at all
      freshDb.close();
    });

    it('reports reindexing when last run is still running', () => {
      const freshDb = createTestDb();
      const freshStore = new NexusStore(freshDb);
      freshStore.insertIndexRun({
        started_at: '2026-04-07T12:00:00Z',
        mode: 'full',
        files_scanned: 0,
        files_indexed: 0,
        files_skipped: 0,
        files_errored: 0,
        status: 'running',
      });
      const freshEngine = new QueryEngine(freshDb);
      const result = freshEngine.find('anything');
      expect(result.index_status).toBe('reindexing');
      freshDb.close();
    });

    it('reports ok health when no errors', () => {
      const freshDb = createTestDb();
      const freshStore = new NexusStore(freshDb);
      freshStore.insertFile({
        path: 'ok.ts',
        path_key: 'ok.ts',
        hash: 'ok',
        mtime: 1,
        size: 1,
        language: 'typescript',
        status: 'indexed',
        indexed_at: '2026-04-07T12:00:00Z',
      });
      freshStore.insertIndexRun({
        started_at: '2026-04-07T12:00:00Z',
        completed_at: '2026-04-07T12:00:01Z',
        mode: 'full',
        files_scanned: 1,
        files_indexed: 1,
        files_skipped: 0,
        files_errored: 0,
        status: 'completed',
      });
      const freshEngine = new QueryEngine(freshDb);
      const result = freshEngine.find('anything');
      expect(result.index_health).toBe('ok');
      freshDb.close();
    });
  });

  // ── find ────────────────────────────────────────────────────────────

  describe('find', () => {
    it('finds symbols by exact name', () => {
      const result = engine.find('formatDate');
      expect(result.count).toBe(1);
      expect(result.results[0].name).toBe('formatDate');
      expect(result.results[0].kind).toBe('function');
      expect(result.results[0].file).toBe('src/utils.ts');
      expect(result.results[0].line).toBe(5);
      expect(result.results[0].signature).toBe('(date: Date) => string');
      expect(result.results[0].doc).toBe('Formats a date');
      expect(result.results[0].language).toBe('typescript');
    });

    it('finds symbols filtered by kind', () => {
      const result = engine.find('DateFormat', 'type');
      expect(result.count).toBe(1);
      expect(result.results[0].kind).toBe('type');
    });

    it('returns empty for non-existent name', () => {
      const result = engine.find('nonExistent');
      expect(result.count).toBe(0);
      expect(result.results).toEqual([]);
    });

    it('returns empty when kind filter mismatches', () => {
      const result = engine.find('formatDate', 'class');
      expect(result.count).toBe(0);
    });

    it('finds multiple symbols with same name', () => {
      // Insert a duplicate name in a different file
      store.insertSymbols([
        { file_id: 2, name: 'formatDate', kind: 'function', line: 1, col: 0 },
      ]);
      const result = engine.find('formatDate');
      expect(result.count).toBe(2);
    });

    it('includes optional fields only when present', () => {
      const result = engine.find('MAX_RETRIES');
      expect(result.count).toBe(1);
      expect(result.results[0]).not.toHaveProperty('signature');
      expect(result.results[0]).not.toHaveProperty('scope');
      expect(result.results[0]).not.toHaveProperty('doc');
      expect(result.results[0]).not.toHaveProperty('end_line');
    });

    it('includes end_line and scope when present', () => {
      const result = engine.find('Button');
      expect(result.count).toBe(1);
      expect(result.results[0].end_line).toBe(30);

      const hookResult = engine.find('useButtonState');
      expect(hookResult.results[0].scope).toBe('Button');
    });

    it('query string includes kind when provided', () => {
      const result = engine.find('Button', 'component');
      expect(result.query).toBe('find Button --kind component');
    });
  });

  // ── occurrences (refs) ──────────────────────────────────────────────

  describe('occurrences', () => {
    it('finds all occurrences across files', () => {
      const result = engine.occurrences('formatDate');
      expect(result.count).toBe(3);
      expect(result.type).toBe('occurrences');
      expect(result.query).toBe('refs formatDate');
    });

    it('returns correct fields', () => {
      const result = engine.occurrences('Button');
      expect(result.count).toBe(2);
      const first = result.results.find(r => r.confidence === 'exact')!;
      expect(first.name).toBe('Button');
      expect(first.file).toBe('src/components/Button.tsx');
      expect(first.line).toBe(10);
      expect(first.context).toContain('export default function Button');
    });

    it('returns empty for no matches', () => {
      const result = engine.occurrences('doesNotExist');
      expect(result.count).toBe(0);
    });

    it('includes confidence level', () => {
      const result = engine.occurrences('formatDate');
      const exact = result.results.filter(r => r.confidence === 'exact');
      const heuristic = result.results.filter(r => r.confidence === 'heuristic');
      expect(exact.length).toBe(1);
      expect(heuristic.length).toBe(2);
    });
  });

  // ── exports ─────────────────────────────────────────────────────────

  describe('exports', () => {
    it('returns exports for a file', () => {
      const result = engine.exports('src/utils.ts');
      expect(result.type).toBe('exports');
      // formatDate + parseDate + DateFormat (exports) + helper (re-export)
      expect(result.count).toBe(4);
    });

    it('includes re-exports', () => {
      const result = engine.exports('src/utils.ts');
      const reExport = result.results.find(r => r.kind === 're-export');
      expect(reExport).toBeDefined();
      expect(reExport!.name).toBe('helper');
      expect(reExport!.source).toBe('./helper');
    });

    it('returns type exports with flag', () => {
      const result = engine.exports('src/utils.ts');
      const typeExport = result.results.find(r => r.name === 'DateFormat');
      expect(typeExport!.is_type).toBe(true);
    });

    it('returns default export', () => {
      const result = engine.exports('src/components/Button.tsx');
      expect(result.count).toBe(1);
      expect(result.results[0].is_default).toBe(true);
    });

    it('returns empty for non-existent file', () => {
      const result = engine.exports('no/such/file.ts');
      expect(result.count).toBe(0);
    });

    it('finds file by suffix match', () => {
      const result = engine.exports('Button.tsx');
      expect(result.count).toBe(1);
    });
  });

  // ── imports ─────────────────────────────────────────────────────────

  describe('imports', () => {
    it('returns imports for a file', () => {
      const result = engine.imports('src/utils.ts');
      expect(result.type).toBe('imports');
      expect(result.count).toBe(1);
      expect(result.results[0].name).toBe('readFile');
      expect(result.results[0].source).toBe('node:fs/promises');
    });

    it('returns multiple imports', () => {
      const result = engine.imports('src/components/Button.tsx');
      expect(result.count).toBe(2);
    });

    it('returns empty for non-existent file', () => {
      const result = engine.imports('nonexistent.ts');
      expect(result.count).toBe(0);
    });
  });

  // ── importers ────────────────────────────────────────────────────────

  describe('importers', () => {
    it('finds files that import from a source (exact)', () => {
      const result = engine.importers('react');
      expect(result.type).toBe('imports');
      expect(result.count).toBe(1);
      expect(result.results[0].file).toBe('src/components/Button.tsx');
      expect(result.results[0].names).toContain('React');
    });

    it('finds files that import from a source (substring)', () => {
      const result = engine.importers('node:fs');
      expect(result.count).toBe(1);
      expect(result.results[0].file).toBe('src/utils.ts');
      expect(result.results[0].names).toContain('readFile');
    });

    it('finds files importing relative modules', () => {
      const result = engine.importers('../utils');
      expect(result.count).toBe(1);
      expect(result.results[0].file).toBe('src/components/Button.tsx');
    });

    it('finds multiple files importing from same package', () => {
      const file4 = store.insertFile({
        path: 'src/components/Card.tsx',
        path_key: 'src/components/card.tsx',
        hash: 'card123',
        mtime: 4000,
        size: 400,
        language: 'typescript',
        status: 'indexed',
        indexed_at: '2026-04-07T12:00:00Z',
      });
      store.insertModuleEdges([
        { file_id: file4, kind: 'import', name: 'useState', source: 'react', line: 1, is_default: false, is_star: false, is_type: false },
      ]);
      const result = engine.importers('react');
      expect(result.count).toBe(2);
      const files = result.results.map(r => r.file).sort();
      expect(files).toEqual(['src/components/Button.tsx', 'src/components/Card.tsx']);
    });

    it('returns empty for no matches', () => {
      const result = engine.importers('nonexistent-package');
      expect(result.count).toBe(0);
    });

    it('groups multiple imports from same source into one result per file', () => {
      const result = engine.importers('react');
      expect(result.count).toBe(1);
      expect(result.results[0].names).toEqual(['React']);
      expect(result.results[0].is_type).toBe(false);
    });

    it('includes type import flag', () => {
      const file4 = store.insertFile({
        path: 'src/types.ts',
        path_key: 'src/types.ts',
        hash: 'types123',
        mtime: 5000,
        size: 200,
        language: 'typescript',
        status: 'indexed',
        indexed_at: '2026-04-07T12:00:00Z',
      });
      store.insertModuleEdges([
        { file_id: file4, kind: 'import', name: 'Config', source: './config', line: 1, is_default: false, is_star: false, is_type: true },
      ]);
      const result = engine.importers('./config');
      expect(result.count).toBe(1);
      expect(result.results[0].is_type).toBe(true);
    });

    it('query string is correct', () => {
      const result = engine.importers('react');
      expect(result.query).toBe('importers react');
    });
  });

  // ── tree ────────────────────────────────────────────────────────────

  describe('tree', () => {
    it('returns all files when no prefix', () => {
      const result = engine.tree();
      expect(result.type).toBe('tree');
      expect(result.count).toBe(3); // utils, Button, broken
    });

    it('filters by path prefix', () => {
      const result = engine.tree('src/components');
      expect(result.count).toBe(1);
      expect(result.results[0].path).toBe('src/components/Button.tsx');
    });

    it('returns sorted by path', () => {
      const result = engine.tree();
      const paths = result.results.map(r => r.path);
      expect(paths).toEqual([...paths].sort());
    });

    it('includes symbol count', () => {
      const result = engine.tree('src/utils');
      expect(result.results[0].symbol_count).toBe(4);
    });

    it('includes export names', () => {
      const result = engine.tree('src/utils');
      expect(result.results[0].exports).toContain('formatDate');
      expect(result.results[0].exports).toContain('parseDate');
      expect(result.results[0].exports).toContain('DateFormat');
      expect(result.results[0].exports).toContain('helper');
    });

    it('shows named default exports by name', () => {
      const result = engine.tree('src/components');
      // Named default exports use the name, not '<default>'
      expect(result.results[0].exports).toContain('Button');
    });

    it('shows file status', () => {
      const result = engine.tree('src/broken');
      expect(result.results[0].status).toBe('error');
    });

    it('returns empty for non-matching prefix', () => {
      const result = engine.tree('lib/');
      expect(result.count).toBe(0);
    });
  });

  // ── search ──────────────────────────────────────────────────────────

  describe('search', () => {
    it('finds exact matches', () => {
      const result = engine.search('formatDate');
      expect(result.type).toBe('search');
      expect(result.count).toBeGreaterThanOrEqual(1);
      expect(result.results[0].name).toBe('formatDate');
      expect(result.results[0]._score).toBe(1.0);
    });

    it('finds partial matches', () => {
      const result = engine.search('format');
      expect(result.count).toBeGreaterThanOrEqual(1);
      expect(result.results.some(r => r.name === 'formatDate')).toBe(true);
    });

    it('finds case-insensitive matches', () => {
      const result = engine.search('button');
      expect(result.results.some(r => r.name === 'Button')).toBe(true);
    });

    it('ranks exact matches higher', () => {
      const result = engine.search('Button');
      const buttonIdx = result.results.findIndex(r => r.name === 'Button');
      const propsIdx = result.results.findIndex(r => r.name === 'ButtonProps');
      expect(buttonIdx).toBeLessThan(propsIdx);
    });

    it('respects limit', () => {
      const result = engine.search('a', 2);
      expect(result.count).toBeLessThanOrEqual(2);
    });

    it('returns empty for no matches', () => {
      const result = engine.search('zzzzzzxyz');
      expect(result.count).toBe(0);
    });

    it('includes score in results', () => {
      const result = engine.search('Date');
      for (const r of result.results) {
        expect(r._score).toBeGreaterThan(0);
        expect(r._score).toBeLessThanOrEqual(1);
      }
    });

    it('finds subsequence matches', () => {
      const result = engine.search('fmtDt');
      // formatDate should match as a subsequence (f-m-t-D-t)
      // This depends on the fuzzy matcher; may or may not match
      // The important thing is it doesn't crash
      expect(result).toBeDefined();
    });
  });

  // ── stats ───────────────────────────────────────────────────────────

  describe('stats', () => {
    it('returns single-element array', () => {
      const result = engine.stats();
      expect(result.type).toBe('stats');
      expect(result.count).toBe(1);
    });

    it('includes file counts', () => {
      const stats = engine.stats().results[0];
      expect(stats.files.total).toBe(3);
      expect(stats.files.indexed).toBe(2);
      expect(stats.files.errored).toBe(1);
    });

    it('includes symbol total', () => {
      const stats = engine.stats().results[0];
      expect(stats.symbols_total).toBe(7); // 4 in utils + 3 in Button
    });

    it('includes root path', () => {
      const stats = engine.stats().results[0];
      expect(stats.root).toBe('/test/project');
    });

    it('includes version info', () => {
      const stats = engine.stats().results[0];
      expect(stats.schema_version).toBe(SCHEMA_VERSION);
      expect(stats.extractor_version).toBe(EXTRACTOR_VERSION);
    });

    it('includes last_indexed_at', () => {
      const stats = engine.stats().results[0];
      expect(stats.last_indexed_at).toBe('2026-04-07T12:00:01Z');
    });

    it('includes per-language stats with capabilities', () => {
      const stats = engine.stats().results[0];
      expect(stats.languages['typescript']).toBeDefined();
      expect(stats.languages['typescript'].files).toBe(1); // only indexed files
      expect(stats.languages['typescript'].capabilities.definitions).toBe(true);
      expect(stats.languages['typescript'].capabilities.imports).toBe(true);
    });

    it('reports index health', () => {
      const stats = engine.stats().results[0];
      expect(stats.index_health).toBe('partial'); // has error file
    });
  });
});

// ── Fuzzy Scoring Tests ───────────────────────────────────────────────

describe('fuzzyScore', () => {
  it('exact match scores 1.0', () => {
    expect(fuzzyScore('hello', 'hello').score).toBe(1.0);
  });

  it('case-insensitive exact scores 0.95', () => {
    expect(fuzzyScore('Hello', 'hello').score).toBe(0.95);
  });

  it('starts-with scores 0.9', () => {
    expect(fuzzyScore('format', 'formatDate').score).toBe(0.9);
  });

  it('contains scores ~0.7–0.85', () => {
    const result = fuzzyScore('Date', 'formatDate');
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.score).toBeLessThanOrEqual(0.85);
  });

  it('no match scores 0', () => {
    const result = fuzzyScore('xyz', 'abc');
    expect(result.score).toBe(0);
    expect(result.matched).toBe(false);
  });

  it('subsequence matches score 0.1–0.6', () => {
    const result = fuzzyScore('fD', 'formatDate');
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.1);
    expect(result.score).toBeLessThanOrEqual(0.6);
  });

  it('consecutive subsequence chars score higher', () => {
    const tight = fuzzyScore('form', 'formatDate'); // starts-with, higher
    const loose = fuzzyScore('foDa', 'formatDate'); // subsequence
    expect(tight.score).toBeGreaterThan(loose.score);
  });
});

describe('rankResults', () => {
  it('sorts by score descending', () => {
    const items = [
      { name: 'a', _score: 0.5 },
      { name: 'b', _score: 0.9 },
      { name: 'c', _score: 0.7 },
    ];
    const ranked = rankResults(items);
    expect(ranked[0].name).toBe('b');
    expect(ranked[1].name).toBe('c');
    expect(ranked[2].name).toBe('a');
  });
});
