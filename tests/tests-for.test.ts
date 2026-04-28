import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import { QueryEngine } from '../src/query/engine.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/test/project', true);
  return db;
}

describe('QueryEngine.testsFor', () => {
  let db: Database.Database;
  let store: NexusStore;
  let engine: QueryEngine;
  let srcId: number;
  let testId: number;
  let specId: number;
  let tsdirId: number;
  let nonTestId: number;

  beforeEach(() => {
    db = createTestDb();
    store = new NexusStore(db);

    srcId = store.insertFile({
      path: 'src/utils.ts', path_key: 'src/utils.ts',
      hash: 'h1', mtime: 1, size: 1, language: 'typescript',
      status: 'indexed', indexed_at: '2026-04-28T00:00:00Z',
    });
    testId = store.insertFile({
      path: 'src/utils.test.ts', path_key: 'src/utils.test.ts',
      hash: 'h2', mtime: 1, size: 1, language: 'typescript',
      status: 'indexed', indexed_at: '2026-04-28T00:00:00Z',
    });
    specId = store.insertFile({
      path: 'src/__tests__/utils.ts', path_key: 'src/__tests__/utils.ts',
      hash: 'h3', mtime: 1, size: 1, language: 'typescript',
      status: 'indexed', indexed_at: '2026-04-28T00:00:00Z',
    });
    tsdirId = store.insertFile({
      path: 'tests/integration/utils-it.ts', path_key: 'tests/integration/utils-it.ts',
      hash: 'h4', mtime: 1, size: 1, language: 'typescript',
      status: 'indexed', indexed_at: '2026-04-28T00:00:00Z',
    });
    nonTestId = store.insertFile({
      path: 'src/consumer.ts', path_key: 'src/consumer.ts',
      hash: 'h5', mtime: 1, size: 1, language: 'typescript',
      status: 'indexed', indexed_at: '2026-04-28T00:00:00Z',
    });

    store.insertSymbols([
      { file_id: srcId, name: 'formatDate', kind: 'function', line: 5, col: 0 },
    ]);

    // Each test file imports formatDate from src/utils.
    store.insertModuleEdges([
      { file_id: srcId, kind: 'export', name: 'formatDate', line: 5, is_default: false, is_star: false, is_type: false },
      { file_id: testId, kind: 'import', name: 'formatDate', source: '../utils', line: 1, is_default: false, is_star: false, is_type: false, resolved_file_id: srcId },
      { file_id: specId, kind: 'import', name: 'formatDate', source: '../utils', line: 1, is_default: false, is_star: false, is_type: false, resolved_file_id: srcId },
      { file_id: tsdirId, kind: 'import', name: 'formatDate', source: '../../src/utils', line: 1, is_default: false, is_star: false, is_type: false, resolved_file_id: srcId },
      { file_id: nonTestId, kind: 'import', name: 'formatDate', source: './utils', line: 1, is_default: false, is_star: false, is_type: false, resolved_file_id: srcId },
    ]);

    engine = new QueryEngine(db);
  });

  afterEach(() => db.close());

  it('finds tests by source file path', () => {
    const result = engine.testsFor({ file: 'src/utils.ts' });
    expect(result.type).toBe('tests_for');
    const paths = result.results.map(r => r.test_file).sort();
    expect(paths).toEqual([
      'src/__tests__/utils.ts',
      'src/utils.test.ts',
      'tests/integration/utils-it.ts',
    ]);
  });

  it('omits non-test importers (src/consumer.ts)', () => {
    const result = engine.testsFor({ file: 'src/utils.ts' });
    expect(result.results.find(r => r.test_file === 'src/consumer.ts')).toBeUndefined();
  });

  it('marks declared vs derived confidence', () => {
    const result = engine.testsFor({ file: 'src/utils.ts' });
    const byPath = Object.fromEntries(result.results.map(r => [r.test_file, r.confidence]));
    expect(byPath['src/utils.test.ts']).toBe('declared');
    expect(byPath['src/__tests__/utils.ts']).toBe('declared');
    expect(byPath['tests/integration/utils-it.ts']).toBe('derived');
  });

  it('finds tests by symbol name (resolves all declaring files)', () => {
    const result = engine.testsFor({ name: 'formatDate' });
    const paths = result.results.map(r => r.test_file).sort();
    expect(paths).toEqual([
      'src/__tests__/utils.ts',
      'src/utils.test.ts',
      'tests/integration/utils-it.ts',
    ]);
    // Source file is reported as the resolved declaration file.
    expect(result.results.every(r => r.source_file === 'src/utils.ts')).toBe(true);
  });

  it('returns imported_name + line', () => {
    const result = engine.testsFor({ file: 'src/utils.ts', limit: 1 });
    expect(result.results[0]).toMatchObject({
      imported_name: 'formatDate',
      line: 1,
      is_default: false,
      is_star: false,
      is_type: false,
    });
  });

  it('respects limit', () => {
    const result = engine.testsFor({ file: 'src/utils.ts', limit: 1 });
    expect(result.results).toHaveLength(1);
  });

  it('returns empty when source has no test importers', () => {
    const lonelyId = store.insertFile({
      path: 'src/lonely.ts', path_key: 'src/lonely.ts',
      hash: 'lh', mtime: 1, size: 1, language: 'typescript',
      status: 'indexed', indexed_at: '2026-04-28T00:00:00Z',
    });
    store.insertModuleEdges([
      { file_id: lonelyId, kind: 'export', name: 'lonely', line: 1, is_default: false, is_star: false, is_type: false },
    ]);
    const result = engine.testsFor({ file: 'src/lonely.ts' });
    expect(result.results).toEqual([]);
  });

  it('returns empty when file is not indexed', () => {
    const result = engine.testsFor({ file: 'no/such/file.ts' });
    expect(result.results).toEqual([]);
  });

  it('preserves star import flag on test importers', () => {
    const starTestId = store.insertFile({
      path: 'src/star.test.ts', path_key: 'src/star.test.ts',
      hash: 's', mtime: 1, size: 1, language: 'typescript',
      status: 'indexed', indexed_at: '2026-04-28T00:00:00Z',
    });
    store.insertModuleEdges([
      { file_id: starTestId, kind: 'import', source: '../utils', line: 1, is_default: false, is_star: true, is_type: false, resolved_file_id: srcId },
    ]);
    const result = engine.testsFor({ file: 'src/utils.ts' });
    const star = result.results.find(r => r.test_file === 'src/star.test.ts');
    expect(star).toBeDefined();
    expect(star!.is_star).toBe(true);
  });
});
