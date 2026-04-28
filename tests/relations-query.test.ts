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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rel-q-'));
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

describe('QueryEngine.relations (T9)', () => {
  it('parents direction returns what a class extends/implements', () => {
    write('a.ts',
      'export class Base {}\n' +
      'export interface IUser {}\n' +
      'export class U extends Base implements IUser {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('U', { direction: 'parents' });
      expect(r.results).toHaveLength(1);
      const inner = r.results[0];
      expect(inner.count).toBe(2);
      const kinds = inner.results.map(x => x.kind).sort();
      expect(kinds).toEqual(['extends_class', 'implements']);
    } finally { close(); }
  });

  it('children direction returns who extends/implements', () => {
    write('a.ts',
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
      expect(inner.results.every(x => x.kind === 'extends_class')).toBe(true);
    } finally { close(); }
  });

  it('kind filter narrows to one edge kind', () => {
    write('a.ts',
      'export class Base {}\n' +
      'export interface IUser {}\n' +
      'export class U extends Base implements IUser {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('U', { direction: 'parents', kind: 'implements' });
      const inner = r.results[0];
      expect(inner.count).toBe(1);
      expect(inner.results[0].kind).toBe('implements');
    } finally { close(); }
  });

  it('depth=2 transitively walks parent chain', () => {
    write('a.ts',
      'export class A {}\n' +
      'export class B extends A {}\n' +
      'export class C extends B {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('C', { direction: 'parents', depth: 2 });
      const inner = r.results[0];
      expect(inner.count).toBe(2);
      const targets = inner.results.map(x => x.target.name).sort();
      expect(targets).toEqual(['A', 'B']);
      const depths = inner.results.map(x => x.depth).sort();
      expect(depths).toEqual([1, 2]);
    } finally { close(); }
  });

  it('depth handles cycle without infinite loop', () => {
    write('a.ts',
      'export interface A extends B {}\n' +
      'export interface B extends A {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('A', { direction: 'parents', depth: 5 });
      const inner = r.results[0];
      // Walks A→B once, then visited-set blocks B→A.
      expect(inner.count).toBeLessThanOrEqual(2);
    } finally { close(); }
  });

  it('both direction unions parents and children', () => {
    write('a.ts',
      'export class Base {}\n' +
      'export class Mid extends Base {}\n' +
      'export class Sub extends Mid {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('Mid', { direction: 'both' });
      const inner = r.results[0];
      // parents: Mid → Base; children: Sub → Mid
      expect(inner.count).toBe(2);
    } finally { close(); }
  });

  it('unresolved target rendered with resolved=false', () => {
    write('a.ts', "import { Component } from 'react';\nexport class B extends Component {}\n");
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('B', { direction: 'parents' });
      const inner = r.results[0];
      expect(inner.count).toBe(1);
      expect(inner.results[0].target.resolved).toBe(false);
      expect(inner.results[0].target.name).toBe('Component');
      expect(inner.results[0].target.resolved_name).toBeUndefined();
    } finally { close(); }
  });

  it('resolved cross-file target carries file + line', () => {
    write('base.ts', 'export class Base {}\n');
    write('derived.ts', "import { Base } from './base';\nexport class B extends Base {}\n");
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('B', { direction: 'parents' });
      const inner = r.results[0];
      expect(inner.results[0].target.resolved).toBe(true);
      expect(inner.results[0].target.file).toBe('base.ts');
      expect(inner.results[0].target.line).toBe(1);
    } finally { close(); }
  });

  it('returns empty count when symbol has no relations', () => {
    write('a.ts', 'export class Lone {}\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('Lone', { direction: 'both' });
      expect(r.results[0].count).toBe(0);
    } finally { close(); }
  });

  it('result envelope advertises relations type + index_status', () => {
    write('a.ts', 'export class A {}\nexport class B extends A {}\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('B');
      expect(r.type).toBe('relations');
      expect(r.index_status).toBeDefined();
      expect(typeof r.timing_ms).toBe('number');
    } finally { close(); }
  });
});
