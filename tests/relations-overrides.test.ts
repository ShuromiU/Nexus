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

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rel-ovr-'));
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
  const parser = getParser('typescript');
  const tree = parser.parse(src);
  const adapter = getAdapter('typescript')!;
  return adapter.extract(tree, src, 'X.ts').relations;
}

describe('B2 v2 — overrides_method extractor', () => {
  it('emits one overrides_method edge per method when class extends a parent', () => {
    const r = extractRelations(
      'class Base {}\n' +
      'class Sub extends Base {\n' +
      '  bark() {}\n' +
      '  walk() {}\n' +
      '}\n',
    );
    const overrides = r.filter(e => e.kind === 'overrides_method');
    expect(overrides).toHaveLength(2);
    const names = overrides.map(e => e.target_name).sort();
    expect(names).toEqual(['Base.bark', 'Base.walk']);
    for (const o of overrides) {
      expect(o.confidence).toBe('declared');
    }
  });

  it('skips constructors', () => {
    const r = extractRelations(
      'class Base {}\n' +
      'class Sub extends Base {\n' +
      '  constructor() { super(); }\n' +
      '  step() {}\n' +
      '}\n',
    );
    const overrides = r.filter(e => e.kind === 'overrides_method');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].target_name).toBe('Base.step');
  });

  it('skips private (#) methods', () => {
    const r = extractRelations(
      'class Base {}\n' +
      'class Sub extends Base {\n' +
      '  #secret() {}\n' +
      '  open() {}\n' +
      '}\n',
    );
    const overrides = r.filter(e => e.kind === 'overrides_method');
    expect(overrides.map(o => o.target_name)).toEqual(['Base.open']);
  });

  it('emits no overrides_method when class has no extends clause', () => {
    const r = extractRelations(
      'class Standalone {\n' +
      '  hop() {}\n' +
      '}\n',
    );
    const overrides = r.filter(e => e.kind === 'overrides_method');
    expect(overrides).toHaveLength(0);
  });

  it('source_symbol_index points at the method symbol (not the class)', () => {
    const src =
      'class Base {}\n' +
      'class Sub extends Base {\n' +
      '  step() {}\n' +
      '}\n';
    const parser = getParser('typescript');
    const tree = parser.parse(src);
    const adapter = getAdapter('typescript')!;
    const result = adapter.extract(tree, src, 'X.ts');
    const ovr = result.relations.find(e => e.kind === 'overrides_method')!;
    expect(ovr).toBeDefined();
    const sourceSym = result.symbols[ovr.source_symbol_index];
    expect(sourceSym.kind).toBe('method');
    expect(sourceSym.name).toBe('step');
    expect(sourceSym.scope).toBe('Sub');
  });
});

describe('B2 v2 — overrides_method end-to-end (same-file)', () => {
  it('resolves overrides_method to the parent class method symbol', () => {
    write('a.ts',
      'export class Base {\n' +
      '  bark() {}\n' +
      '}\n' +
      'export class Sub extends Base {\n' +
      '  bark() {}\n' +
      '}\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('bark', { direction: 'parents', kind: 'overrides_method' });
      const inner = r.results[0];
      // Both `Sub.bark` and `Base.bark` share the name 'bark'; only Sub's
      // method declares an overrides_method edge.
      expect(inner.count).toBeGreaterThanOrEqual(1);
      const ovr = inner.results.find(x => x.kind === 'overrides_method');
      expect(ovr).toBeDefined();
      // target.name is the encoded compound key as emitted by the extractor.
      expect(ovr!.target.name).toBe('Base.bark');
      expect(ovr!.target.resolved).toBe(true);
      // target.resolved_name is the joined target symbol's actual name.
      expect(ovr!.target.resolved_name).toBe('bark');
      expect(ovr!.target.file).toBe('a.ts');
    } finally { close(); }
  });

  it('children direction lists overriding methods of a base method', () => {
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
      const r = engine.relations('step', { direction: 'children', kind: 'overrides_method' });
      const inner = r.results[0];
      const ovr = inner.results.find(x => x.kind === 'overrides_method');
      expect(ovr).toBeDefined();
      expect(ovr!.source.name).toBe('step');
    } finally { close(); }
  });

  it('leaves target.resolved=false when parent class is unknown', () => {
    write('a.ts',
      'export class Sub extends ExternalThing {\n' +
      '  step() {}\n' +
      '}\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('step', { direction: 'parents', kind: 'overrides_method' });
      const inner = r.results[0];
      const ovr = inner.results.find(x => x.kind === 'overrides_method');
      expect(ovr).toBeDefined();
      expect(ovr!.target.resolved).toBe(false);
      expect(ovr!.target.name).toBe('ExternalThing.step');
    } finally { close(); }
  });
});

describe('B2 v2 — overrides_method end-to-end (cross-file)', () => {
  it('resolves a subclass method override against an imported base class', () => {
    write('base.ts',
      'export class Base {\n' +
      '  step() {}\n' +
      '}\n',
    );
    write('sub.ts',
      "import { Base } from './base.js';\n" +
      'export class Sub extends Base {\n' +
      '  step() {}\n' +
      '}\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('step', { direction: 'parents', kind: 'overrides_method' });
      const inner = r.results[0];
      const ovr = inner.results.find(x =>
        x.kind === 'overrides_method' && x.source.name === 'step' && x.target.file === 'base.ts',
      );
      expect(ovr).toBeDefined();
      expect(ovr!.target.resolved).toBe(true);
      expect(ovr!.target.resolved_name).toBe('step');
    } finally { close(); }
  });

  it('honors `import { Foo as Bar }` aliasing when resolving overrides', () => {
    write('base.ts',
      'export class Base {\n' +
      '  step() {}\n' +
      '}\n',
    );
    write('sub.ts',
      "import { Base as Parent } from './base.js';\n" +
      'export class Sub extends Parent {\n' +
      '  step() {}\n' +
      '}\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('step', { direction: 'parents', kind: 'overrides_method' });
      const inner = r.results[0];
      const ovr = inner.results.find(x =>
        x.kind === 'overrides_method' && x.target.file === 'base.ts',
      );
      expect(ovr).toBeDefined();
      expect(ovr!.target.resolved).toBe(true);
    } finally { close(); }
  });
});

describe('B2 v2 — JS overrides_method', () => {
  it('emits overrides_method edges from .js files', async () => {
    await import('../src/analysis/languages/typescript.js'); // also registers JS
    write('a.js',
      'export class Base {\n' +
      '  bark() {}\n' +
      '}\n' +
      'export class Sub extends Base {\n' +
      '  bark() {}\n' +
      '}\n',
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.relations('bark', { direction: 'parents', kind: 'overrides_method' });
      const inner = r.results[0];
      const ovr = inner.results.find(x => x.kind === 'overrides_method');
      expect(ovr).toBeDefined();
      expect(ovr!.target.resolved).toBe(true);
      expect(ovr!.target.file).toBe('a.js');
    } finally { close(); }
  });
});
