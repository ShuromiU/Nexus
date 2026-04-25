import { describe, it, expect } from 'vitest';
import { computeInputHash } from '../src/policy/telemetry-config.js';

describe('computeInputHash', () => {
  it('returns a 16-character hex string', () => {
    const h = computeInputHash({ a: 1 });
    expect(h).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(h)).toBe(true);
  });

  it('is deterministic across calls', () => {
    const a = computeInputHash({ file_path: 'x.ts', new_string: 'y' });
    const b = computeInputHash({ file_path: 'x.ts', new_string: 'y' });
    expect(a).toBe(b);
  });

  it('is order-insensitive (sorts keys recursively)', () => {
    const a = computeInputHash({ file_path: 'x.ts', new_string: 'y' });
    const b = computeInputHash({ new_string: 'y', file_path: 'x.ts' });
    expect(a).toBe(b);
  });

  it('descends into nested objects for sorting', () => {
    const a = computeInputHash({ outer: { a: 1, b: 2 }, c: 3 });
    const b = computeInputHash({ c: 3, outer: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it('different inputs produce different hashes', () => {
    const a = computeInputHash({ file_path: 'x.ts' });
    const b = computeInputHash({ file_path: 'y.ts' });
    expect(a).not.toBe(b);
  });

  it('handles arrays without sorting their elements', () => {
    const a = computeInputHash({ list: [1, 2, 3] });
    const b = computeInputHash({ list: [3, 2, 1] });
    expect(a).not.toBe(b);
  });
});
