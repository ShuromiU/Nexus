import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { runIndex } from '../src/index/orchestrator.js';
import { QueryEngine } from '../src/query/engine.js';
import { getAdapter } from '../src/analysis/languages/registry.js';
import { getParser } from '../src/analysis/parser.js';

import '../src/analysis/languages/typescript.js';
import '../src/analysis/languages/csharp.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rel-cs-'));
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

function extractRelations(src: string) {
  const parser = getParser('csharp');
  const tree = parser.parse(src);
  const adapter = getAdapter('csharp')!;
  return adapter.extract(tree, src, 'X.cs').relations;
}

describe('B2 v2 — C# adapter relation extraction', () => {
  it('extracts extends_class as the first base entry of `class Dog : Animal {}`', () => {
    const r = extractRelations('public class Animal {}\npublic class Dog : Animal {}\n');
    const ext = r.filter(e => e.kind === 'extends_class');
    expect(ext).toHaveLength(1);
    expect(ext[0].target_name).toBe('Animal');
  });

  it('classifies subsequent base entries as implements', () => {
    const r = extractRelations(
      'public interface IBark {}\n' +
      'public interface IRun {}\n' +
      'public class Dog : Animal, IBark, IRun {}\n',
    );
    const impls = r.filter(e => e.kind === 'implements').map(e => e.target_name).sort();
    expect(impls).toEqual(['IBark', 'IRun']);
  });

  it('treats first base as implements when name follows IFoo convention', () => {
    // `class C : IFoo {}` — no base class, first entry is an interface by convention.
    const r = extractRelations('public interface IFoo {}\npublic class C : IFoo {}\n');
    const ext = r.filter(e => e.kind === 'extends_class');
    const impls = r.filter(e => e.kind === 'implements');
    expect(ext).toHaveLength(0);
    expect(impls).toHaveLength(1);
    expect(impls[0].target_name).toBe('IFoo');
  });

  it('extracts extends_interface for `interface I : J, K`', () => {
    const r = extractRelations(
      'public interface J {}\n' +
      'public interface K {}\n' +
      'public interface I : J, K {}\n',
    );
    const ext = r.filter(e => e.kind === 'extends_interface');
    expect(ext.map(e => e.target_name).sort()).toEqual(['J', 'K']);
  });

  it('strips generic argument list from target names', () => {
    const r = extractRelations(
      'public class Base<T> {}\n' +
      'public class Sub : Base<int> {}\n',
    );
    const ext = r.filter(e => e.kind === 'extends_class');
    expect(ext).toHaveLength(1);
    expect(ext[0].target_name).toBe('Base');
  });

  it('emits no relation rows for class with no base list', () => {
    const r = extractRelations('public class Plain {}\n');
    expect(r).toHaveLength(0);
  });
});

describe('B2 v2 — C# relations end-to-end (same-file resolution)', () => {
  it('children direction sees subclasses of a C# base', () => {
    write('Hier.cs',
      'public class Animal {}\n' +
      'public class Dog : Animal {}\n' +
      'public class Cat : Animal {}\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('Animal', { direction: 'children' });
      const inner = r.results[0];
      expect(inner.count).toBe(2);
      expect(inner.results.map(x => x.source.name).sort()).toEqual(['Cat', 'Dog']);
    } finally { close(); }
  });

  it('parents direction returns extends_class for a same-file C# subclass', () => {
    write('Hier.cs',
      'public class Animal {}\n' +
      'public class Dog : Animal {}\n',
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
    } finally { close(); }
  });

  it('returns implements edges for `class Dog : IBark` in the same file', () => {
    write('Mix.cs',
      'public interface IBark {}\n' +
      'public class Dog : IBark {}\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('Dog', { direction: 'parents' });
      const inner = r.results[0];
      const impl = inner.results.find(x => x.kind === 'implements');
      expect(impl).toBeDefined();
      expect(impl!.target.name).toBe('IBark');
      expect(impl!.target.resolved).toBe(true);
    } finally { close(); }
  });
});
