import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadPackageJson, loadTsconfig, loadGenericJson,
  loadGhaWorkflow, loadGenericYaml, loadCargoToml, loadGenericToml,
} from '../src/analysis/documents/loaders.js';
import { resetDocumentCache } from '../src/analysis/documents/cache.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-a2-'));
  resetDocumentCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetDocumentCache();
});

function write(name: string, content: string | Buffer): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('loadPackageJson', () => {
  it('reads, parses, and returns a typed result', () => {
    const p = write('package.json', JSON.stringify({ name: 'foo', version: '1.0.0' }));
    const r = loadPackageJson(p);
    if ('error' in r) throw new Error(r.error);
    expect(r.name).toBe('foo');
    expect(r.version).toBe('1.0.0');
  });

  it('returns file_too_large when file exceeds the 1 MB cap', () => {
    const big = 'x'.repeat(1_048_577);
    const p = write('package.json', big);
    const r = loadPackageJson(p);
    expect(r).toEqual({
      error: 'file_too_large',
      limit: 1_048_576,
      actual: 1_048_577,
    });
  });

  it('returns { error } when the file is missing', () => {
    const p = path.join(tmpDir, 'missing.json');
    const r = loadPackageJson(p);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).not.toBe('file_too_large');
  });

  it('returns { error } when the file is malformed JSON', () => {
    const p = write('package.json', '{ not valid');
    const r = loadPackageJson(p);
    expect('error' in r).toBe(true);
  });

  it('caches parsed results — second call returns the same reference', () => {
    const p = write('package.json', JSON.stringify({ name: 'foo' }));
    const r1 = loadPackageJson(p);
    const r2 = loadPackageJson(p);
    expect(r1).toBe(r2);
  });

  it('invalidates cache when mtime changes', () => {
    const p = write('package.json', JSON.stringify({ name: 'foo' }));
    const r1 = loadPackageJson(p);
    if ('error' in r1) throw new Error(r1.error);
    expect(r1.name).toBe('foo');
    fs.writeFileSync(p, JSON.stringify({ name: 'bar' }));
    fs.utimesSync(p, new Date(), new Date(Date.now() + 5_000));
    const r2 = loadPackageJson(p);
    if ('error' in r2) throw new Error(r2.error);
    expect(r2.name).toBe('bar');
  });
});

describe('loadTsconfig', () => {
  it('reads and parses JSONC', () => {
    const src = `{
      // comment
      "compilerOptions": { "strict": true, },
    }`;
    const p = write('tsconfig.json', src);
    const r = loadTsconfig(p);
    if ('error' in r) throw new Error(r.error);
    expect(r.compilerOptions).toEqual({ strict: true });
  });

  it('enforces the 1 MB cap', () => {
    const big = '{' + '"a":1,'.repeat(200_000) + '"end":1}';
    const p = write('tsconfig.json', big);
    const r = loadTsconfig(p);
    if (!('error' in r)) throw new Error('should have errored');
    expect(r.error).toBe('file_too_large');
  });
});

describe('loadGenericJson', () => {
  it('returns arbitrary parsed JSON', () => {
    const p = write('data.json', JSON.stringify({ a: [1, 2], b: null }));
    const r = loadGenericJson(p);
    expect(r).toEqual({ a: [1, 2], b: null });
  });

  it('enforces the 5 MB cap', () => {
    const big = JSON.stringify({ blob: 'x'.repeat(5 * 1024 * 1024 + 100) });
    const p = write('big.json', big);
    const r = loadGenericJson(p);
    expect(r && typeof r === 'object' && 'error' in (r as object)).toBe(true);
    if (r && typeof r === 'object' && 'error' in (r as object)) {
      expect((r as { error: string }).error).toBe('file_too_large');
    }
  });
});

describe('loadGhaWorkflow', () => {
  it('reads and parses a workflow', () => {
    const src = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const p = write('.github-workflow.yml', src);
    const r = loadGhaWorkflow(p);
    if ('error' in r) throw new Error(r.error);
    expect(r.name).toBe('CI');
    expect(r.jobs?.test?.steps?.[0].run).toBe('echo hi');
  });

  it('enforces the 1 MB cap', () => {
    const big = 'name: X\nfoo: ' + 'x'.repeat(1_048_600);
    const p = write('big.yml', big);
    const r = loadGhaWorkflow(p);
    if (!('error' in r)) throw new Error('should have errored');
    expect(r.error).toBe('file_too_large');
  });
});

describe('loadGenericYaml', () => {
  it('returns arbitrary parsed YAML', () => {
    const p = write('data.yml', 'a: 1\nb: [2, 3]\n');
    const r = loadGenericYaml(p);
    expect(r).toEqual({ a: 1, b: [2, 3] });
  });

  it('enforces the 5 MB cap', () => {
    const big = 'blob: ' + 'x'.repeat(5 * 1024 * 1024 + 100);
    const p = write('big.yaml', big);
    const r = loadGenericYaml(p);
    expect(r && typeof r === 'object' && 'error' in (r as object)).toBe(true);
  });
});

describe('loadCargoToml', () => {
  it('reads and parses', () => {
    const src = `
[package]
name = "x"
version = "0.1.0"

[dependencies]
serde = "1"
`;
    const p = write('Cargo.toml', src);
    const r = loadCargoToml(p);
    if ('error' in r) throw new Error(r.error);
    expect(r.package?.name).toBe('x');
    expect(r.dependencies?.serde).toBe('1');
  });

  it('enforces the 1 MB cap', () => {
    const big = '[x]\nk = "' + 'v'.repeat(1_048_600) + '"\n';
    const p = write('Cargo.toml', big);
    const r = loadCargoToml(p);
    if (!('error' in r)) throw new Error('should have errored');
    expect(r.error).toBe('file_too_large');
  });
});

describe('loadGenericToml', () => {
  it('returns arbitrary parsed TOML', () => {
    const p = write('conf.toml', 'title = "t"\n[x]\nk = 1\n');
    const r = loadGenericToml(p);
    expect(r).toEqual({ title: 't', x: { k: 1 } });
  });

  it('enforces the 5 MB cap', () => {
    const big = 'blob = "' + 'x'.repeat(5 * 1024 * 1024 + 100) + '"\n';
    const p = write('big.toml', big);
    const r = loadGenericToml(p);
    expect(r && typeof r === 'object' && 'error' in (r as object)).toBe(true);
  });
});
