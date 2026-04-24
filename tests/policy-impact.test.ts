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

describe('summarizeEditImpact', () => {
  it('includes symbol, file, risk bucket, importer count, caller count, and the nexus_callers hint', async () => {
    const { summarizeEditImpact, SUMMARY_MAX_CHARS } = await import('../src/policy/impact.js');
    const impact = {
      symbol: 'foo',
      file: 'src/bar.ts',
      importers: ['src/a.ts', 'src/b.ts'],
      importerCount: 2,
      callerCount: 6,
      risk: 'medium' as const,
    };
    const s = summarizeEditImpact(impact);
    expect(s).toMatch(/foo/);
    expect(s).toMatch(/src\/bar\.ts/);
    expect(s).toMatch(/medium/);
    expect(s).toMatch(/2 file/);
    expect(s).toMatch(/6 caller/);
    expect(s).toMatch(/nexus_callers/);
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it('omits importer examples when importerCount is 0', async () => {
    const { summarizeEditImpact } = await import('../src/policy/impact.js');
    const impact = {
      symbol: 'foo',
      file: 'src/bar.ts',
      importers: [],
      importerCount: 0,
      callerCount: 0,
      risk: 'low' as const,
    };
    const s = summarizeEditImpact(impact);
    expect(s).not.toMatch(/src\/a\.ts/);
  });

  it('adds "+N more" suffix when more than 3 importers', async () => {
    const { summarizeEditImpact } = await import('../src/policy/impact.js');
    const impact = {
      symbol: 'foo',
      file: 'src/bar.ts',
      importers: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
      importerCount: 5,
      callerCount: 0,
      risk: 'low' as const,
    };
    const s = summarizeEditImpact(impact);
    expect(s).toMatch(/\+2 more/);
  });

  it('caps total length at SUMMARY_MAX_CHARS', async () => {
    const { summarizeEditImpact, SUMMARY_MAX_CHARS } = await import('../src/policy/impact.js');
    const impact = {
      symbol: 'averyverylongsymbolname',
      file: 'src/path/to/some/deeply/nested/module/file.ts',
      importers: Array.from({ length: 100 }, (_, i) => `src/importer-number-${i}.ts`),
      importerCount: 100,
      callerCount: 200,
      risk: 'high' as const,
    };
    const s = summarizeEditImpact(impact);
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });
});

describe('summarizeWriteImpact', () => {
  it('lists multi-symbol rewrite with max risk and top callers', async () => {
    const { summarizeWriteImpact, SUMMARY_MAX_CHARS } = await import('../src/policy/impact.js');
    const impact = {
      file: 'src/bar.ts',
      importers: ['src/a.ts'],
      importerCount: 1,
      affectedSymbols: [
        { name: 'foo', callerCount: 6, risk: 'medium' as const },
        { name: 'bar', callerCount: 2, risk: 'low' as const },
        { name: 'baz', callerCount: 14, risk: 'high' as const },
      ],
      risk: 'high' as const,
    };
    const s = summarizeWriteImpact(impact);
    expect(s).toMatch(/src\/bar\.ts/);
    expect(s).toMatch(/3 exported/);
    expect(s).toMatch(/high/);
    expect(s).toMatch(/baz/);
    expect(s).toMatch(/14/);
    expect(s).toMatch(/nexus_callers/);
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it('truncates top-N affected symbols to at most 3', async () => {
    const { summarizeWriteImpact } = await import('../src/policy/impact.js');
    const impact = {
      file: 'src/bar.ts',
      importers: [],
      importerCount: 1,
      affectedSymbols: [
        { name: 's1', callerCount: 10, risk: 'medium' as const },
        { name: 's2', callerCount: 8, risk: 'medium' as const },
        { name: 's3', callerCount: 6, risk: 'medium' as const },
        { name: 's4', callerCount: 4, risk: 'medium' as const },
        { name: 's5', callerCount: 2, risk: 'low' as const },
      ],
      risk: 'medium' as const,
    };
    const s = summarizeWriteImpact(impact);
    expect(s).toMatch(/s1/);
    expect(s).toMatch(/s2/);
    expect(s).toMatch(/s3/);
    expect(s).not.toMatch(/s4/);
    expect(s).not.toMatch(/s5/);
  });
});
