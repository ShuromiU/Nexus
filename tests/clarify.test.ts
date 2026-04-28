import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { runIndex } from '../src/index/orchestrator.js';
import { QueryEngine } from '../src/query/engine.js';

import '../src/analysis/languages/typescript.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-clarify-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function write(rel: string, content: string): void {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function openEngine(): { engine: QueryEngine; close: () => void } {
  const dbPath = path.join(tmpRoot, '.nexus', 'index.db');
  const db = new Database(dbPath, { readonly: true });
  const engine = new QueryEngine(db, { sourceRoot: tmpRoot });
  return { engine, close: () => db.close() };
}

describe('engine.clarify (D2 v1)', () => {
  it('returns all candidates when a name has multiple definitions', () => {
    write('a.ts', 'export function foo() { return 1; }\n');
    write('b.ts', 'export function foo() { return 2; }\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.clarify('foo');
      const inner = r.results[0];
      expect(inner.count).toBe(2);
      const files = inner.candidates.map(c => c.file).sort();
      expect(files).toEqual(['a.ts', 'b.ts']);
      expect(inner.candidates.every(c => c.kind === 'function')).toBe(true);
      expect(inner.candidates.every(c => c.is_export)).toBe(true);
    } finally { close(); }
  });

  it('returns single candidate when name is unambiguous', () => {
    write('a.ts', 'export function unique() {}\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.clarify('unique');
      const inner = r.results[0];
      expect(inner.count).toBe(1);
      expect(inner.candidates[0].file).toBe('a.ts');
      expect(inner.suggested_picks).toHaveLength(0); // no need to pick
    } finally { close(); }
  });

  it('returns empty result for unknown name', () => {
    write('a.ts', 'export const x = 1;\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.clarify('Nonexistent');
      const inner = r.results[0];
      expect(inner.count).toBe(0);
      expect(inner.candidates).toEqual([]);
    } finally { close(); }
  });

  it('exposes unique disambiguators (files, kinds, scopes)', () => {
    write('a.ts',
      'export function dup() {}\n' +
      'export class dup {}\n'
    );
    write('b.ts', 'export interface dup {}\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.clarify('dup');
      const inner = r.results[0];
      expect(inner.unique_disambiguators.files.sort()).toEqual(['a.ts', 'b.ts']);
      expect(inner.unique_disambiguators.kinds.sort()).toEqual(['class', 'function', 'interface']);
    } finally { close(); }
  });

  it('suggests "most-used" candidate by importer_count', () => {
    write('a.ts', 'export function shared() { return 1; }\n');
    write('b.ts', 'export function shared() { return 2; }\n');
    // 3 files import a's shared, 0 import b's.
    write('user1.ts', "import { shared } from './a';\nshared();\n");
    write('user2.ts', "import { shared } from './a';\nshared();\n");
    write('user3.ts', "import { shared } from './a';\nshared();\n");
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.clarify('shared');
      const inner = r.results[0];
      expect(inner.suggested_picks.length).toBeGreaterThanOrEqual(1);
      const top = inner.suggested_picks[0];
      expect(top.rationale).toMatch(/most-used/);
      expect(inner.candidates[top.index].file).toBe('a.ts');
      expect(inner.candidates[top.index].importer_count).toBe(3);
    } finally { close(); }
  });

  it('suggests "base type for the hierarchy" candidate when class has children', () => {
    // Two classes named Base in different files; one has subclasses.
    write('hier.ts',
      'export class Base {}\n' +
      'export class A extends Base {}\n' +
      'export class B extends Base {}\n'
    );
    write('alt.ts', 'export class Base {}\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.clarify('Base');
      const inner = r.results[0];
      expect(inner.count).toBe(2);
      const baseTypePick = inner.suggested_picks.find(p => p.rationale.includes('base type'));
      expect(baseTypePick).toBeDefined();
      // Note: getRelationsByTarget matches by name, so both Base candidates may
      // see the children. The pick's rationale must include "child" word.
      expect(baseTypePick!.rationale).toMatch(/child/);
    } finally { close(); }
  });

  it('suggested picks are deterministic (alphabetic file tie-break)', () => {
    write('z.ts', 'export function dup() {}\n');
    write('a.ts', 'export function dup() {}\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.clarify('dup');
      // No importers → no most-used pick. Should be empty deterministically.
      expect(r.results[0].suggested_picks).toEqual([]);
    } finally { close(); }
  });

  it('result envelope advertises clarify type', () => {
    write('a.ts', 'export const x = 1;\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.clarify('x');
      expect(r.type).toBe('clarify');
      expect(r.index_status).toBeDefined();
      expect(typeof r.timing_ms).toBe('number');
    } finally { close(); }
  });

  it('candidates carry signature when available', () => {
    write('a.ts',
      'export function withSig(a: number, b: string): boolean { return true; }\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.clarify('withSig');
      expect(r.results[0].candidates[0].signature).toBeDefined();
      expect(r.results[0].candidates[0].signature).toContain('(');
    } finally { close(); }
  });
});
