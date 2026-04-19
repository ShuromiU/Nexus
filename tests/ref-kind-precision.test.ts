import { describe, it, expect } from 'vitest';
import { extractOccurrencesForTest } from '../src/analysis/languages/typescript.js';

/**
 * Each row is a labeled expectation for a specific (name, line) pair.
 * Lines are 1-based. Include `col` when a name appears multiple times on
 * the same line to disambiguate (e.g. `count = count + 1` — LHS at col 2,
 * RHS at col 10).
 *
 * Note: The fixture uses `count`/`score` rather than single-char `x` because
 * src/analysis/languages/typescript.ts filters identifiers with
 * name.length <= 1 (intentional noise suppression for i/j/k loop vars).
 *
 * Note on member writes: the extractor emits the *base* (`obj`) as a read
 * when it sees `obj.a = 2`, not the member `a`. The member name `a` is
 * dropped by the name.length <= 1 noise guard in typescript.ts (intentional
 * suppression for single-char identifiers like i/j/k loop vars and short
 * property names), not because member property names are structurally excluded
 * from occurrence tracking. The write samples below use only plain variable
 * assignments and update-expressions which are actually emitted.
 */
interface Label {
  name: string;
  line: number;
  kind: 'call' | 'read' | 'write' | 'type-ref' | 'declaration';
  col?: number;
}

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
  greet('again');
  count++;
  let score: number = 0;
  score = score + 1;
}

const obj: Foo = { a: 1 };
obj.a = 2;
const alias: Foo = obj;
function useFoo(f: Foo): void { return f; }
useFoo(obj);
`.trimStart();

const LABELS: Label[] = [
  // Declarations (8 samples)
  { name: 'MAX',    line: 1,  kind: 'declaration' },
  { name: 'Foo',    line: 2,  kind: 'declaration' },
  { name: 'greet',  line: 4,  kind: 'declaration' },
  { name: 'name',   line: 4,  kind: 'declaration' },
  { name: 'main',   line: 8,  kind: 'declaration' },
  { name: 'count',  line: 9,  kind: 'declaration' },
  { name: 'obj',    line: 18, kind: 'declaration' },
  { name: 'useFoo', line: 21, kind: 'declaration' },

  // Reads (4 samples)
  { name: 'name',  line: 5,  kind: 'read' },
  { name: 'MAX',   line: 10, kind: 'read' },
  { name: 'obj',   line: 19, kind: 'read' }, // base of obj.a = 2 — only base is emitted
  { name: 'obj',   line: 20, kind: 'read' }, // RHS of `const alias: Foo = obj`

  // Writes (3 samples) — plain variable assignments and update-expressions only
  { name: 'count', line: 10, col: 2,  kind: 'write' }, // LHS of count = count + MAX
  { name: 'count', line: 13, col: 2,  kind: 'write' }, // count++ update_expression
  { name: 'score', line: 15, col: 2,  kind: 'write' }, // LHS of score = score + 1

  // Calls (3 samples)
  { name: 'greet',  line: 11, kind: 'call' },
  { name: 'greet',  line: 12, kind: 'call' },
  { name: 'useFoo', line: 22, kind: 'call' },

  // Type-refs (3 samples)
  { name: 'Foo', line: 18, kind: 'type-ref' }, // const obj: Foo
  { name: 'Foo', line: 20, kind: 'type-ref' }, // const alias: Foo
  { name: 'Foo', line: 21, kind: 'type-ref' }, // useFoo(f: Foo)
];

describe('ref_kind classification precision (labeled fixture)', () => {
  const occurrences = extractOccurrencesForTest(FIXTURE);

  /**
   * Look up the first occurrence matching (name, line), optionally
   * narrowed by col when the label disambiguates.
   */
  function lookup(label: Label) {
    return occurrences.find(o =>
      o.name === label.name &&
      o.line === label.line &&
      (label.col === undefined || o.col === label.col),
    );
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
    const hit = lookup(label);
    if (hit && hit.ref_kind === label.kind) {
      byKind[label.kind].correct += 1;
    }
  }

  it('call precision ≥ 95%', () => {
    const { total, correct } = byKind.call;
    expect(total).toBeGreaterThanOrEqual(3);
    expect(correct / total).toBeGreaterThanOrEqual(0.95);
  });

  it('read precision ≥ 90%', () => {
    const { total, correct } = byKind.read;
    expect(total).toBeGreaterThanOrEqual(3);
    expect(correct / total).toBeGreaterThanOrEqual(0.90);
  });

  it('write precision ≥ 90%', () => {
    const { total, correct } = byKind.write;
    expect(total).toBeGreaterThanOrEqual(3);
    expect(correct / total).toBeGreaterThanOrEqual(0.90);
  });

  it('type-ref precision ≥ 90%', () => {
    const { total, correct } = byKind['type-ref'];
    expect(total).toBeGreaterThanOrEqual(3);
    expect(correct / total).toBeGreaterThanOrEqual(0.90);
  });

  it('declaration precision ≥ 95%', () => {
    const { total, correct } = byKind.declaration;
    expect(total).toBeGreaterThanOrEqual(3);
    expect(correct / total).toBeGreaterThanOrEqual(0.95);
  });

  it('every labeled position has a matching occurrence', () => {
    const missing = LABELS.filter(l => !lookup(l));
    expect(missing).toEqual([]);
  });
});
