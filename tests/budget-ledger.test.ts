import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import { QueryEngine } from '../src/query/engine.js';
import { BudgetLedger, type BudgetEntry } from '../src/query/budget-ledger.js';

describe('BudgetLedger', () => {
  function entry(partial: Partial<BudgetEntry> = {}): BudgetEntry {
    return {
      query: 'q',
      budget_tokens: 1000,
      total_tokens: 500,
      included_count: 3,
      skipped_count: 0,
      timing_ms: 5,
      timestamp: '2026-04-28T00:00:00Z',
      ...partial,
    };
  }

  it('rejects capacity < 1', () => {
    expect(() => new BudgetLedger(0)).toThrow();
  });

  it('starts empty', () => {
    const led = new BudgetLedger();
    expect(led.entries()).toEqual([]);
    expect(led.summary()).toEqual({
      pack_runs: 0,
      total_tokens_used: 0,
      total_budget_allocated: 0,
      hit_budget_count: 0,
      avg_utilization: 0,
      total_timing_ms: 0,
    });
  });

  it('records entries in chronological order', () => {
    const led = new BudgetLedger(5);
    led.record(entry({ query: 'a' }));
    led.record(entry({ query: 'b' }));
    led.record(entry({ query: 'c' }));
    expect(led.entries().map(e => e.query)).toEqual(['a', 'b', 'c']);
  });

  it('overwrites oldest when full (ring buffer)', () => {
    const led = new BudgetLedger(3);
    for (const q of ['a', 'b', 'c', 'd', 'e']) {
      led.record(entry({ query: q }));
    }
    // Capacity 3 → only the last 3 retained, in order.
    expect(led.entries().map(e => e.query)).toEqual(['c', 'd', 'e']);
  });

  it('summary tallies totals + hits', () => {
    const led = new BudgetLedger();
    led.record(entry({ budget_tokens: 1000, total_tokens: 500, timing_ms: 5 }));
    led.record(entry({ budget_tokens: 1000, total_tokens: 1000, timing_ms: 10 })); // hit
    led.record(entry({ budget_tokens: 2000, total_tokens: 1500, timing_ms: 3 }));

    const s = led.summary();
    expect(s.pack_runs).toBe(3);
    expect(s.total_tokens_used).toBe(3000);
    expect(s.total_budget_allocated).toBe(4000);
    expect(s.hit_budget_count).toBe(1);
    expect(s.total_timing_ms).toBe(18);
    // (0.5 + 1.0 + 0.75) / 3 = 0.75
    expect(s.avg_utilization).toBeCloseTo(0.75);
  });

  it('entries(limit) returns most-recent N', () => {
    const led = new BudgetLedger(10);
    for (const q of ['a', 'b', 'c', 'd']) {
      led.record(entry({ query: q }));
    }
    expect(led.entries(2).map(e => e.query)).toEqual(['c', 'd']);
  });

  it('clear() empties the ledger', () => {
    const led = new BudgetLedger();
    led.record(entry());
    led.clear();
    expect(led.entries()).toEqual([]);
    expect(led.summary().pack_runs).toBe(0);
  });

  it('handles utilization safely when budget is zero', () => {
    const led = new BudgetLedger();
    led.record(entry({ budget_tokens: 0, total_tokens: 0 }));
    expect(led.summary().avg_utilization).toBe(0);
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

describe('QueryEngine.stats({ session: true })', () => {
  let db: Database.Database;
  let store: NexusStore;
  let engine: QueryEngine;

  beforeEach(() => {
    db = createTestDb();
    store = new NexusStore(db);
    const fileId = store.insertFile({
      path: 'src/utils.ts', path_key: 'src/utils.ts',
      hash: 'h', mtime: 1, size: 1, language: 'typescript',
      status: 'indexed', indexed_at: '2026-04-28T00:00:00Z',
    });
    store.insertSymbols([
      { file_id: fileId, name: 'formatDate', kind: 'function', line: 5, col: 0 },
    ]);
    engine = new QueryEngine(db);
  });

  afterEach(() => db.close());

  it('omits session field when session flag is absent', () => {
    const result = engine.stats();
    expect(result.results[0].session).toBeUndefined();
  });

  it('includes empty session block when no pack() calls have happened', () => {
    const result = engine.stats({ session: true });
    expect(result.results[0].session).toBeDefined();
    expect(result.results[0].session!.summary.pack_runs).toBe(0);
    expect(result.results[0].session!.recent).toEqual([]);
    expect(result.results[0].session!.capacity).toBeGreaterThan(0);
  });

  it('records pack() invocations into the ledger', () => {
    engine.pack('formatDate', { budget_tokens: 500 });
    engine.pack('formatDate', { budget_tokens: 800 });
    const result = engine.stats({ session: true });
    expect(result.results[0].session!.summary.pack_runs).toBe(2);
    expect(result.results[0].session!.recent).toHaveLength(2);
    expect(result.results[0].session!.recent[0].query).toBe('formatDate');
    expect(result.results[0].session!.recent[0].budget_tokens).toBe(500);
    expect(result.results[0].session!.recent[1].budget_tokens).toBe(800);
  });

  it('respects recent_limit', () => {
    for (let i = 0; i < 5; i++) {
      engine.pack(`q${i}`, { budget_tokens: 200 });
    }
    const result = engine.stats({ session: true, recent_limit: 2 });
    expect(result.results[0].session!.recent).toHaveLength(2);
    // Should be the 2 most recent (q3, q4).
    expect(result.results[0].session!.recent.map(e => e.query)).toEqual(['q3', 'q4']);
  });

  it('shares ledger when injected', () => {
    const sharedLedger = new BudgetLedger(20);
    const eng1 = new QueryEngine(db, { budgetLedger: sharedLedger });
    const eng2 = new QueryEngine(db, { budgetLedger: sharedLedger });
    eng1.pack('one', { budget_tokens: 200 });
    eng2.pack('two', { budget_tokens: 200 });
    const result = eng2.stats({ session: true });
    expect(result.results[0].session!.summary.pack_runs).toBe(2);
  });
});
