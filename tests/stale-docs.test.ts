import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import { QueryEngine } from '../src/query/engine.js';
import {
  extractDocParams,
  extractSignatureParams,
  diffDocAgainstSignature,
} from '../src/query/stale-docs.js';

describe('extractDocParams', () => {
  it('parses a plain JSDoc block', () => {
    const doc = `/**\n * Format a date.\n * @param date - the date\n * @param format - format hint\n */`;
    expect(extractDocParams(doc)).toEqual(['date', 'format']);
  });

  it('handles typed @param {T} name', () => {
    const doc = `/**\n * @param {string} name\n * @param {Date} when\n */`;
    expect(extractDocParams(doc)).toEqual(['name', 'when']);
  });

  it('handles rest @param ...args', () => {
    const doc = `/**\n * @param ...args - rest\n */`;
    expect(extractDocParams(doc)).toEqual(['args']);
  });

  it('handles bracketed optional [name]', () => {
    const doc = `/**\n * @param [opts] - optional\n */`;
    expect(extractDocParams(doc)).toEqual(['opts']);
  });

  it('returns [] when no @param tags', () => {
    expect(extractDocParams('/** Nothing relevant. */')).toEqual([]);
    expect(extractDocParams('// line comment')).toEqual([]);
    expect(extractDocParams('')).toEqual([]);
  });

  it('preserves order', () => {
    const doc = `/**\n * @param c\n * @param a\n * @param b\n */`;
    expect(extractDocParams(doc)).toEqual(['c', 'a', 'b']);
  });
});

describe('extractSignatureParams', () => {
  it('parses simple typed params', () => {
    expect(extractSignatureParams('(date: Date, format: string)')).toEqual(['date', 'format']);
  });

  it('parses optional params', () => {
    expect(extractSignatureParams('(date: Date, opts?: Options)')).toEqual(['date', 'opts']);
  });

  it('parses rest params', () => {
    expect(extractSignatureParams('(...args: string[])')).toEqual(['args']);
  });

  it('returns null for destructured params', () => {
    const params = extractSignatureParams('({ x, y }: Point, label: string)');
    expect(params).toEqual([null, 'label']);
  });

  it('handles return type annotation after params', () => {
    expect(extractSignatureParams('(a: number): boolean')).toEqual(['a']);
  });

  it('handles default values containing commas (does not split mid-default)', () => {
    expect(extractSignatureParams('(opts: { a: 1, b: 2 } = { a: 1, b: 2 }, x: number)')).toEqual(['opts', 'x']);
  });

  it('handles generic types with angle brackets', () => {
    expect(extractSignatureParams('(map: Map<string, number>, key: string)')).toEqual(['map', 'key']);
  });

  it('strips access modifiers (public/private/readonly)', () => {
    expect(extractSignatureParams('(public readonly id: string, private name: string)')).toEqual(['id', 'name']);
  });

  it('returns [] for empty params', () => {
    expect(extractSignatureParams('()')).toEqual([]);
    expect(extractSignatureParams('(): void')).toEqual([]);
  });

  it('returns [] for missing parens', () => {
    expect(extractSignatureParams('not a signature')).toEqual([]);
  });
});

describe('diffDocAgainstSignature', () => {
  it('returns [] when both sides match', () => {
    expect(diffDocAgainstSignature(
      `/** @param a\n * @param b */`,
      '(a: number, b: string)',
    )).toEqual([]);
  });

  it('returns [] when doc has no @param tags', () => {
    expect(diffDocAgainstSignature(
      '/** Just a description. */',
      '(a: number)',
    )).toEqual([]);
  });

  it('flags unknown_param when doc references a non-existent param', () => {
    const issues = diffDocAgainstSignature(
      `/** @param oldName - renamed */`,
      '(newName: string)',
    );
    expect(issues).toContainEqual({ kind: 'unknown_param', detail: 'oldName' });
    expect(issues).toContainEqual({ kind: 'undocumented_param', detail: 'newName' });
  });

  it('flags undocumented_param when sig has a param the doc lacks', () => {
    const issues = diffDocAgainstSignature(
      `/** @param a */`,
      '(a: number, b: number)',
    );
    expect(issues).toEqual([{ kind: 'undocumented_param', detail: 'b' }]);
  });

  it('returns [] when sig has only destructured params and doc has @param', () => {
    // We can't reliably parse destructured params; with no parseable sig
    // params, we don't have ground truth — return empty rather than spam.
    const issues = diffDocAgainstSignature(
      `/** @param point */`,
      '({ x, y }: Point)',
    );
    expect(issues).toEqual([]);
  });
});

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/test/project', true);
  return db;
}

describe('QueryEngine.staleDocs', () => {
  let db: Database.Database;
  let store: NexusStore;
  let engine: QueryEngine;
  let fileId: number;

  beforeEach(() => {
    db = createTestDb();
    store = new NexusStore(db);
    fileId = store.insertFile({
      path: 'src/utils.ts', path_key: 'src/utils.ts',
      hash: 'h', mtime: 1, size: 1, language: 'typescript',
      status: 'indexed', indexed_at: '2026-04-28T00:00:00Z',
    });
    engine = new QueryEngine(db);
  });

  afterEach(() => db.close());

  it('flags a renamed param (unknown + undocumented)', () => {
    store.insertSymbols([
      {
        file_id: fileId, name: 'fmt', kind: 'function', line: 5, col: 0,
        signature: '(newName: string): string',
        doc: '/** @param oldName - renamed */',
      },
    ]);
    const result = engine.staleDocs();
    expect(result.type).toBe('stale_docs');
    expect(result.results).toHaveLength(1);
    const issues = result.results[0].issues;
    expect(issues).toContainEqual({ kind: 'unknown_param', detail: 'oldName' });
    expect(issues).toContainEqual({ kind: 'undocumented_param', detail: 'newName' });
  });

  it('skips symbols with no @param tags (fully undocumented)', () => {
    store.insertSymbols([
      {
        file_id: fileId, name: 'noParams', kind: 'function', line: 5, col: 0,
        signature: '(a: number): void',
        doc: '/** Description only. */',
      },
    ]);
    expect(engine.staleDocs().results).toEqual([]);
  });

  it('skips symbols with matching docs', () => {
    store.insertSymbols([
      {
        file_id: fileId, name: 'good', kind: 'function', line: 5, col: 0,
        signature: '(a: number, b: string): void',
        doc: '/** @param a\n * @param b */',
      },
    ]);
    expect(engine.staleDocs().results).toEqual([]);
  });

  it('respects path filter', () => {
    const otherFileId = store.insertFile({
      path: 'tests/util.ts', path_key: 'tests/util.ts',
      hash: 'h2', mtime: 1, size: 1, language: 'typescript',
      status: 'indexed', indexed_at: '2026-04-28T00:00:00Z',
    });
    store.insertSymbols([
      {
        file_id: fileId, name: 'src_one', kind: 'function', line: 5, col: 0,
        signature: '(x: number)',
        doc: '/** @param y */',
      },
      {
        file_id: otherFileId, name: 'test_one', kind: 'function', line: 5, col: 0,
        signature: '(x: number)',
        doc: '/** @param y */',
      },
    ]);
    const names = engine.staleDocs({ path: 'src/' }).results.map(r => r.name);
    expect(names).toEqual(['src_one']);
  });

  it('respects kinds filter', () => {
    store.insertSymbols([
      {
        file_id: fileId, name: 'fn', kind: 'function', line: 5, col: 0,
        signature: '(x: number)',
        doc: '/** @param y */',
      },
      {
        file_id: fileId, name: 'm', kind: 'method', line: 8, col: 0, scope: 'C',
        signature: '(x: number)',
        doc: '/** @param y */',
      },
    ]);
    const names = engine.staleDocs({ kinds: ['method'] }).results.map(r => r.name);
    expect(names).toEqual(['m']);
  });

  it('respects limit', () => {
    for (let i = 0; i < 4; i++) {
      store.insertSymbols([
        {
          file_id: fileId, name: `f${i}`, kind: 'function', line: i + 1, col: 0,
          signature: '(x: number)',
          doc: '/** @param wrong */',
        },
      ]);
    }
    expect(engine.staleDocs({ limit: 2 }).results).toHaveLength(2);
  });

  it('returns empty NexusResult on empty index', () => {
    const result = engine.staleDocs();
    expect(result.type).toBe('stale_docs');
    expect(result.results).toEqual([]);
  });
});
