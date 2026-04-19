import { describe, it, expect } from 'vitest';
import { parsePackageJson } from '../src/analysis/documents/package-json.js';
import { parseTsconfig } from '../src/analysis/documents/tsconfig.js';
import { parseGenericJson } from '../src/analysis/documents/generic-json.js';
import { parseGhaWorkflow } from '../src/analysis/documents/gha-workflow.js';
import { parseGenericYaml } from '../src/analysis/documents/generic-yaml.js';
import { parseCargoToml } from '../src/analysis/documents/cargo-toml.js';
import { parseGenericToml } from '../src/analysis/documents/generic-toml.js';
import { parseYarnLock } from '../src/analysis/documents/yarn-lock.js';

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

describe('parseGhaWorkflow', () => {
  it('extracts name, jobs, and steps', () => {
    const src = `
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Build
        run: npm run build
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`;
    const r = parseGhaWorkflow(src);
    if ('error' in r) throw new Error(r.error);
    expect(r.name).toBe('CI');
    expect(r.jobs?.test?.['runs-on']).toBe('ubuntu-latest');
    expect(r.jobs?.test?.steps).toHaveLength(2);
    expect(r.jobs?.test?.steps?.[0].uses).toBe('actions/checkout@v4');
    expect(r.jobs?.lint?.steps?.[0].run).toBe('npm run lint');
  });

  it('returns { error } on malformed YAML', () => {
    // Block mapping with inconsistent indentation that the yaml lib rejects.
    const r = parseGhaWorkflow('a: 1\n b: 2\n  c: 3\n\t- not yaml');
    expect('error' in r).toBe(true);
  });
});

describe('parseGenericYaml', () => {
  it('round-trips nested structures', () => {
    const r = parseGenericYaml('a:\n  - 1\n  - 2\nb:\n  c: x\n');
    expect(r).toEqual({ a: [1, 2], b: { c: 'x' } });
  });

  it('returns { error } on malformed YAML', () => {
    const r = parseGenericYaml(': : : :');
    expect(r && typeof r === 'object' && 'error' in (r as object)).toBe(true);
  });
});

describe('parseCargoToml', () => {
  it('extracts [package] and [dependencies]', () => {
    const src = `
[package]
name = "my-crate"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = "1.0"
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
criterion = "0.5"
`;
    const r = parseCargoToml(src);
    if ('error' in r) throw new Error(r.error);
    expect(r.package?.name).toBe('my-crate');
    expect(r.package?.version).toBe('0.1.0');
    expect(r.package?.edition).toBe('2021');
    expect(r.dependencies?.serde).toBe('1.0');
    expect(r['dev-dependencies']?.criterion).toBe('0.5');
  });

  it('extracts [workspace].members', () => {
    const src = `
[workspace]
members = ["crates/a", "crates/b"]
`;
    const r = parseCargoToml(src);
    if ('error' in r) throw new Error(r.error);
    expect(r.workspace?.members).toEqual(['crates/a', 'crates/b']);
  });

  it('returns { error } on malformed TOML', () => {
    const r = parseCargoToml('[[[[bad');
    expect('error' in r).toBe(true);
  });
});

describe('parseGenericToml', () => {
  it('round-trips arbitrary structures', () => {
    const r = parseGenericToml('title = "t"\n[table]\nkey = 1\n');
    expect(r).toEqual({ title: 't', table: { key: 1 } });
  });

  it('returns { error } on malformed TOML', () => {
    const r = parseGenericToml('[[[[bad');
    expect(r && typeof r === 'object' && 'error' in (r as object)).toBe(true);
  });
});

describe('parseYarnLock', () => {
  it('extracts name + version from yarn v1 entries', () => {
    const src = `# yarn lockfile v1

"react@^18.0.0":
  version "18.2.0"
  resolved "https://registry.yarnpkg.com/react/-/react-18.2.0.tgz"

"lodash@^4.17.0", "lodash@^4.17.21":
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"
`;
    const r = parseYarnLock(src);
    if ('error' in r) throw new Error(r.error);
    expect(r.entries).toContainEqual({ name: 'react', version: '18.2.0' });
    expect(r.entries).toContainEqual({ name: 'lodash', version: '4.17.21' });
    expect(r.entries).toHaveLength(2);
  });

  it('handles scoped packages', () => {
    const src = `
"@types/node@^20.0.0":
  version "20.10.5"
`;
    const r = parseYarnLock(src);
    if ('error' in r) throw new Error(r.error);
    expect(r.entries).toContainEqual({ name: '@types/node', version: '20.10.5' });
  });

  it('returns empty entries for an empty lockfile', () => {
    const r = parseYarnLock('# yarn lockfile v1\n');
    if ('error' in r) throw new Error(r.error);
    expect(r.entries).toEqual([]);
  });
});
