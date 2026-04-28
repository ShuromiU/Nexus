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

describe('QueryEngine.privateDeadCode', () => {
  let db: Database.Database;
  let store: NexusStore;
  let engine: QueryEngine;
  let fileId: number;

  beforeEach(() => {
    db = createTestDb();
    store = new NexusStore(db);
    fileId = store.insertFile({
      path: 'src/utils.ts',
      path_key: 'src/utils.ts',
      hash: 'h',
      mtime: 1,
      size: 1,
      language: 'typescript',
      status: 'indexed',
      indexed_at: '2026-04-28T00:00:00Z',
    });
    engine = new QueryEngine(db);
  });

  afterEach(() => db.close());

  it('flags an unexported, unreferenced top-level function', () => {
    store.insertSymbols([
      { file_id: fileId, name: 'orphan', kind: 'function', line: 5, col: 0 },
    ]);
    store.insertOccurrences([
      { file_id: fileId, name: 'orphan', line: 5, col: 9, confidence: 'exact' },
    ]);

    const result = engine.privateDeadCode();
    expect(result.type).toBe('private_dead');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      file: 'src/utils.ts',
      name: 'orphan',
      kind: 'function',
      line: 5,
    });
  });

  it('skips a symbol that has at least one in-file reference beyond declaration', () => {
    store.insertSymbols([
      { file_id: fileId, name: 'helper', kind: 'function', line: 5, col: 0 },
    ]);
    store.insertOccurrences([
      { file_id: fileId, name: 'helper', line: 5, col: 9, confidence: 'exact' },
      { file_id: fileId, name: 'helper', line: 12, col: 4, confidence: 'heuristic' },
    ]);

    const result = engine.privateDeadCode();
    expect(result.results.find(r => r.name === 'helper')).toBeUndefined();
  });

  it('skips an exported symbol (handled by unusedExports)', () => {
    store.insertSymbols([
      { file_id: fileId, name: 'publicFn', kind: 'function', line: 5, col: 0 },
    ]);
    store.insertModuleEdges([
      { file_id: fileId, kind: 'export', name: 'publicFn', line: 5, is_default: false, is_star: false, is_type: false },
    ]);
    store.insertOccurrences([
      { file_id: fileId, name: 'publicFn', line: 5, col: 16, confidence: 'exact' },
    ]);

    const result = engine.privateDeadCode();
    expect(result.results.find(r => r.name === 'publicFn')).toBeUndefined();
  });

  it('skips nested symbols (scope IS NOT NULL)', () => {
    store.insertSymbols([
      { file_id: fileId, name: 'PublicClass', kind: 'class', line: 1, col: 0 },
      { file_id: fileId, name: 'innerMethod', kind: 'method', line: 2, col: 2, scope: 'PublicClass' },
    ]);
    store.insertModuleEdges([
      { file_id: fileId, kind: 'export', name: 'PublicClass', line: 1, is_default: false, is_star: false, is_type: false },
    ]);
    store.insertOccurrences([
      { file_id: fileId, name: 'PublicClass', line: 1, col: 13, confidence: 'exact' },
      { file_id: fileId, name: 'innerMethod', line: 2, col: 2, confidence: 'exact' },
    ]);

    const result = engine.privateDeadCode();
    expect(result.results).toHaveLength(0);
  });

  it('does not flag a private symbol if the file has `export *`', () => {
    store.insertSymbols([
      { file_id: fileId, name: 'maybeReexported', kind: 'function', line: 5, col: 0 },
    ]);
    store.insertModuleEdges([
      { file_id: fileId, kind: 're-export', name: null, source: './internal', line: 1, is_default: false, is_star: true, is_type: false },
    ]);
    store.insertOccurrences([
      { file_id: fileId, name: 'maybeReexported', line: 5, col: 9, confidence: 'exact' },
    ]);

    const result = engine.privateDeadCode();
    expect(result.results.find(r => r.name === 'maybeReexported')).toBeUndefined();
  });

  it('respects path prefix filter', () => {
    const otherFile = store.insertFile({
      path: 'tests/util.ts',
      path_key: 'tests/util.ts',
      hash: 'h2',
      mtime: 2,
      size: 1,
      language: 'typescript',
      status: 'indexed',
      indexed_at: '2026-04-28T00:00:00Z',
    });
    store.insertSymbols([
      { file_id: fileId, name: 'srcOrphan', kind: 'function', line: 5, col: 0 },
      { file_id: otherFile, name: 'testOrphan', kind: 'function', line: 5, col: 0 },
    ]);
    store.insertOccurrences([
      { file_id: fileId, name: 'srcOrphan', line: 5, col: 9, confidence: 'exact' },
      { file_id: otherFile, name: 'testOrphan', line: 5, col: 9, confidence: 'exact' },
    ]);

    const result = engine.privateDeadCode({ path: 'src/' });
    const names = result.results.map(r => r.name);
    expect(names).toContain('srcOrphan');
    expect(names).not.toContain('testOrphan');
  });

  it('respects kinds filter', () => {
    store.insertSymbols([
      { file_id: fileId, name: 'orphanFn', kind: 'function', line: 5, col: 0 },
      { file_id: fileId, name: 'OrphanType', kind: 'type', line: 10, col: 0 },
    ]);
    store.insertOccurrences([
      { file_id: fileId, name: 'orphanFn', line: 5, col: 9, confidence: 'exact' },
      { file_id: fileId, name: 'OrphanType', line: 10, col: 12, confidence: 'exact' },
    ]);

    const result = engine.privateDeadCode({ kinds: ['type'] });
    const names = result.results.map(r => r.name);
    expect(names).toEqual(['OrphanType']);
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.insertSymbols([
        { file_id: fileId, name: `orphan${i}`, kind: 'function', line: i + 1, col: 0 },
      ]);
      store.insertOccurrences([
        { file_id: fileId, name: `orphan${i}`, line: i + 1, col: 9, confidence: 'exact' },
      ]);
    }
    const result = engine.privateDeadCode({ limit: 2 });
    expect(result.results).toHaveLength(2);
  });

  it('returns empty NexusResult on empty index', () => {
    const result = engine.privateDeadCode();
    expect(result.type).toBe('private_dead');
    expect(result.results).toEqual([]);
  });

  it('includes end_line when available', () => {
    store.insertSymbols([
      { file_id: fileId, name: 'longFn', kind: 'function', line: 5, col: 0, end_line: 25 },
    ]);
    store.insertOccurrences([
      { file_id: fileId, name: 'longFn', line: 5, col: 9, confidence: 'exact' },
    ]);
    const result = engine.privateDeadCode();
    expect(result.results[0].end_line).toBe(25);
  });

  it('treats `export { foo }` (separate from declaration) as exported', () => {
    // Symbol declared at line 5; exported by name on line 20 — the module_edge
    // shares the symbol's name but not its symbol_id (e.g. `export { foo };` block)
    store.insertSymbols([
      { file_id: fileId, name: 'reExportedFn', kind: 'function', line: 5, col: 0 },
    ]);
    store.insertModuleEdges([
      { file_id: fileId, kind: 'export', name: 'reExportedFn', line: 20, is_default: false, is_star: false, is_type: false },
    ]);
    store.insertOccurrences([
      { file_id: fileId, name: 'reExportedFn', line: 5, col: 9, confidence: 'exact' },
    ]);

    const result = engine.privateDeadCode();
    expect(result.results.find(r => r.name === 'reExportedFn')).toBeUndefined();
  });
});
