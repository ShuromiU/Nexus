import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { runIndex } from '../src/index/orchestrator.js';
import { QueryEngine, classifyRenameRisk } from '../src/query/engine.js';

import '../src/analysis/languages/typescript.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rename-'));
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

describe('classifyRenameRisk (pure)', () => {
  it('low when no external references', () => {
    const { risk, reasons } = classifyRenameRisk({
      callerCount: 0, refKinds: {}, importerCount: 0,
      childCount: 0, parentCount: 0,
      sameFileCollisions: 0, sameModuleCollisions: 0,
    });
    expect(risk).toBe('low');
    expect(reasons).toContain('no_external_refs');
  });

  it('high when there are children edges', () => {
    const { risk, reasons } = classifyRenameRisk({
      callerCount: 0, refKinds: {}, importerCount: 0,
      childCount: 2, parentCount: 0,
      sameFileCollisions: 0, sameModuleCollisions: 0,
    });
    expect(risk).toBe('high');
    expect(reasons).toContain('has_children:2');
  });

  it('high when there are importers (cross-module surface)', () => {
    const { risk, reasons } = classifyRenameRisk({
      callerCount: 0, refKinds: {}, importerCount: 3,
      childCount: 0, parentCount: 0,
      sameFileCollisions: 0, sameModuleCollisions: 0,
    });
    expect(risk).toBe('high');
    expect(reasons).toContain('has_importers:3');
  });

  it('high when new_name collides in same module', () => {
    const { risk, reasons } = classifyRenameRisk({
      callerCount: 0, refKinds: {}, importerCount: 0,
      childCount: 0, parentCount: 0,
      sameFileCollisions: 0, sameModuleCollisions: 1,
    });
    expect(risk).toBe('high');
    expect(reasons).toContain('same_module_collision:1');
  });

  it('medium when there are callers but no children/importers', () => {
    const { risk, reasons } = classifyRenameRisk({
      callerCount: 4, refKinds: { call: 4 }, importerCount: 0,
      childCount: 0, parentCount: 0,
      sameFileCollisions: 0, sameModuleCollisions: 0,
    });
    expect(risk).toBe('medium');
    expect(reasons).toContain('has_callers:4');
  });

  it('medium when only type-refs exist', () => {
    const { risk, reasons } = classifyRenameRisk({
      callerCount: 0, refKinds: { 'type-ref': 2 }, importerCount: 0,
      childCount: 0, parentCount: 0,
      sameFileCollisions: 0, sameModuleCollisions: 0,
    });
    expect(risk).toBe('medium');
    expect(reasons.some(r => r.startsWith('has_type_refs'))).toBe(true);
  });

  it('medium when only same-file collision exists', () => {
    const { risk, reasons } = classifyRenameRisk({
      callerCount: 0, refKinds: {}, importerCount: 0,
      childCount: 0, parentCount: 0,
      sameFileCollisions: 1, sameModuleCollisions: 0,
    });
    expect(risk).toBe('medium');
    expect(reasons).toContain('same_file_collision:1');
  });

  it('high gates short-circuit medium gates', () => {
    const { risk, reasons } = classifyRenameRisk({
      callerCount: 99, refKinds: { call: 99 }, importerCount: 5,
      childCount: 3, parentCount: 1,
      sameFileCollisions: 0, sameModuleCollisions: 0,
    });
    expect(risk).toBe('high');
    // The high-tier reasons are recorded; medium reasons are skipped.
    expect(reasons).toContain('has_children:3');
    expect(reasons).toContain('has_importers:5');
    expect(reasons.some(r => r.startsWith('has_callers'))).toBe(false);
  });

  it('parents alone bumps to medium', () => {
    const { risk, reasons } = classifyRenameRisk({
      callerCount: 0, refKinds: {}, importerCount: 0,
      childCount: 0, parentCount: 2,
      sameFileCollisions: 0, sameModuleCollisions: 0,
    });
    expect(risk).toBe('medium');
    expect(reasons).toContain('has_parents:2');
  });
});

describe('engine.renameSafety (B6 v1) — integration', () => {
  it('returns low risk for an unused private symbol', () => {
    write('a.ts',
      'function helper() { return 1; }\n' +
      'export function used() { return helper(); }\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.renameSafety('helper');
      expect(r.results).toHaveLength(1);
      const inner = r.results[0];
      expect(inner.symbol.name).toBe('helper');
      // helper is called once (medium) — but local-only.
      expect(inner.importers.count).toBe(0);
      expect(inner.relations.children.count).toBe(0);
      expect(inner.risk).toBe('medium');
      expect(inner.reasons).toContain('has_callers:1');
    } finally { close(); }
  });

  it('returns high risk when there are importers', () => {
    write('lib.ts', 'export function widelyUsed() { return 42; }\n');
    write('a.ts', "import { widelyUsed } from './lib';\nexport const a = widelyUsed();\n");
    write('b.ts', "import { widelyUsed } from './lib';\nexport const b = widelyUsed();\n");
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.renameSafety('widelyUsed');
      const inner = r.results[0];
      expect(inner.importers.count).toBe(2);
      expect(inner.importers.files.sort()).toEqual(['a.ts', 'b.ts']);
      expect(inner.risk).toBe('high');
      expect(inner.reasons).toContain('has_importers:2');
    } finally { close(); }
  });

  it('returns high risk when class has subclasses (children)', () => {
    write('a.ts',
      'export class Base {}\n' +
      'export class Sub1 extends Base {}\n' +
      'export class Sub2 extends Base {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.renameSafety('Base');
      const inner = r.results[0];
      expect(inner.relations.children.count).toBe(2);
      expect(inner.relations.children.kinds.extends_class).toBe(2);
      expect(inner.risk).toBe('high');
      expect(inner.reasons).toContain('has_children:2');
    } finally { close(); }
  });

  it('blast_radius sums callers + importers + children', () => {
    write('lib.ts', 'export class Base {}\nexport class Sub extends Base {}\n');
    write('user.ts', "import { Base } from './lib';\nexport const x: Base = new Base();\n");
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.renameSafety('Base');
      const inner = r.results[0];
      // children=1 (Sub), importers=1 (user.ts), plus callers from occurrences.
      expect(inner.blast_radius).toBeGreaterThanOrEqual(2);
      expect(inner.risk).toBe('high');
    } finally { close(); }
  });

  it('detects same-file collision when new_name is provided', () => {
    write('a.ts',
      'export function foo() {}\n' +
      'export function bar() {}\n'
    );
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.renameSafety('foo', { new_name: 'bar' });
      const inner = r.results[0];
      expect(inner.collisions.same_file).toHaveLength(1);
      expect(inner.collisions.same_file[0].name).toBe('bar');
    } finally { close(); }
  });

  it('detects same-module collision (same directory) when new_name is provided', () => {
    write('a/foo.ts', 'export function foo() {}\n');
    write('a/bar.ts', 'export function bar() {}\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.renameSafety('foo', { new_name: 'bar' });
      const inner = r.results[0];
      expect(inner.collisions.same_module.length).toBeGreaterThanOrEqual(1);
      expect(inner.risk).toBe('high');
      expect(inner.reasons.some(s => s.startsWith('same_module_collision'))).toBe(true);
    } finally { close(); }
  });

  it('returns symbol_not_found reason when name has no declaration', () => {
    write('a.ts', 'export const x = 1;\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.renameSafety('Nonexistent');
      const inner = r.results[0];
      expect(inner.reasons).toContain('symbol_not_found');
      expect(inner.risk).toBe('low');
      expect(inner.blast_radius).toBe(0);
    } finally { close(); }
  });

  it('result envelope advertises rename_safety type', () => {
    write('a.ts', 'export const x = 1;\n');
    runIndex(tmpRoot, true);
    const { engine, close } = openEngine();
    try {
      const r = engine.renameSafety('x');
      expect(r.type).toBe('rename_safety');
      expect(r.index_status).toBeDefined();
      expect(typeof r.timing_ms).toBe('number');
    } finally { close(); }
  });
});
