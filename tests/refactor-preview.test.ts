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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-refpreview-'));
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

describe('engine.refactorPreview (B6 v2)', () => {
  it('result envelope advertises refactor_preview type', () => {
    write('a.ts', 'export function isolated() { return 1; }\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.refactorPreview('isolated');
      expect(r.type).toBe('refactor_preview');
      expect(typeof r.timing_ms).toBe('number');
      expect(r.index_status).toBeDefined();
    } finally { close(); }
  });

  it('returns symbol_not_found reason and empty edits for unknown symbol', () => {
    write('a.ts', 'export const x = 1;\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.refactorPreview('Nonexistent');
      const inner = r.results[0];
      expect(inner.reasons).toContain('symbol_not_found');
      expect(inner.edits_total).toBe(0);
      expect(inner.files_affected).toBe(0);
      expect(inner.by_file).toEqual([]);
    } finally { close(); }
  });

  it('emits a single definition edit for an isolated, unreferenced symbol', () => {
    write('a.ts', 'export function isolated() { return 1; }\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.refactorPreview('isolated');
      const inner = r.results[0];
      expect(inner.files_affected).toBe(1);
      expect(inner.edits_total).toBe(1);
      const def = inner.by_file[0].edits[0];
      expect(def.role).toBe('definition');
      expect(def.line).toBeGreaterThan(0);
      expect(inner.risk).toBe('low');
    } finally { close(); }
  });

  it('aggregates importer + caller edits across multiple files', () => {
    write('a.ts', 'export function shared() { return 1; }\n');
    write('user1.ts',
      "import { shared } from './a.js';\n" +
      'export function consume1() { return shared() + 1; }\n',
    );
    write('user2.ts',
      "import { shared } from './a.js';\n" +
      'export function consume2() { return shared() + 2; }\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.refactorPreview('shared');
      const inner = r.results[0];
      const filesByPath = Object.fromEntries(inner.by_file.map(f => [f.file, f]));
      expect(filesByPath['a.ts'].edits.find(e => e.role === 'definition')).toBeDefined();
      // Each user file has at least one importer + one caller edit.
      for (const u of ['user1.ts', 'user2.ts']) {
        expect(filesByPath[u]).toBeDefined();
        expect(filesByPath[u].kinds).toContain('importer');
        expect(filesByPath[u].kinds).toContain('caller');
      }
      expect(inner.files_affected).toBe(3);
    } finally { close(); }
  });

  it('flags subclass edits when the symbol is a base class', () => {
    write('hier.ts',
      'export class Base {}\n' +
      'export class A extends Base {}\n' +
      'export class B extends Base {}\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.refactorPreview('Base');
      const inner = r.results[0];
      const subclassEdits = inner.by_file
        .flatMap(f => f.edits)
        .filter(e => e.role === 'subclass');
      expect(subclassEdits.length).toBeGreaterThanOrEqual(2);
      // Subclass children gate forces high risk.
      expect(inner.risk).toBe('high');
    } finally { close(); }
  });

  it('flags override edits for a method overridden in a subclass', () => {
    write('a.ts',
      'export class Base {\n' +
      '  step() {}\n' +
      '}\n' +
      'export class Sub extends Base {\n' +
      '  step() {}\n' +
      '}\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      // Preview renaming the *base* method — should reach the override site.
      const r = engine.refactorPreview('step', { file: 'a.ts' });
      const inner = r.results[0];
      const overrideEdits = inner.by_file
        .flatMap(f => f.edits)
        .filter(e => e.role === 'override');
      expect(overrideEdits.length).toBeGreaterThanOrEqual(1);
    } finally { close(); }
  });

  it('returns same risk verdict as renameSafety', () => {
    write('a.ts', 'export function only() { return 1; }\n');
    write('user.ts',
      "import { only } from './a.js';\n" +
      'only();\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const preview = engine.refactorPreview('only').results[0];
      const safety = engine.renameSafety('only').results[0];
      expect(preview.risk).toBe(safety.risk);
      expect(preview.blast_radius).toBe(safety.blast_radius);
    } finally { close(); }
  });

  it('detects collisions when new_name is supplied', () => {
    write('a.ts',
      'export function alpha() {}\n' +
      'export function beta() {}\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.refactorPreview('alpha', { new_name: 'beta' });
      const inner = r.results[0];
      expect(inner.collisions.same_file).toHaveLength(1);
      expect(inner.collisions.same_file[0].name).toBe('beta');
    } finally { close(); }
  });

  it('orders by_file alphabetically and edits within a file by line', () => {
    write('z.ts', "import { target } from './core.js';\ntarget();\n");
    write('a.ts', "import { target } from './core.js';\ntarget();\ntarget();\n");
    write('core.ts', 'export function target() {}\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.refactorPreview('target');
      const inner = r.results[0];
      const paths = inner.by_file.map(f => f.file);
      expect(paths).toEqual([...paths].sort());
      for (const f of inner.by_file) {
        const lines = f.edits.map(e => e.line);
        expect(lines).toEqual([...lines].sort((a, b) => a - b));
      }
    } finally { close(); }
  });

  it('respects the file disambiguator when a name has multiple definitions', () => {
    write('a.ts', 'export function dup() { return 1; }\n');
    write('b.ts', 'export function dup() { return 2; }\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const ra = engine.refactorPreview('dup', { file: 'a.ts' });
      const rb = engine.refactorPreview('dup', { file: 'b.ts' });
      expect(ra.results[0].symbol.file).toBe('a.ts');
      expect(rb.results[0].symbol.file).toBe('b.ts');
    } finally { close(); }
  });

  it('definition edit always lives in the symbol\'s own file', () => {
    write('a.ts', 'export function lonely() {}\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.refactorPreview('lonely');
      const inner = r.results[0];
      const ownFile = inner.by_file.find(f => f.file === inner.symbol.file);
      expect(ownFile).toBeDefined();
      expect(ownFile!.edits[0].role).toBe('definition');
    } finally { close(); }
  });
});
