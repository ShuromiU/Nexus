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
import '../src/analysis/languages/java.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rel-java-'));
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
  const parser = getParser('java');
  const tree = parser.parse(src);
  const adapter = getAdapter('java')!;
  return adapter.extract(tree, src, 'X.java').relations;
}

describe('B2 v2 — Java adapter relation extraction', () => {
  it('extracts extends_class from `class Dog extends Animal {}`', () => {
    const r = extractRelations(
      'public class Animal {}\n' +
      'public class Dog extends Animal {}\n',
    );
    const extendsEdges = r.filter(e => e.kind === 'extends_class');
    expect(extendsEdges).toHaveLength(1);
    expect(extendsEdges[0].target_name).toBe('Animal');
    expect(extendsEdges[0].confidence).toBe('declared');
  });

  it('extracts implements edges (single + multiple)', () => {
    const r = extractRelations(
      'public interface IBark {}\n' +
      'public interface IRun {}\n' +
      'public class Dog implements IBark, IRun {}\n',
    );
    const impls = r.filter(e => e.kind === 'implements');
    expect(impls).toHaveLength(2);
    const names = impls.map(e => e.target_name).sort();
    expect(names).toEqual(['IBark', 'IRun']);
  });

  it('extracts extends_interface for `interface I extends J, K`', () => {
    const r = extractRelations(
      'public interface J {}\n' +
      'public interface K {}\n' +
      'public interface I extends J, K {}\n',
    );
    const extendsI = r.filter(e => e.kind === 'extends_interface');
    expect(extendsI).toHaveLength(2);
    expect(extendsI.map(e => e.target_name).sort()).toEqual(['J', 'K']);
  });

  it('strips generic type parameters from extends target', () => {
    const r = extractRelations(
      'public class Base<T> {}\n' +
      'public class Sub extends Base<String> {}\n',
    );
    const extendsEdges = r.filter(e => e.kind === 'extends_class');
    expect(extendsEdges).toHaveLength(1);
    expect(extendsEdges[0].target_name).toBe('Base');
  });

  it('emits no relation rows for class with no inheritance', () => {
    const r = extractRelations('public class Plain {}\n');
    expect(r).toHaveLength(0);
  });
});

describe('B2 v2 — Java relations end-to-end (same-file resolution)', () => {
  it('children direction sees subclasses of a Java base in the same file', () => {
    write('Hier.java',
      'public class Animal {}\n' +
      'class Dog extends Animal {}\n' +
      'class Cat extends Animal {}\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('Animal', { direction: 'children' });
      const inner = r.results[0];
      expect(inner.count).toBe(2);
      const sources = inner.results.map(x => x.source.name).sort();
      expect(sources).toEqual(['Cat', 'Dog']);
    } finally { close(); }
  });

  it('parents direction returns extends_class for a same-file Java subclass', () => {
    write('Hier.java',
      'public class Animal {}\n' +
      'class Dog extends Animal {}\n',
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

  it('returns implements edges when a Java class implements interfaces in the same file', () => {
    write('Mix.java',
      'public interface IBark {}\n' +
      'public class Dog implements IBark {}\n',
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
