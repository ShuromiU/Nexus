import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { runIndex } from '../src/index/orchestrator.js';
import { QueryEngine } from '../src/query/engine.js';
import { getAdapter } from '../src/analysis/languages/registry.js';

import '../src/analysis/languages/typescript.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rel-js-'));
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

describe('B2 v1.5 — JS adapter relation edges', () => {
  it('JS adapter capabilities narrow relationKinds to extends_class only', () => {
    const ts = getAdapter('typescript');
    const js = getAdapter('javascript');
    expect(ts?.capabilities.relationKinds).toEqual([
      'extends_class',
      'implements',
      'extends_interface',
      'overrides_method',
    ]);
    expect(js?.capabilities.relationKinds).toEqual(['extends_class', 'overrides_method']);
  });

  it('extracts extends_class edges from a .js file (same-file)', () => {
    write('a.js',
      'export class Animal {}\n' +
      'export class Dog extends Animal {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('Dog', { direction: 'parents' });
      const inner = r.results[0];
      expect(inner.count).toBe(1);
      expect(inner.results[0].kind).toBe('extends_class');
      expect(inner.results[0].target.name).toBe('Animal');
      expect(inner.results[0].target.resolved).toBe(true);
      expect(inner.results[0].target.file).toBe('a.js');
    } finally { close(); }
  });

  it('extracts extends_class edges from a .jsx file', () => {
    write('Comp.jsx',
      'export class Base {}\n' +
      'export class Comp extends Base {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('Comp', { direction: 'parents' });
      expect(r.results[0].count).toBe(1);
      expect(r.results[0].results[0].kind).toBe('extends_class');
    } finally { close(); }
  });

  it('cross-file extends_class works from .js → .js via named import', () => {
    write('base.js', 'export class Base {}\n');
    write('derived.js',
      "import { Base } from './base.js';\n" +
      'export class Derived extends Base {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('Derived', { direction: 'parents' });
      const inner = r.results[0];
      expect(inner.count).toBe(1);
      expect(inner.results[0].target.name).toBe('Base');
      expect(inner.results[0].target.resolved).toBe(true);
      expect(inner.results[0].target.file).toBe('base.js');
    } finally { close(); }
  });

  it('JS does not produce implements or extends_interface edges (no such syntax)', () => {
    // A .js file with TS-only syntax would fail to parse, so this just
    // confirms the extractor never invents non-extends edges for JS.
    write('a.js',
      'export class Base {}\n' +
      'export class Sub extends Base {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('Sub', { direction: 'parents' });
      const kinds = r.results[0].results.map(x => x.kind);
      expect(kinds).toEqual(['extends_class']);
      expect(kinds).not.toContain('implements');
      expect(kinds).not.toContain('extends_interface');
    } finally { close(); }
  });

  it('mixed JS+TS: TS class extending a JS base class resolves cross-language', () => {
    write('base.js', 'export class Base {}\n');
    write('derived.ts',
      "import { Base } from './base.js';\n" +
      'export class Derived extends Base {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('Derived', { direction: 'parents' });
      const inner = r.results[0];
      expect(inner.count).toBe(1);
      expect(inner.results[0].target.name).toBe('Base');
      expect(inner.results[0].target.resolved).toBe(true);
      expect(inner.results[0].target.file).toBe('base.js');
    } finally { close(); }
  });

  it('children direction sees JS subclasses of a JS base', () => {
    write('a.js',
      'export class Base {}\n' +
      'export class A extends Base {}\n' +
      'export class B extends Base {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('Base', { direction: 'children' });
      const inner = r.results[0];
      expect(inner.count).toBe(2);
      const sources = inner.results.map(x => x.source.name).sort();
      expect(sources).toEqual(['A', 'B']);
    } finally { close(); }
  });
});
