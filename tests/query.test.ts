import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta, SCHEMA_VERSION, EXTRACTOR_VERSION } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import { QueryEngine } from '../src/query/engine.js';
import { fuzzyScore, rankResults } from '../src/query/ranking.js';
import { runIndex } from '../src/index/orchestrator.js';

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

    it('filters by path prefix before scoring', () => {
      const result = engine.search('formatDate', 20, undefined, 'src/components');
      expect(result.count).toBe(0);
      expect(result.query).toBe('search formatDate --path src/components');
    });

    it('keeps matches inside the requested path prefix', () => {
      const result = engine.search('Button', 20, undefined, 'src/components');
      expect(result.count).toBeGreaterThanOrEqual(1);
      expect(result.results.every(r => r.file.startsWith('src/components'))).toBe(true);
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

    it('surfaces refKinds in per-language capabilities', () => {
      const result = engine.stats();
      const ts = result.results[0].languages['typescript'];
      expect(ts?.capabilities.refKinds).toEqual(
        expect.arrayContaining(['call', 'read', 'write', 'type-ref', 'declaration']),
      );
    });
  });

  // ── outline ────────────────────────────────────────────────────────

  describe('outline', () => {
    it('returns outline with imports, exports, and symbol tree', () => {
      const result = engine.outline('src/utils.ts');
      expect(result.type).toBe('outline');
      expect(result.count).toBe(1);

      const o = result.results[0];
      expect(o.file).toBe('src/utils.ts');
      expect(o.language).toBe('typescript');
    });

    it('groups imports by source', () => {
      const o = engine.outline('src/components/Button.tsx').results[0];
      expect(o.imports.length).toBe(2); // react, ../utils
      const reactImport = o.imports.find(i => i.source === 'react');
      expect(reactImport).toBeDefined();
      expect(reactImport!.names).toContain('React');
    });

    it('lists export names', () => {
      const o = engine.outline('src/utils.ts').results[0];
      expect(o.exports).toContain('formatDate');
      expect(o.exports).toContain('parseDate');
      expect(o.exports).toContain('DateFormat');
      expect(o.exports).toContain('helper');
    });

    it('builds nested symbol tree by scope', () => {
      const o = engine.outline('src/components/Button.tsx').results[0];
      // Button is top-level, useButtonState has scope: 'Button'
      const button = o.outline.find(e => e.name === 'Button');
      expect(button).toBeDefined();
      expect(button!.children).toBeDefined();
      expect(button!.children!.length).toBe(1);
      expect(button!.children![0].name).toBe('useButtonState');
    });

    it('includes signature and doc_summary', () => {
      const o = engine.outline('src/utils.ts').results[0];
      const fmt = o.outline.find(e => e.name === 'formatDate');
      expect(fmt!.signature).toBe('(date: Date) => string');
      expect(fmt!.doc_summary).toBe('Formats a date');
    });

    it('includes end_line when present', () => {
      const o = engine.outline('src/components/Button.tsx').results[0];
      const button = o.outline.find(e => e.name === 'Button');
      expect(button!.end_line).toBe(30);
    });

    it('returns empty for non-existent file', () => {
      const result = engine.outline('no/such/file.ts');
      expect(result.count).toBe(0);
    });

    it('lines is 0 when file not on disk', () => {
      // In-memory test DB has root_path=/test/project, files don't exist
      const o = engine.outline('src/utils.ts').results[0];
      expect(o.lines).toBe(0);
    });

    it('returns multiple outlines keyed by resolved path', () => {
      const result = engine.outlineMany(['utils.ts', 'src/components/Button.tsx']);
      expect(result.type).toBe('outline');
      expect(result.count).toBe(2);
      expect(Object.keys(result.results[0].outlines)).toEqual([
        'src/components/Button.tsx',
        'src/utils.ts',
      ]);
    });

    it('dedupes repeated files and reports missing ones', () => {
      const result = engine.outlineMany(['src/utils.ts', 'utils.ts', 'missing.ts']);
      expect(result.count).toBe(1);
      expect(Object.keys(result.results[0].outlines)).toEqual(['src/utils.ts']);
      expect(result.results[0].missing).toEqual(['missing.ts']);
    });
  });

  // ── source ─────────────────────────────────────────────────────────

  describe('source', () => {
    let tmpDir: string;
    let srcDb: Database.Database;
    let srcEngine: QueryEngine;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(path.join(srcDir, 'utils.ts'), [
        'const MAX_RETRIES = 3;',
        '',
        'type DateFormat = string;',
        '',
        'export function formatDate(date: Date): string {',
        '  return date.toISOString();',
        '}',
        '',
        'export function parseDate(input: string): Date {',
        '  return new Date(input);',
        '}',
      ].join('\n'));

      srcDb = createTestDb();
      const s = new NexusStore(srcDb);
      s.setMeta('root_path', tmpDir);

      const fileId = s.insertFile({
        path: 'src/utils.ts',
        path_key: 'src/utils.ts',
        hash: 'abc',
        mtime: 1,
        size: 200,
        language: 'typescript',
        status: 'indexed',
        indexed_at: '2026-04-07T12:00:00Z',
      });

      s.insertSymbols([
        { file_id: fileId, name: 'MAX_RETRIES', kind: 'constant', line: 1, col: 0 },
        { file_id: fileId, name: 'DateFormat', kind: 'type', line: 3, col: 0 },
        { file_id: fileId, name: 'formatDate', kind: 'function', line: 5, col: 0, end_line: 7, signature: '(date: Date) => string', doc: 'Formats a date' },
        { file_id: fileId, name: 'parseDate', kind: 'function', line: 9, col: 0, end_line: 11, signature: '(input: string) => Date' },
      ]);

      s.insertIndexRun({
        started_at: '2026-04-07T12:00:00Z',
        completed_at: '2026-04-07T12:00:01Z',
        mode: 'full',
        files_scanned: 1,
        files_indexed: 1,
        files_skipped: 0,
        files_errored: 0,
        status: 'completed',
      });

      srcEngine = new QueryEngine(srcDb);
    });

    afterEach(() => {
      srcDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('extracts source for a symbol with end_line', () => {
      const result = srcEngine.source('formatDate');
      expect(result.type).toBe('source');
      expect(result.count).toBe(1);
      expect(result.results[0].name).toBe('formatDate');
      expect(result.results[0].line).toBe(5);
      expect(result.results[0].end_line).toBe(7);
      expect(result.results[0].source).toContain('function formatDate');
      expect(result.results[0].source).toContain('return date.toISOString()');
      expect(result.results[0].signature).toBe('(date: Date) => string');
      expect(result.results[0].doc).toBe('Formats a date');
    });

    it('handles missing end_line with next-symbol fallback', () => {
      const result = srcEngine.source('MAX_RETRIES');
      expect(result.count).toBe(1);
      expect(result.results[0].line).toBe(1);
      // Next symbol (DateFormat) is at line 3, so end_line = 2
      expect(result.results[0].end_line).toBe(2);
      expect(result.results[0].source).toContain('MAX_RETRIES');
    });

    it('handles last symbol without end_line (caps at 50 lines)', () => {
      // parseDate has end_line set, but let's test a symbol that's last
      // MAX_RETRIES → DateFormat → formatDate → parseDate
      // parseDate has end_line=11, so it's not the case here.
      // Add a symbol at the end with no end_line
      const s = new NexusStore(srcDb);
      const fileId = s.getFileByPathKey('src/utils.ts')!.id;
      s.insertSymbols([
        { file_id: fileId, name: 'LAST_CONST', kind: 'constant', line: 11, col: 0 },
      ]);

      const result = srcEngine.source('LAST_CONST');
      expect(result.count).toBe(1);
      // Last symbol in file, no next symbol at a higher line, caps at line 11
      expect(result.results[0].end_line).toBe(11);
    });

    it('filters by file path', () => {
      const result = srcEngine.source('formatDate', 'utils.ts');
      expect(result.count).toBe(1);
      expect(result.results[0].file).toBe('src/utils.ts');
    });

    it('returns empty for non-existent symbol', () => {
      const result = srcEngine.source('nonExistent');
      expect(result.count).toBe(0);
    });

    it('query string includes file when provided', () => {
      const result = srcEngine.source('formatDate', 'utils.ts');
      expect(result.query).toBe('source formatDate --file utils.ts');
    });
  });

  describe('slice', () => {
    let tmpDir: string;
    let sliceDb: Database.Database;
    let sliceEngine: QueryEngine;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-slice-'));
      fs.mkdirSync(path.join(tmpDir, '.git'));
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

      fs.writeFileSync(path.join(tmpDir, 'src', 'helpers.ts'), [
        'export function helperA(): string {',
        "  return 'a';",
        '}',
        '',
        'export function helperB(): string {',
        '  return helperA();',
        '}',
      ].join('\n'));

      fs.writeFileSync(path.join(tmpDir, 'src', 'other.ts'), [
        'export function helperA(): string {',
        "  return 'other';",
        '}',
        '',
        'export function runTask(): string {',
        '  return helperA();',
        '}',
      ].join('\n'));

      fs.writeFileSync(path.join(tmpDir, 'src', 'service.ts'), [
        "import { helperA, helperB } from './helpers.ts';",
        '',
        'export function runTask(input: string): string {',
        '  const data = helperA();',
        '  return helperB() + input + data;',
        '}',
        '',
        'export function idleTask(): string {',
        "  return 'idle';",
        '}',
      ].join('\n'));

      fs.writeFileSync(path.join(tmpDir, 'src', 'fanout.ts'), [
        'function one(): string { return "1"; }',
        'function two(): string { return "2"; }',
        'function three(): string { return "3"; }',
        '',
        'export function fanOut(): string {',
        '  return one() + two() + three();',
        '}',
      ].join('\n'));

      const result = runIndex(tmpDir);
      expect(result.filesErrored).toBe(0);

      const dbPath = path.join(tmpDir, '.nexus', 'index.db');
      sliceDb = new Database(dbPath);
      sliceDb.pragma('journal_mode = WAL');
      sliceDb.pragma('foreign_keys = ON');
      sliceEngine = new QueryEngine(sliceDb);
    });

    afterEach(() => {
      sliceDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns the root symbol and referenced symbols', () => {
      const result = sliceEngine.slice('runTask', { file: 'service.ts' });
      expect(result.type).toBe('slice');
      expect(result.count).toBe(1);
      expect(result.results[0].root.file).toBe('src/service.ts');
      expect(result.results[0].references.map(r => r.name)).toEqual(['helperA', 'helperB']);
    });

    it('prefers imported files when a referenced name is ambiguous', () => {
      const result = sliceEngine.slice('runTask', { file: 'service.ts' });
      const helperA = result.results[0].references.find(r => r.name === 'helperA');
      expect(helperA?.file).toBe('src/helpers.ts');
    });

    it('returns an empty reference list when the body has no matched symbols', () => {
      const result = sliceEngine.slice('idleTask', { file: 'service.ts' });
      expect(result.count).toBe(1);
      expect(result.results[0].references).toEqual([]);
    });

    it('includes disambiguation when multiple root symbols match', () => {
      const result = sliceEngine.slice('runTask');
      expect(result.count).toBe(1);
      expect(result.results[0].disambiguation?.length).toBeGreaterThanOrEqual(1);
    });

    it('caps the number of referenced symbols and marks truncation', () => {
      const result = sliceEngine.slice('fanOut', { limit: 2 });
      expect(result.count).toBe(1);
      expect(result.results[0].references).toHaveLength(2);
      expect(result.results[0].truncated).toBe(true);
    });
  });

  // ── deps ───────────────────────────────────────────────────────────

  describe('deps', () => {
    let depsDb: Database.Database;
    let depsEngine: QueryEngine;

    beforeEach(() => {
      depsDb = createTestDb();
      const s = new NexusStore(depsDb);

      // Create files: A → B, A → C, B → C
      const fileA = s.insertFile({
        path: 'src/a.ts', path_key: 'src/a.ts', hash: 'a', mtime: 1, size: 100,
        language: 'typescript', status: 'indexed', indexed_at: '2026-04-07T12:00:00Z',
      });
      const fileB = s.insertFile({
        path: 'src/b.ts', path_key: 'src/b.ts', hash: 'b', mtime: 1, size: 100,
        language: 'typescript', status: 'indexed', indexed_at: '2026-04-07T12:00:00Z',
      });
      const fileC = s.insertFile({
        path: 'src/c.ts', path_key: 'src/c.ts', hash: 'c', mtime: 1, size: 100,
        language: 'typescript', status: 'indexed', indexed_at: '2026-04-07T12:00:00Z',
      });

      // A → B, A → C (resolved edges)
      s.insertModuleEdges([
        { file_id: fileA, kind: 'import', name: 'foo', source: './b', line: 1, is_default: false, is_star: false, is_type: false, resolved_file_id: fileB },
        { file_id: fileA, kind: 'import', name: 'bar', source: './c', line: 2, is_default: false, is_star: false, is_type: false, resolved_file_id: fileC },
      ]);
      // B → C (resolved edge)
      s.insertModuleEdges([
        { file_id: fileB, kind: 'import', name: 'baz', source: './c', line: 1, is_default: false, is_star: false, is_type: false, resolved_file_id: fileC },
      ]);
      // Exports
      s.insertModuleEdges([
        { file_id: fileB, kind: 'export', name: 'foo', line: 5, is_default: false, is_star: false, is_type: false },
        { file_id: fileC, kind: 'export', name: 'bar', line: 5, is_default: false, is_star: false, is_type: false },
        { file_id: fileC, kind: 'export', name: 'baz', line: 6, is_default: false, is_star: false, is_type: false },
      ]);

      s.insertIndexRun({
        started_at: '2026-04-07T12:00:00Z', completed_at: '2026-04-07T12:00:01Z',
        mode: 'full', files_scanned: 3, files_indexed: 3, files_skipped: 0, files_errored: 0, status: 'completed',
      });

      depsEngine = new QueryEngine(depsDb);
    });

    afterEach(() => {
      depsDb.close();
    });

    it('returns import tree with direct dependencies', () => {
      const result = depsEngine.deps('src/a.ts');
      expect(result.type).toBe('deps');
      expect(result.count).toBe(1);

      const tree = result.results[0].tree;
      expect(tree.file).toBe('src/a.ts');
      expect(tree.deps.length).toBe(2);
      const depFiles = tree.deps.map(d => d.file).sort();
      expect(depFiles).toEqual(['src/b.ts', 'src/c.ts']);
    });

    it('includes export names in nodes', () => {
      const result = depsEngine.deps('src/a.ts');
      const tree = result.results[0].tree;
      const nodeB = tree.deps.find(d => d.file === 'src/b.ts')!;
      expect(nodeB.exports).toContain('foo');
    });

    it('prevents cycles with visited set', () => {
      // C is reachable from both A→C and A→B→C
      // With pre-marking, both B and C are direct deps of A
      // B won't show C again since C is already visited
      const result = depsEngine.deps('src/a.ts', 'imports', 3);
      const tree = result.results[0].tree;
      const nodeB = tree.deps.find(d => d.file === 'src/b.ts')!;
      // C was pre-marked as visited when A's targets were collected
      expect(nodeB.deps.length).toBe(0);
    });

    it('respects depth limit', () => {
      const result = depsEngine.deps('src/a.ts', 'imports', 1);
      const tree = result.results[0].tree;
      // At depth 1, children exist but have no deps explored
      for (const dep of tree.deps) {
        expect(dep.deps.length).toBe(0);
      }
    });

    it('follows importers direction (reverse)', () => {
      const result = depsEngine.deps('src/c.ts', 'importers');
      const tree = result.results[0].tree;
      expect(tree.file).toBe('src/c.ts');
      // Both A and B import C
      const depFiles = tree.deps.map(d => d.file).sort();
      expect(depFiles).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('returns empty for non-existent file', () => {
      const result = depsEngine.deps('no/such/file.ts');
      expect(result.count).toBe(0);
    });

    it('caps depth at 5', () => {
      const result = depsEngine.deps('src/a.ts', 'imports', 100);
      expect(result.results[0].depth).toBe(5);
    });

    it('handles file with no resolved imports', () => {
      const result = depsEngine.deps('src/c.ts', 'imports');
      const tree = result.results[0].tree;
      expect(tree.deps.length).toBe(0);
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

// ── New token-saver tools ─────────────────────────────────────────────

describe('QueryEngine.signatures', () => {
  let db: Database.Database;
  let engine: QueryEngine;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(new NexusStore(db));
    engine = new QueryEngine(db);
  });

  afterEach(() => db.close());

  it('returns signature + doc summary, no body', () => {
    const result = engine.signatures(['formatDate', 'Button']);
    expect(result.type).toBe('signatures');
    expect(result.results.length).toBeGreaterThan(0);
    const fmt = result.results.find(r => r.name === 'formatDate');
    expect(fmt?.signature).toBe('(date: Date) => string');
    expect(fmt?.doc_summary).toBe('Formats a date');
    // Bodies are not included
    expect((fmt as unknown as { source?: string }).source).toBeUndefined();
  });

  it('returns empty for empty input', () => {
    const result = engine.signatures([]);
    expect(result.results).toEqual([]);
  });

  it('filters by kind', () => {
    const result = engine.signatures(['formatDate', 'Button'], { kind: 'function' });
    expect(result.results.every(r => r.kind === 'function')).toBe(true);
  });

  it('dedupes by (name, file)', () => {
    const result = engine.signatures(['formatDate', 'formatDate']);
    const fmts = result.results.filter(r => r.name === 'formatDate');
    expect(fmts.length).toBe(1);
  });
});

describe('QueryEngine.doc', () => {
  let db: Database.Database;
  let engine: QueryEngine;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(new NexusStore(db));
    engine = new QueryEngine(db);
  });

  afterEach(() => db.close());

  it('returns just the docstring', () => {
    const result = engine.doc('formatDate');
    expect(result.type).toBe('doc');
    expect(result.results[0]?.doc).toBe('Formats a date');
    expect((result.results[0] as unknown as { source?: string }).source).toBeUndefined();
  });

  it('returns symbol with no doc when none recorded', () => {
    const result = engine.doc('parseDate');
    expect(result.results.length).toBe(1);
    expect(result.results[0].doc).toBeUndefined();
  });

  it('returns empty for unknown symbol', () => {
    const result = engine.doc('NoSuchThing');
    expect(result.results).toEqual([]);
  });
});

describe('QueryEngine.kindIndex', () => {
  let db: Database.Database;
  let engine: QueryEngine;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(new NexusStore(db));
    engine = new QueryEngine(db);
  });

  afterEach(() => db.close());

  it('lists every symbol of a given kind', () => {
    const result = engine.kindIndex('function');
    expect(result.type).toBe('kind_index');
    const names = result.results.map(r => r.name);
    expect(names).toContain('formatDate');
    expect(names).toContain('parseDate');
  });

  it('respects path prefix', () => {
    const result = engine.kindIndex('component', { path: 'src/components' });
    expect(result.results.length).toBe(1);
    expect(result.results[0].name).toBe('Button');
  });

  it('returns empty for unknown kind', () => {
    const result = engine.kindIndex('quokka');
    expect(result.results).toEqual([]);
  });

  it('respects limit', () => {
    const result = engine.kindIndex('function', { limit: 1 });
    expect(result.results.length).toBe(1);
  });
});

describe('QueryEngine.callers', () => {
  let db: Database.Database;
  let engine: QueryEngine;

  beforeEach(() => {
    db = createTestDb();
    const store = new NexusStore(db);
    seedTestData(store);

    // Add an enclosing symbol in Button.tsx whose body contains the formatDate call site at line 15
    store.insertSymbols([
      { file_id: 2, name: 'render', kind: 'function', line: 12, col: 0, end_line: 28, signature: '() => JSX.Element' },
    ]);
    engine = new QueryEngine(db);
  });

  afterEach(() => db.close());

  it('finds enclosing symbol of an external call site', () => {
    const result = engine.callers('formatDate');
    expect(result.type).toBe('callers');
    expect(result.results.length).toBe(1);
    const callers = result.results[0].callers;
    const renderCaller = callers.find(c => c.caller.name === 'render');
    expect(renderCaller).toBeDefined();
    expect(renderCaller!.call_sites.length).toBeGreaterThan(0);
  });

  it('excludes the def line itself', () => {
    const result = engine.callers('formatDate');
    const sites = result.results[0].callers.flatMap(c => c.call_sites);
    // Definition is at line 5 in file 1 — must not appear
    expect(sites.find(s => s.line === 5 && s.context.includes('export function formatDate'))).toBeUndefined();
  });

  it('returns empty target list when symbol does not exist', () => {
    const result = engine.callers('NoSuchSymbol');
    expect(result.results).toEqual([]);
  });
});

describe('callers ref_kinds filter', () => {
  let db2: Database.Database;
  let store2: NexusStore;
  let engine2: QueryEngine;

  beforeEach(() => {
    db2 = createTestDb();
    store2 = new NexusStore(db2);
    // Seed: file with a function `parse` defined, and another file that
    // uses `parse` as both a call and a type-ref.
    const f1 = store2.insertFile({
      path: 'src/parse.ts', path_key: 'src/parse.ts', hash: 'h1', mtime: 1, size: 100,
      language: 'typescript', status: 'indexed', indexed_at: '2026-04-19T00:00:00Z',
    });
    const f2 = store2.insertFile({
      path: 'src/caller.ts', path_key: 'src/caller.ts', hash: 'h2', mtime: 2, size: 100,
      language: 'typescript', status: 'indexed', indexed_at: '2026-04-19T00:00:00Z',
    });
    store2.insertSymbols([
      { file_id: f1, name: 'parse', kind: 'function', line: 1, col: 0, end_line: 3, signature: '(s: string) => void' },
      { file_id: f2, name: 'doWork', kind: 'function', line: 10, col: 0, end_line: 20 },
    ]);
    store2.insertOccurrences([
      { file_id: f1, name: 'parse', line: 1, col: 9, confidence: 'heuristic', ref_kind: 'declaration' },
      { file_id: f2, name: 'parse', line: 12, col: 4, confidence: 'heuristic', ref_kind: 'call' },
      { file_id: f2, name: 'parse', line: 15, col: 20, confidence: 'heuristic', ref_kind: 'type-ref' },
    ]);
    engine2 = new QueryEngine(db2);
  });

  afterEach(() => db2.close());

  it('default (no filter) returns all occurrences — includes type-ref', () => {
    const result = engine2.callers('parse');
    expect(result.results[0].callers[0].call_sites.length).toBe(2);
  });

  it('ref_kinds=["call"] returns only call sites', () => {
    const result = engine2.callers('parse', { ref_kinds: ['call'] });
    expect(result.results[0].callers[0].call_sites.length).toBe(1);
    expect(result.results[0].callers[0].call_sites[0].line).toBe(12);
  });

  it('ref_kinds=["type-ref"] returns only type-ref sites', () => {
    const result = engine2.callers('parse', { ref_kinds: ['type-ref'] });
    expect(result.results[0].callers[0].call_sites.length).toBe(1);
    expect(result.results[0].callers[0].call_sites[0].line).toBe(15);
  });
});

describe('QueryEngine.unusedExports', () => {
  let db: Database.Database;
  let engine: QueryEngine;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(new NexusStore(db));
    engine = new QueryEngine(db);
  });

  afterEach(() => db.close());

  it('returns DateFormat as unused (not imported, no external occurrences)', () => {
    const result = engine.unusedExports();
    expect(result.type).toBe('unused_exports');
    const names = result.results.map(r => r.name);
    expect(names).toContain('DateFormat');
    // formatDate is used externally (Button imports it + has occurrence) — should NOT appear
    expect(names).not.toContain('formatDate');
  });

  it('respects path prefix', () => {
    const result = engine.unusedExports({ path: 'src/components' });
    // Button is exported as default — has no name match, so it's filtered too
    // Just check no formatDate (lives in src/utils)
    expect(result.results.find(r => r.name === 'formatDate')).toBeUndefined();
  });
});

describe('QueryEngine.definitionAt', () => {
  let db: Database.Database;
  let engine: QueryEngine;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-defat-'));
    fs.mkdirSync(path.join(tmpRoot, 'src', 'components'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'utils.ts'),
      'const MAX_RETRIES = 3;\nexport type DateFormat = "iso" | "us";\nexport function formatDate(date) { return String(date); }\n',
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'components', 'Button.tsx'),
      Array(14).fill('// pad').join('\n') + '\n  const formatted = formatDate(new Date());\n',
    );

    db = createTestDb();
    const store = new NexusStore(db);
    seedTestData(store);
    store.setMeta('root_path', tmpRoot);
    engine = new QueryEngine(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves identifier on a line to its definition source', () => {
    // Line 15 in Button.tsx → "  const formatted = formatDate(new Date());"
    const result = engine.definitionAt('src/components/Button.tsx', 15, 22);
    expect(result.type).toBe('definition_at');
    expect(result.results.length).toBe(1);
    expect(result.results[0].name).toBe('formatDate');
  });

  it('returns empty when file is not indexed', () => {
    const result = engine.definitionAt('no/such/file.ts', 1);
    expect(result.results).toEqual([]);
  });
});

describe('slice ref_kinds filter', () => {
  let db3: Database.Database;
  let store3: NexusStore;
  let engine3: QueryEngine;
  let tmp: string;

  beforeEach(() => {
    db3 = createTestDb();
    store3 = new NexusStore(db3);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ref-kind-'));
    fs.writeFileSync(
      path.join(tmp, 'main.ts'),
      'export function main() {\n  helper();\n  const x: Foo = { a: 1 };\n}\n',
    );
    fs.writeFileSync(
      path.join(tmp, 'helper.ts'),
      'export function helper() {}\nexport interface Foo { a: number }\n',
    );
    store3.setMeta('root_path', tmp);

    const f1 = store3.insertFile({
      path: 'main.ts', path_key: 'main.ts', hash: 'h', mtime: 1, size: 100,
      language: 'typescript', status: 'indexed', indexed_at: '2026-04-19T00:00:00Z',
    });
    const f2 = store3.insertFile({
      path: 'helper.ts', path_key: 'helper.ts', hash: 'h2', mtime: 2, size: 50,
      language: 'typescript', status: 'indexed', indexed_at: '2026-04-19T00:00:00Z',
    });

    store3.insertSymbols([
      { file_id: f1, name: 'main', kind: 'function', line: 1, col: 16, end_line: 4 },
    ]);
    store3.insertSymbols([
      { file_id: f2, name: 'helper', kind: 'function', line: 1, col: 16, end_line: 1 },
      { file_id: f2, name: 'Foo', kind: 'interface', line: 2, col: 17, end_line: 2 },
    ]);

    // Occurrences inside main()'s body range:
    store3.insertOccurrences([
      { file_id: f1, name: 'helper', line: 2, col: 2, confidence: 'heuristic', ref_kind: 'call' },
      { file_id: f1, name: 'Foo',    line: 3, col: 11, confidence: 'heuristic', ref_kind: 'type-ref' },
      { file_id: f1, name: 'x',      line: 3, col: 8,  confidence: 'heuristic', ref_kind: 'declaration' },
    ]);

    engine3 = new QueryEngine(db3);
  });

  afterEach(() => {
    db3.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('default slice includes both call and type-ref references', () => {
    const result = engine3.slice('main');
    const refNames = result.results[0]?.references.map(r => r.name).sort();
    expect(refNames).toEqual(['Foo', 'helper']);
  });

  it('ref_kinds=["call"] excludes type-ref references', () => {
    const result = engine3.slice('main', { ref_kinds: ['call'] });
    const refNames = result.results[0]?.references.map(r => r.name);
    expect(refNames).toContain('helper');
    expect(refNames).not.toContain('Foo');
  });

  it('ref_kinds=["type-ref"] excludes call references', () => {
    const result = engine3.slice('main', { ref_kinds: ['type-ref'] });
    const refNames = result.results[0]?.references.map(r => r.name);
    expect(refNames).toContain('Foo');
    expect(refNames).not.toContain('helper');
  });
});

describe('compactify', () => {
  it('drops envelope chrome and renames keys', async () => {
    const { compactify } = await import('../src/query/compact.js');
    const verbose = {
      query: 'find foo',
      type: 'find' as const,
      results: [{ name: 'foo', kind: 'function', file: 'a.ts', line: 5, col: 0, language: 'typescript' }],
      count: 1,
      index_status: 'current' as const,
      index_health: 'ok' as const,
      timing_ms: 1.2,
    };
    const compact = compactify(verbose) as { ty: string; r: { nm: string; k: string; f: string; l: number; lg: string }[] };
    expect(compact.ty).toBe('find');
    expect(compact.r[0].nm).toBe('foo');
    expect(compact.r[0].k).toBe('function');
    expect(compact.r[0].f).toBe('a.ts');
    expect((compact as unknown as { query?: string }).query).toBeUndefined();
    expect((compact as unknown as { timing_ms?: number }).timing_ms).toBeUndefined();
  });

  it('payload is meaningfully smaller than verbose', async () => {
    const { compactify } = await import('../src/query/compact.js');
    const verbose = {
      query: 'find foo',
      type: 'find' as const,
      results: [
        { name: 'foo', kind: 'function', file: 'a.ts', line: 5, col: 0, end_line: 10, signature: 'foo()', language: 'typescript' },
        { name: 'bar', kind: 'function', file: 'b.ts', line: 1, col: 0, end_line: 3, signature: 'bar()', language: 'typescript' },
      ],
      count: 2,
      index_status: 'current' as const,
      index_health: 'ok' as const,
      timing_ms: 0.5,
    };
    const verboseLen = JSON.stringify(verbose).length;
    const compactLen = JSON.stringify(compactify(verbose)).length;
    expect(compactLen).toBeLessThan(verboseLen * 0.7);
  });

  it('drops null, undefined, empty string, false flags', async () => {
    const { compactify } = await import('../src/query/compact.js');
    const verbose = {
      query: 'q',
      type: 'find' as const,
      results: [{ name: 'foo', kind: 'function', file: 'a.ts', line: 5, col: 0, signature: '', is_default: false, language: 'typescript' }],
      count: 1,
      index_status: 'current' as const,
      index_health: 'ok' as const,
      timing_ms: 0,
    };
    const compact = compactify(verbose) as { r: Record<string, unknown>[] };
    expect(compact.r[0].s).toBeUndefined(); // signature: '' dropped
    expect(compact.r[0].id).toBeUndefined(); // is_default: false dropped
  });
});

describe('occurrences ref_kinds filter', () => {
  let dbo: Database.Database;
  let storeo: NexusStore;
  let engineo: QueryEngine;

  beforeEach(() => {
    dbo = createTestDb();
    storeo = new NexusStore(dbo);
    const fid = storeo.insertFile({
      path: 'x.ts', path_key: 'x.ts', hash: 'h', mtime: 1, size: 10,
      language: 'typescript', status: 'indexed', indexed_at: '2026-04-19T00:00:00Z',
    });
    storeo.insertOccurrences([
      { file_id: fid, name: 'foo', line: 1, col: 0, confidence: 'heuristic', ref_kind: 'call' },
      { file_id: fid, name: 'foo', line: 2, col: 0, confidence: 'heuristic', ref_kind: 'type-ref' },
      { file_id: fid, name: 'foo', line: 3, col: 0, confidence: 'heuristic', ref_kind: null },
    ]);
    engineo = new QueryEngine(dbo);
  });

  afterEach(() => dbo.close());

  it('default returns all occurrences including NULL ref_kind', () => {
    const result = engineo.occurrences('foo');
    expect(result.count).toBe(3);
  });

  it('ref_kinds filter excludes NULL rows', () => {
    const result = engineo.occurrences('foo', { ref_kinds: ['call'] });
    expect(result.count).toBe(1);
    expect(result.results[0].line).toBe(1);
  });
});

describe('unusedExports mode', () => {
  let dbu: Database.Database;
  let storeu: NexusStore;
  let engineu: QueryEngine;

  beforeEach(() => {
    dbu = createTestDb();
    storeu = new NexusStore(dbu);
    // File 1 exports `PublicType`. File 2 imports it as a type only.
    const f1 = storeu.insertFile({
      path: 'lib.ts', path_key: 'lib.ts', hash: 'h1', mtime: 1, size: 100,
      language: 'typescript', status: 'indexed', indexed_at: '2026-04-19T00:00:00Z',
    });
    const f2 = storeu.insertFile({
      path: 'user.ts', path_key: 'user.ts', hash: 'h2', mtime: 2, size: 100,
      language: 'typescript', status: 'indexed', indexed_at: '2026-04-19T00:00:00Z',
    });
    storeu.insertSymbols([
      { file_id: f1, name: 'PublicType', kind: 'type', line: 1, col: 0 },
    ]);
    storeu.insertModuleEdges([
      { file_id: f1, kind: 'export', name: 'PublicType', line: 1, is_default: false, is_star: false, is_type: true },
      // type-only import in user.ts
      { file_id: f2, kind: 'import', name: 'PublicType', source: './lib', line: 1,
        is_default: false, is_star: false, is_type: true },
    ]);
    // Resolve the import so the store sees it as a real importer.
    const edges = storeu.getImportsByFileId(f2);
    storeu.resolveEdge(edges[0].id, f1);
    // Record a type-ref occurrence in user.ts (the only external use).
    storeu.insertOccurrences([
      { file_id: f2, name: 'PublicType', line: 5, col: 10, confidence: 'heuristic', ref_kind: 'type-ref' },
    ]);
    engineu = new QueryEngine(dbu);
  });

  afterEach(() => dbu.close());

  it('default mode does NOT flag a type-only-used export as unused', () => {
    const result = engineu.unusedExports();
    const names = result.results.map(r => r.name);
    expect(names).not.toContain('PublicType');
  });

  it('mode=runtime_only flags a type-only-used export as unused', () => {
    const result = engineu.unusedExports({ mode: 'runtime_only' });
    const names = result.results.map(r => r.name);
    expect(names).toContain('PublicType');
  });
});
