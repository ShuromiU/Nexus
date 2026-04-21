import { describe, it, expect, beforeEach } from 'vitest';
import { DocumentCache } from '../src/analysis/documents/cache.js';

describe('DocumentCache', () => {
  let cache: DocumentCache;
  beforeEach(() => {
    cache = new DocumentCache({ maxEntries: 4, maxBytes: 1000 });
  });

  it('returns undefined on miss', () => {
    expect(cache.get('/a', 1, 10)).toBeUndefined();
  });

  it('hits when key triple matches', () => {
    cache.set('/a', 100, 50, { value: 1 }, 50);
    expect(cache.get('/a', 100, 50)).toEqual({ value: 1 });
  });

  it('misses when mtime changes', () => {
    cache.set('/a', 100, 50, { value: 1 }, 50);
    expect(cache.get('/a', 101, 50)).toBeUndefined();
  });

  it('misses when size changes', () => {
    cache.set('/a', 100, 50, { value: 1 }, 50);
    expect(cache.get('/a', 100, 51)).toBeUndefined();
  });

  it('re-setting a path replaces its entry (no duplication)', () => {
    cache.set('/a', 100, 50, { v: 1 }, 50);
    cache.set('/a', 200, 60, { v: 2 }, 60);
    expect(cache.get('/a', 100, 50)).toBeUndefined();
    expect(cache.get('/a', 200, 60)).toEqual({ v: 2 });
    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().bytes).toBe(60);
  });

  it('evicts by LRU order when maxEntries exceeded', () => {
    cache.set('/a', 1, 10, 'a', 10);
    cache.set('/b', 1, 10, 'b', 10);
    cache.set('/c', 1, 10, 'c', 10);
    cache.set('/d', 1, 10, 'd', 10);
    // All 4 present.
    expect(cache.get('/a', 1, 10)).toBe('a');
    // Adding a 5th evicts the LRU. /a was just touched, /b is now LRU.
    cache.set('/e', 1, 10, 'e', 10);
    expect(cache.get('/b', 1, 10)).toBeUndefined();
    expect(cache.get('/a', 1, 10)).toBe('a');
    expect(cache.get('/e', 1, 10)).toBe('e');
  });

  it('evicts by LRU order when maxBytes exceeded', () => {
    const c = new DocumentCache({ maxEntries: 100, maxBytes: 100 });
    c.set('/a', 1, 40, 'a', 40);
    c.set('/b', 1, 40, 'b', 40);
    // 80 bytes, fits.
    c.set('/c', 1, 40, 'c', 40);
    // 120 bytes — /a must have been evicted.
    expect(c.get('/a', 1, 40)).toBeUndefined();
    expect(c.get('/b', 1, 40)).toBe('b');
    expect(c.get('/c', 1, 40)).toBe('c');
    expect(c.stats().bytes).toBe(80);
  });

  it('get() promotes entry to most-recently-used', () => {
    cache.set('/a', 1, 10, 'a', 10);
    cache.set('/b', 1, 10, 'b', 10);
    cache.set('/c', 1, 10, 'c', 10);
    cache.set('/d', 1, 10, 'd', 10);
    // /a is LRU. Touch it — now /b is LRU.
    cache.get('/a', 1, 10);
    cache.set('/e', 1, 10, 'e', 10);
    expect(cache.get('/b', 1, 10)).toBeUndefined();
    expect(cache.get('/a', 1, 10)).toBe('a');
  });

  it('clear() empties the cache', () => {
    cache.set('/a', 1, 10, 'a', 10);
    cache.set('/b', 1, 10, 'b', 10);
    cache.clear();
    expect(cache.get('/a', 1, 10)).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it('rejects entries larger than maxBytes outright', () => {
    const c = new DocumentCache({ maxEntries: 10, maxBytes: 50 });
    c.set('/big', 1, 100, 'big', 100);
    // Oversized entry is silently dropped — cache stays empty.
    expect(c.get('/big', 1, 100)).toBeUndefined();
    expect(c.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});
