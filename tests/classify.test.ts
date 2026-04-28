import { describe, it, expect } from 'vitest';
import { classifyPath, classifyTestPath } from '../src/workspace/classify.js';

const noOverrides = { languages: {} };

describe('classifyPath', () => {
  it('classifies .ts as source(typescript)', () => {
    expect(classifyPath('src/index.ts', 'index.ts', noOverrides))
      .toEqual({ kind: 'source', language: 'typescript' });
  });

  it('classifies .py as source(python)', () => {
    expect(classifyPath('app.py', 'app.py', noOverrides))
      .toEqual({ kind: 'source', language: 'python' });
  });

  it('recognises every default extension', () => {
    const cases: Array<[string, string]> = [
      ['x.tsx', 'typescript'], ['x.mts', 'typescript'], ['x.cts', 'typescript'],
      ['x.js', 'javascript'], ['x.jsx', 'javascript'], ['x.mjs', 'javascript'], ['x.cjs', 'javascript'],
      ['x.go', 'go'], ['x.rs', 'rust'], ['x.java', 'java'], ['x.cs', 'csharp'], ['x.css', 'css'],
    ];
    for (const [p, lang] of cases) {
      expect(classifyPath(p, p, noOverrides)).toEqual({ kind: 'source', language: lang });
    }
  });

  it('classifies package.json as package_json (not json_generic)', () => {
    expect(classifyPath('package.json', 'package.json', noOverrides)).toEqual({ kind: 'package_json' });
  });

  it('classifies tsconfig.json and tsconfig.base.json as tsconfig_json', () => {
    expect(classifyPath('tsconfig.json', 'tsconfig.json', noOverrides)).toEqual({ kind: 'tsconfig_json' });
    expect(classifyPath('apps/web/tsconfig.base.json', 'tsconfig.base.json', noOverrides))
      .toEqual({ kind: 'tsconfig_json' });
  });

  it('classifies .github/workflows/ci.yml as gha_workflow', () => {
    expect(classifyPath('.github/workflows/ci.yml', 'ci.yml', noOverrides))
      .toEqual({ kind: 'gha_workflow' });
    expect(classifyPath('.github/workflows/release.yaml', 'release.yaml', noOverrides))
      .toEqual({ kind: 'gha_workflow' });
  });

  it('classifies nested .github/workflows/*.yml as yaml_generic (GHA ignores them)', () => {
    expect(classifyPath('.github/workflows/nested/ci.yml', 'ci.yml', noOverrides))
      .toEqual({ kind: 'yaml_generic' });
  });

  it('classifies lockfiles by exact basename', () => {
    expect(classifyPath('package-lock.json', 'package-lock.json', noOverrides)).toEqual({ kind: 'package_lock' });
    expect(classifyPath('yarn.lock', 'yarn.lock', noOverrides)).toEqual({ kind: 'yarn_lock' });
    expect(classifyPath('pnpm-lock.yaml', 'pnpm-lock.yaml', noOverrides)).toEqual({ kind: 'pnpm_lock' });
    expect(classifyPath('Cargo.lock', 'Cargo.lock', noOverrides)).toEqual({ kind: 'cargo_lock' });
  });

  it('classifies Cargo.toml as cargo_toml (case-insensitive basename)', () => {
    expect(classifyPath('Cargo.toml', 'Cargo.toml', noOverrides)).toEqual({ kind: 'cargo_toml' });
    expect(classifyPath('crates/a/cargo.toml', 'cargo.toml', noOverrides)).toEqual({ kind: 'cargo_toml' });
  });

  it('falls back to json_generic / yaml_generic / toml_generic', () => {
    expect(classifyPath('data/x.json', 'x.json', noOverrides)).toEqual({ kind: 'json_generic' });
    expect(classifyPath('ci/x.yaml', 'x.yaml', noOverrides)).toEqual({ kind: 'yaml_generic' });
    expect(classifyPath('ci/x.yml', 'x.yml', noOverrides)).toEqual({ kind: 'yaml_generic' });
    expect(classifyPath('cfg/x.toml', 'x.toml', noOverrides)).toEqual({ kind: 'toml_generic' });
  });

  it('returns ignored for unknown extensions and dotfiles', () => {
    expect(classifyPath('README.md', 'README.md', noOverrides)).toEqual({ kind: 'ignored' });
    expect(classifyPath('.gitignore', '.gitignore', noOverrides)).toEqual({ kind: 'ignored' });
    expect(classifyPath('.eslintrc', '.eslintrc', noOverrides)).toEqual({ kind: 'ignored' });
    expect(classifyPath('bin/tool', 'tool', noOverrides)).toEqual({ kind: 'ignored' });
  });

  it('honors config.languages override — custom extension wins over generic', () => {
    const config = { languages: { typescript: { extensions: ['.astro'] } } };
    expect(classifyPath('pages/index.astro', 'index.astro', config))
      .toEqual({ kind: 'source', language: 'typescript' });
  });

  it('config override beats json_generic / yaml_generic / toml_generic', () => {
    const config = { languages: { custom: { extensions: ['.yaml', '.json'] } } };
    expect(classifyPath('a.yaml', 'a.yaml', config)).toEqual({ kind: 'source', language: 'custom' });
    expect(classifyPath('a.json', 'a.json', config)).toEqual({ kind: 'source', language: 'custom' });
  });

  it('known basenames beat config-overridden generic extensions', () => {
    const config = { languages: { custom: { extensions: ['.json', '.toml', '.yaml'] } } };
    expect(classifyPath('package.json', 'package.json', config)).toEqual({ kind: 'package_json' });
    expect(classifyPath('Cargo.toml', 'Cargo.toml', config)).toEqual({ kind: 'cargo_toml' });
    expect(classifyPath('pnpm-lock.yaml', 'pnpm-lock.yaml', config)).toEqual({ kind: 'pnpm_lock' });
  });

  it('accepts extension with or without leading dot in config', () => {
    const config = { languages: { g: { extensions: ['graphql', '.gql'] } } };
    expect(classifyPath('q.graphql', 'q.graphql', config)).toEqual({ kind: 'source', language: 'g' });
    expect(classifyPath('q.gql', 'q.gql', config)).toEqual({ kind: 'source', language: 'g' });
  });

  it('is case-insensitive for extensions', () => {
    expect(classifyPath('x.TS', 'x.TS', noOverrides)).toEqual({ kind: 'source', language: 'typescript' });
    expect(classifyPath('x.JSON', 'x.JSON', noOverrides)).toEqual({ kind: 'json_generic' });
  });

  it('is case-insensitive for known basenames', () => {
    expect(classifyPath('PACKAGE.JSON', 'PACKAGE.JSON', noOverrides)).toEqual({ kind: 'package_json' });
  });
});

describe('classifyTestPath', () => {
  it('flags *.test.ts as declared', () => {
    expect(classifyTestPath('src/foo.test.ts')).toBe('declared');
    expect(classifyTestPath('src/foo.test.tsx')).toBe('declared');
    expect(classifyTestPath('packages/x/y.test.js')).toBe('declared');
  });

  it('flags *.spec.ts as declared', () => {
    expect(classifyTestPath('src/foo.spec.ts')).toBe('declared');
    expect(classifyTestPath('packages/x/y.spec.jsx')).toBe('declared');
  });

  it('flags __tests__/ ancestor as declared', () => {
    expect(classifyTestPath('src/__tests__/foo.ts')).toBe('declared');
    expect(classifyTestPath('packages/x/__tests__/nested/foo.ts')).toBe('declared');
  });

  it('flags top-level tests/ or test/ as derived', () => {
    expect(classifyTestPath('tests/foo.ts')).toBe('derived');
    expect(classifyTestPath('test/foo.ts')).toBe('derived');
  });

  it('returns null for plain source paths', () => {
    expect(classifyTestPath('src/foo.ts')).toBeNull();
    expect(classifyTestPath('packages/x/y.ts')).toBeNull();
  });

  it('does not flag a deep tests/ subdir (only top-level)', () => {
    expect(classifyTestPath('src/utils/tests/foo.ts')).toBeNull();
  });

  it('declared trumps derived', () => {
    expect(classifyTestPath('tests/foo.test.ts')).toBe('declared');
  });

  it('is case-insensitive', () => {
    expect(classifyTestPath('SRC/Foo.Test.TS')).toBe('declared');
    expect(classifyTestPath('Tests/foo.ts')).toBe('derived');
  });
});
