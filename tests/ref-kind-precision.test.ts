import { describe, it, expect } from 'vitest';
import { extractOccurrencesForTest } from '../src/analysis/languages/typescript.js';

/**
 * Each row is a labeled expectation for a specific (name, line) pair.
 * Lines are 1-based. If a name appears multiple times on the same line,
 * the test picks the first occurrence; add a col if that becomes a problem.
 */
interface Label {
  name: string;
  line: number;
  kind: 'call' | 'read' | 'write' | 'type-ref' | 'declaration';
}

/**
 * Note on single-char identifiers: the occurrence extractor intentionally
 * filters `name.length > 1` to suppress loop-counter noise (i, j, k, etc.).
 * The original plan fixture used `x`, which is excluded by this design
 * decision. The fixture below uses `count` instead to exercise the same
 * write/declaration paths without fighting the filter.
 */
const FIXTURE = `
export const MAX = 10;
export type Foo = { a: number };

export function greet(name: string): string {
  return 'hi ' + name;
}

export function main(): void {
  let count: number = 0;
  count = count + MAX;
  greet('world');
}

const obj: Foo = { a: 1 };
obj.a = 2;
`.trimStart();

const LABELS: Label[] = [
  { name: 'MAX', line: 1, kind: 'declaration' },
  { name: 'Foo', line: 2, kind: 'declaration' },
  { name: 'greet', line: 4, kind: 'declaration' },
  { name: 'name', line: 4, kind: 'declaration' },
  { name: 'name', line: 5, kind: 'read' },
  { name: 'main', line: 8, kind: 'declaration' },
  { name: 'count', line: 9, kind: 'declaration' },
  { name: 'count', line: 10, kind: 'write' }, // first occurrence = LHS
  { name: 'MAX', line: 10, kind: 'read' },
  { name: 'greet', line: 11, kind: 'call' },
  { name: 'obj', line: 14, kind: 'declaration' },
  { name: 'Foo', line: 14, kind: 'type-ref' },
  { name: 'obj', line: 15, kind: 'read' }, // member base: obj.a = 2 — obj is read, 'a' is the write target
];

describe('ref_kind classification precision (labeled fixture)', () => {
  const occurrences = extractOccurrencesForTest(FIXTURE);

  /**
   * Look up the first occurrence with a matching (name, line).
   */
  function find(label: Label) {
    return occurrences.find(o => o.name === label.name && o.line === label.line);
  }

  const byKind: Record<Label['kind'], { total: number; correct: number }> = {
    call: { total: 0, correct: 0 },
    read: { total: 0, correct: 0 },
    write: { total: 0, correct: 0 },
    'type-ref': { total: 0, correct: 0 },
    declaration: { total: 0, correct: 0 },
  };

  for (const label of LABELS) {
    byKind[label.kind].total += 1;
    const hit = find(label);
    if (hit && hit.ref_kind === label.kind) {
      byKind[label.kind].correct += 1;
    }
  }

  it('call precision ≥ 95%', () => {
    const { total, correct } = byKind.call;
    expect(total).toBeGreaterThan(0);
    expect(correct / total).toBeGreaterThanOrEqual(0.95);
  });

  it('type-ref precision ≥ 90%', () => {
    const { total, correct } = byKind['type-ref'];
    expect(total).toBeGreaterThan(0);
    expect(correct / total).toBeGreaterThanOrEqual(0.90);
  });

  it('declaration precision ≥ 95%', () => {
    const { total, correct } = byKind.declaration;
    expect(total).toBeGreaterThan(0);
    expect(correct / total).toBeGreaterThanOrEqual(0.95);
  });

  it('write precision ≥ 90%', () => {
    const { total, correct } = byKind.write;
    expect(total).toBeGreaterThan(0);
    expect(correct / total).toBeGreaterThanOrEqual(0.90);
  });

  it('every labeled position has a matching occurrence', () => {
    const missing = LABELS.filter(l => !find(l));
    expect(missing).toEqual([]);
  });
});
