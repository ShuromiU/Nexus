import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { QueryEngine } from '../src/query/engine.js';
import { resetDocumentCache } from '../src/analysis/documents/cache.js';

let tmpRoot: string;
let db: Database.Database;
let engine: QueryEngine;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-a3-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, tmpRoot, true);
  engine = new QueryEngine(db);
  resetDocumentCache();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  resetDocumentCache();
});

function write(rel: string, content: string): string {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return rel;
}

describe('structuredQuery', () => {
  it('reads a scalar from package.json', () => {
    const rel = write('package.json', JSON.stringify({ name: 'foo', version: '1.2.3' }));
    const r = engine.structuredQuery(rel, 'version');
    expect(r.count).toBe(1);
    expect(r.results[0]).toMatchObject({
      file: rel, path: 'version', kind: 'package_json', found: true, value: '1.2.3',
    });
  });

  it('walks into nested object keys', () => {
    const rel = write('package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
    const r = engine.structuredQuery(rel, 'scripts.test');
    expect(r.results[0].value).toBe('vitest');
  });

  it('indexes into arrays with numeric segments', () => {
    const rel = write('.github/workflows/ci.yml',
      `name: CI
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
      - run: echo b
`);
    const r = engine.structuredQuery(rel, 'jobs.test.steps.1.run');
    expect(r.results[0].value).toBe('echo b');
  });

  it('returns found:false when the path does not resolve', () => {
    const rel = write('package.json', JSON.stringify({ name: 'foo' }));
    const r = engine.structuredQuery(rel, 'missing.key');
    expect(r.results[0]).toMatchObject({ found: false });
    expect(r.results[0].value).toBeUndefined();
  });

  it('works on tsconfig.json (JSONC)', () => {
    const rel = write('tsconfig.json', `{
      // comment
      "compilerOptions": { "strict": true, },
    }`);
    const r = engine.structuredQuery(rel, 'compilerOptions.strict');
    expect(r.results[0].value).toBe(true);
  });

  it('works on Cargo.toml', () => {
    const rel = write('Cargo.toml', '[package]\nname = "x"\nversion = "0.1.0"\n');
    const r = engine.structuredQuery(rel, 'package.name');
    expect(r.results[0].value).toBe('x');
  });

  it('works on generic JSON/YAML/TOML (P1)', () => {
    const relJson = write('data.json', JSON.stringify({ k: [1, 2, 3] }));
    expect(engine.structuredQuery(relJson, 'k.2').results[0].value).toBe(3);
    const relYaml = write('data.yml', 'a:\n  b: hi\n');
    expect(engine.structuredQuery(relYaml, 'a.b').results[0].value).toBe('hi');
    const relToml = write('data.toml', '[x]\nk = 1\n');
    expect(engine.structuredQuery(relToml, 'x.k').results[0].value).toBe(1);
  });

  it('returns an error result on unsupported file kind (source file)', () => {
    const rel = write('index.ts', 'export const x = 1;\n');
    const r = engine.structuredQuery(rel, 'x');
    expect(r.results[0].found).toBe(false);
    expect(r.results[0].error).toMatch(/not a structured/);
  });

  it('propagates loader errors (missing file)', () => {
    const r = engine.structuredQuery('no-such.json', 'x');
    expect(r.results[0].found).toBe(false);
    expect(r.results[0].error).toBeDefined();
  });

  it('propagates loader errors (file_too_large)', () => {
    const rel = write('package.json', 'x'.repeat(1_048_577));
    const r = engine.structuredQuery(rel, 'name');
    expect(r.results[0].error).toBe('file_too_large');
  });
});

describe('structuredOutline', () => {
  it('lists top-level keys of package.json with value kinds', () => {
    const rel = write('package.json', JSON.stringify({
      name: 'foo', version: '1.0.0', dependencies: { a: '1' }, workspaces: ['x'],
    }));
    const r = engine.structuredOutline(rel);
    expect(r.count).toBe(1);
    const entries = r.results[0].entries;
    expect(entries).toContainEqual(expect.objectContaining({ key: 'name', value_kind: 'string' }));
    expect(entries).toContainEqual(expect.objectContaining({ key: 'dependencies', value_kind: 'object' }));
    expect(entries).toContainEqual(expect.objectContaining({
      key: 'workspaces', value_kind: 'array', length: 1,
    }));
  });

  it('includes a short preview for scalar values', () => {
    const rel = write('package.json', JSON.stringify({ name: 'my-pkg', version: '1.2.3' }));
    const r = engine.structuredOutline(rel);
    const nameEntry = r.results[0].entries.find(e => e.key === 'name');
    expect(nameEntry?.preview).toBe('"my-pkg"');
  });

  it('outlines a GHA workflow', () => {
    const rel = write('.github/workflows/ci.yml', 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n');
    const r = engine.structuredOutline(rel);
    const keys = r.results[0].entries.map(e => e.key);
    expect(keys).toEqual(expect.arrayContaining(['name', 'on', 'jobs']));
  });

  it('outlines generic JSON/YAML/TOML', () => {
    const relJson = write('data.json', JSON.stringify({ a: 1, b: [2, 3] }));
    expect(engine.structuredOutline(relJson).results[0].entries.length).toBe(2);
    const relYaml = write('data.yml', 'a: 1\nb:\n  - 2\n  - 3\n');
    expect(engine.structuredOutline(relYaml).results[0].entries.length).toBe(2);
    const relToml = write('data.toml', 'a = 1\n[b]\nk = 2\n');
    expect(engine.structuredOutline(relToml).results[0].entries.length).toBe(2);
  });

  it('returns error entries when the file is not structured', () => {
    const rel = write('index.ts', 'export const x = 1;\n');
    const r = engine.structuredOutline(rel);
    expect(r.results[0].error).toBeDefined();
  });

  it('returns error when the file is missing', () => {
    const r = engine.structuredOutline('no-such.json');
    expect(r.results[0].error).toBeDefined();
  });
});
