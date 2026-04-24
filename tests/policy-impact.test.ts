import { describe, it, expect } from 'vitest';
import { findSymbolAtEdit, bucketRisk } from '../src/policy/impact.js';
import type { OutlineForImpact } from '../src/policy/types.js';

const file = `export function foo() {\n  return 1;\n}\n\nfunction helper() {\n  return 2;\n}\n\nexport function bar() {\n  return foo();\n}\n`;

const outline: OutlineForImpact = {
  file: 'src/x.ts',
  exports: ['foo', 'bar'],
  outline: [
    { name: 'foo', kind: 'function', line: 1, end_line: 3 },
    { name: 'helper', kind: 'function', line: 5, end_line: 7 },
    { name: 'bar', kind: 'function', line: 9, end_line: 11 },
  ],
};

describe('findSymbolAtEdit', () => {
  it('returns the enclosing top-level exported symbol for a matched edit', () => {
    const match = findSymbolAtEdit(file, 'return 1;', outline);
    expect(match).not.toBeNull();
    expect(match!.name).toBe('foo');
    expect(match!.topLevel).toBe(true);
    expect(match!.exported).toBe(true);
  });

  it('returns null when old_string is not in file', () => {
    expect(findSymbolAtEdit(file, 'return 999;', outline)).toBeNull();
  });

  it('matches the first occurrence when old_string appears multiple times', () => {
    const dupFile = `export function foo() {\n  return 1;\n}\n\nexport function bar() {\n  return 1;\n}\n`;
    const dupOutline: OutlineForImpact = {
      file: 'src/x.ts',
      exports: ['foo', 'bar'],
      outline: [
        { name: 'foo', kind: 'function', line: 1, end_line: 3 },
        { name: 'bar', kind: 'function', line: 5, end_line: 7 },
      ],
    };
    const match = findSymbolAtEdit(dupFile, 'return 1;', dupOutline);
    expect(match!.name).toBe('foo');
  });

  it('returns null when the edit line is outside any top-level entry', () => {
    const fileWithBlank = `\n\n\nfoo();\n`;
    const outlineEmpty: OutlineForImpact = {
      file: 'src/x.ts',
      exports: [],
      outline: [{ name: 'foo', kind: 'function', line: 10, end_line: 20 }],
    };
    expect(findSymbolAtEdit(fileWithBlank, 'foo();', outlineEmpty)).toBeNull();
  });

  it('returns the outer top-level entry when edit is inside a nested child', () => {
    const nestedFile = `export function outer() {\n  function inner() {\n    return 1;\n  }\n  return inner();\n}\n`;
    const nestedOutline: OutlineForImpact = {
      file: 'src/x.ts',
      exports: ['outer'],
      outline: [
        {
          name: 'outer',
          kind: 'function',
          line: 1,
          end_line: 6,
          children: [
            { name: 'inner', kind: 'function', line: 2, end_line: 4 },
          ],
        },
      ],
    };
    const match = findSymbolAtEdit(nestedFile, 'return 1;', nestedOutline);
    expect(match!.name).toBe('outer');
    expect(match!.topLevel).toBe(true);
  });

  it('reports exported=false when the enclosing symbol is private', () => {
    const match = findSymbolAtEdit(file, 'return 2;', outline);
    expect(match!.name).toBe('helper');
    expect(match!.exported).toBe(false);
  });

  it('skips outline entries that lack end_line', () => {
    const weirdOutline: OutlineForImpact = {
      file: 'src/x.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1 }],
    };
    expect(findSymbolAtEdit(file, 'return 1;', weirdOutline)).toBeNull();
  });
});

describe('bucketRisk', () => {
  it('buckets 0 callers as low', () => {
    expect(bucketRisk(0)).toBe('low');
  });

  it('buckets 2 callers as low (upper edge)', () => {
    expect(bucketRisk(2)).toBe('low');
  });

  it('buckets 3 callers as medium (lower edge)', () => {
    expect(bucketRisk(3)).toBe('medium');
  });

  it('buckets 10 callers as medium (upper edge)', () => {
    expect(bucketRisk(10)).toBe('medium');
  });

  it('buckets 11 callers as high (lower edge)', () => {
    expect(bucketRisk(11)).toBe('high');
  });

  it('buckets 50 callers as high', () => {
    expect(bucketRisk(50)).toBe('high');
  });
});
