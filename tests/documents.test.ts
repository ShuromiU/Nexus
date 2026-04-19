import { describe, it, expect } from 'vitest';
import { parsePackageJson } from '../src/analysis/documents/package-json.js';
import { parseTsconfig } from '../src/analysis/documents/tsconfig.js';
import { parseGenericJson } from '../src/analysis/documents/generic-json.js';

describe('parsePackageJson', () => {
  it('extracts name, version, deps, scripts', () => {
    const result = parsePackageJson(JSON.stringify({
      name: 'foo',
      version: '1.2.3',
      dependencies: { a: '^1.0.0' },
      devDependencies: { b: '^2.0.0' },
      peerDependencies: { c: '^3.0.0' },
      scripts: { test: 'vitest' },
      workspaces: ['packages/*'],
    }));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.name).toBe('foo');
    expect(result.version).toBe('1.2.3');
    expect(result.dependencies).toEqual({ a: '^1.0.0' });
    expect(result.devDependencies).toEqual({ b: '^2.0.0' });
    expect(result.peerDependencies).toEqual({ c: '^3.0.0' });
    expect(result.scripts).toEqual({ test: 'vitest' });
    expect(result.workspaces).toEqual(['packages/*']);
  });

  it('supports object-form workspaces', () => {
    const result = parsePackageJson(JSON.stringify({
      workspaces: { packages: ['apps/*'] },
    }));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.workspaces).toEqual({ packages: ['apps/*'] });
  });

  it('returns { error } on malformed JSON', () => {
    const r = parsePackageJson('{ not valid');
    expect('error' in r).toBe(true);
  });

  it('returns { error } on non-object root', () => {
    const r = parsePackageJson('42');
    expect('error' in r).toBe(true);
  });
});

describe('parseTsconfig', () => {
  it('tolerates line comments and trailing commas', () => {
    const src = `{
      // top-level comment
      "extends": "./base.json",
      "compilerOptions": {
        "strict": true,
        "target": "ES2022", /* inline */
      },
      "include": ["src/**/*"],
    }`;
    const r = parseTsconfig(src);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.extends).toBe('./base.json');
    expect(r.compilerOptions).toEqual({ strict: true, target: 'ES2022' });
    expect(r.include).toEqual(['src/**/*']);
  });

  it('extracts references and files', () => {
    const src = `{
      "files": ["a.ts"],
      "references": [{ "path": "../pkg-a" }, { "path": "../pkg-b" }]
    }`;
    const r = parseTsconfig(src);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.files).toEqual(['a.ts']);
    expect(r.references).toEqual([{ path: '../pkg-a' }, { path: '../pkg-b' }]);
  });

  it('returns { error } on syntactic garbage', () => {
    const r = parseTsconfig('{ "x": }');
    expect('error' in r).toBe(true);
  });
});

describe('parseGenericJson', () => {
  it('round-trips arbitrary nested structures', () => {
    const src = JSON.stringify({ a: [1, 2, { b: 'x' }], c: null });
    const r = parseGenericJson(src);
    expect(r).toEqual({ a: [1, 2, { b: 'x' }], c: null });
  });

  it('tolerates comments (JSONC)', () => {
    const r = parseGenericJson('{ /* c */ "a": 1, }');
    expect(r).toEqual({ a: 1 });
  });

  it('returns { error } on malformed input', () => {
    const r = parseGenericJson('{ not json');
    expect(r && typeof r === 'object' && 'error' in r).toBe(true);
  });
});
