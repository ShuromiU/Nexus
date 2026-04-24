# A3 P2 — `nexus_lockfile_deps` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `nexus_lockfile_deps(file, name?)` MCP tool that lists `{name, version}` entries from a lockfile (npm `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`).

**Architecture:** Add one parser per missing format (`package-lock`, `pnpm-lock`, `cargo-lock`) under `src/analysis/documents/`, register them in the A2 loader module with existing size caps, add a `lockfileDeps()` method on `QueryEngine` that classifies the file and dispatches to the right loader, then expose via MCP tool + CLI command. No indexing — purely query-time.

**Tech Stack:** TypeScript strict, Vitest, `smol-toml` (already a dep) for `Cargo.lock`, `yaml` (already a dep) for `pnpm-lock.yaml`, native `JSON.parse` for `package-lock.json`.

---

## Scope

**In scope:**
- Parsers for `package-lock.json` (v1 + v2/v3), `pnpm-lock.yaml` (v6+), `Cargo.lock`.
- Loaders that reuse the A2 cache + size cap pattern.
- `QueryEngine.lockfileDeps(file, name?)` producing `{ file, kind, entries: {name, version}[] }`.
- MCP tool `nexus_lockfile_deps`, CLI `nexus lockfile-deps`.
- Compact-mode key for `version`.
- Public re-exports for new parser/loader types and `LockfileDepsResult`.
- Docs: CHANGELOG, CLAUDE.md tool list, mark A3 P2 shipped in the roadmap.

**Out of scope (explicit):**
- Dependency graph resolution (who-depends-on-whom, transitive edges).
- Deduping across versions — each distinct `(name, version)` entry is preserved.
- Line anchors or position info.
- Indexed storage — per the V3 roadmap, lockfile data is query-time only.
- Workspace/monorepo aggregation (the tool targets one lockfile at a time).
- Other formats (Gemfile.lock, Pipfile.lock, poetry.lock, go.sum, etc.) — deferred until adoption validates.

## File Structure

**Create:**
- `src/analysis/documents/package-lock.ts` — `parsePackageLock(content)`
- `src/analysis/documents/pnpm-lock.ts` — `parsePnpmLock(content)`
- `src/analysis/documents/cargo-lock.ts` — `parseCargoLock(content)`
- `tests/lockfile-parsers.test.ts` — unit tests for all 3 new parsers (yarn stays in `tests/documents.test.ts`)
- `tests/lockfile-deps.test.ts` — engine + loader integration tests for `lockfileDeps()`

**Modify:**
- `src/analysis/documents/loaders.ts` — add `loadPackageLock`, `loadPnpmLock`, `loadCargoLock`, plus `SIZE_CAPS.package_lock`, `SIZE_CAPS.pnpm_lock`, `SIZE_CAPS.cargo_lock` (all 20 MB per roadmap).
- `src/analysis/documents/index.ts` — barrel re-exports for the three new parsers and loaders.
- `src/query/engine.ts` — add `'lockfile_deps'` to `NexusResultType`, `LockfileDepsResult` interface, `lockfileDeps()` method, internal `loadLockfile()` dispatch helper.
- `src/query/compact.ts` — add `version: 've'` to `KEY_MAP`.
- `src/transports/mcp.ts` — register tool schema, add dispatch case, export as part of tools list.
- `src/transports/cli.ts` — add `lockfile-deps <file> [name]` subcommand.
- `src/index.ts` — re-export `parsePackageLock`, `parsePnpmLock`, `parseCargoLock`, their `Parsed*` types, the new loader fns, and `LockfileDepsResult`.
- `tests/mcp.test.ts` — add tool-registration + dispatch assertions.
- `tests/cli.test.ts` — add bin-shape / lockfile-deps subcommand test.
- `tests/e2e.test.ts` — add a public-API smoke test for the new symbols.
- `CHANGELOG.md` — new `[Unreleased] — A3 P2 lockfile_deps` section.
- `CLAUDE.md` — add `nexus_lockfile_deps` to the Structured files section.
- `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md` — annotate A3 P2 as shipped.

---

## Task 1: Parser — `package-lock.json`

**Files:**
- Create: `src/analysis/documents/package-lock.ts`
- Test: `tests/lockfile-parsers.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/lockfile-parsers.test.ts
import { describe, it, expect } from 'vitest';
import { parsePackageLock } from '../src/analysis/documents/package-lock.js';

describe('parsePackageLock', () => {
  it('parses lockfileVersion 3 (packages map)', () => {
    const src = JSON.stringify({
      name: 'root',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/react': { version: '18.2.0' },
        'node_modules/@scope/pkg': { version: '0.3.1' },
        'node_modules/nested/node_modules/lodash': { version: '4.17.21' },
      },
    });
    const r = parsePackageLock(src);
    expect('error' in r).toBe(false);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual(expect.arrayContaining([
      { name: 'react', version: '18.2.0' },
      { name: '@scope/pkg', version: '0.3.1' },
      { name: 'lodash', version: '4.17.21' },
    ]));
    expect(r.entries.find(e => e.name === 'root')).toBeUndefined();
  });

  it('falls back to lockfileVersion 1 (dependencies tree)', () => {
    const src = JSON.stringify({
      name: 'root',
      version: '1.0.0',
      lockfileVersion: 1,
      dependencies: {
        react: { version: '17.0.2' },
        lodash: {
          version: '4.17.21',
          dependencies: {
            '@scope/nested': { version: '0.1.0' },
          },
        },
      },
    });
    const r = parsePackageLock(src);
    if ('error' in r) throw new Error('unreachable');
    const names = r.entries.map(e => `${e.name}@${e.version}`);
    expect(names).toEqual(expect.arrayContaining([
      'react@17.0.2',
      'lodash@4.17.21',
      '@scope/nested@0.1.0',
    ]));
  });

  it('returns { error } on invalid JSON', () => {
    const r = parsePackageLock('{not-json');
    expect('error' in r).toBe(true);
  });

  it('returns { error } when root is not an object', () => {
    const r = parsePackageLock('[]');
    expect('error' in r).toBe(true);
  });

  it('returns empty entries when neither packages nor dependencies exist', () => {
    const r = parsePackageLock('{}');
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([]);
  });
});
```

Run: `npx vitest run tests/lockfile-parsers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement parser**

```ts
// src/analysis/documents/package-lock.ts
export interface ParsedPackageLock {
  entries: { name: string; version: string }[];
}

export type ParseError = { error: string };

/**
 * Parse npm `package-lock.json`. Supports lockfileVersion 1 (legacy
 * `dependencies` tree) and lockfileVersion 2/3 (flat `packages` map keyed on
 * `node_modules/<pkg>` paths).
 *
 * Returns every `{name, version}` pair encountered. Duplicates (same package
 * at different versions) are preserved — callers decide how to dedupe.
 */
export function parsePackageLock(content: string): ParsedPackageLock | ParseError {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'package-lock.json root must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const entries: { name: string; version: string }[] = [];

  // Prefer v2/v3 `packages` map.
  if (typeof obj.packages === 'object' && obj.packages !== null && !Array.isArray(obj.packages)) {
    for (const [key, value] of Object.entries(obj.packages as Record<string, unknown>)) {
      if (key === '') continue; // root package
      const name = packageNameFromPath(key);
      if (!name) continue;
      const version = extractVersion(value);
      if (version === null) continue;
      entries.push({ name, version });
    }
    return { entries };
  }

  // Fall back to v1 `dependencies` tree.
  if (typeof obj.dependencies === 'object' && obj.dependencies !== null && !Array.isArray(obj.dependencies)) {
    walkV1Deps(obj.dependencies as Record<string, unknown>, entries);
  }
  return { entries };
}

/**
 * `node_modules/foo` → `foo`
 * `node_modules/@scope/pkg` → `@scope/pkg`
 * `node_modules/foo/node_modules/bar` → `bar`
 * Returns null if the path has no `node_modules/` segment.
 */
function packageNameFromPath(p: string): string | null {
  const marker = 'node_modules/';
  const idx = p.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = p.slice(idx + marker.length);
  if (rest.length === 0) return null;
  if (rest.startsWith('@')) {
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    const nextSlash = rest.indexOf('/', slash + 1);
    return nextSlash === -1 ? rest : rest.slice(0, nextSlash);
  }
  const nextSlash = rest.indexOf('/');
  return nextSlash === -1 ? rest : rest.slice(0, nextSlash);
}

function extractVersion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = (value as Record<string, unknown>).version;
  return typeof v === 'string' ? v : null;
}

function walkV1Deps(
  deps: Record<string, unknown>,
  out: { name: string; version: string }[],
): void {
  for (const [name, value] of Object.entries(deps)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    if (typeof obj.version === 'string') {
      out.push({ name, version: obj.version });
    }
    if (typeof obj.dependencies === 'object' && obj.dependencies !== null && !Array.isArray(obj.dependencies)) {
      walkV1Deps(obj.dependencies as Record<string, unknown>, out);
    }
  }
}
```

- [ ] **Step 3: Run tests to verify pass**

Run: `npx vitest run tests/lockfile-parsers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add src/analysis/documents/package-lock.ts tests/lockfile-parsers.test.ts
git commit -m "feat(documents): parse package-lock.json (v1 + v2/v3)"
```

---

## Task 2: Parser — `pnpm-lock.yaml`

**Files:**
- Create: `src/analysis/documents/pnpm-lock.ts`
- Test: `tests/lockfile-parsers.test.ts` (extend)

- [ ] **Step 1: Write failing tests — append to lockfile-parsers.test.ts**

```ts
import { parsePnpmLock } from '../src/analysis/documents/pnpm-lock.js';

describe('parsePnpmLock', () => {
  it('parses pnpm v6/v9 packages keys (/name@version)', () => {
    const src = `lockfileVersion: '9.0'
packages:
  /react@18.2.0:
    resolution: { integrity: sha512-foo }
  /@scope/pkg@0.3.1:
    resolution: { integrity: sha512-bar }
  /lodash@4.17.21:
    resolution: { integrity: sha512-baz }
`;
    const r = parsePnpmLock(src);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual(expect.arrayContaining([
      { name: 'react', version: '18.2.0' },
      { name: '@scope/pkg', version: '0.3.1' },
      { name: 'lodash', version: '4.17.21' },
    ]));
  });

  it('parses legacy pnpm keys (/name/version)', () => {
    const src = `lockfileVersion: '5.4'
packages:
  /react/18.2.0:
    resolution: { integrity: sha512-foo }
  /@scope/pkg/0.3.1:
    resolution: { integrity: sha512-bar }
`;
    const r = parsePnpmLock(src);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual(expect.arrayContaining([
      { name: 'react', version: '18.2.0' },
      { name: '@scope/pkg', version: '0.3.1' },
    ]));
  });

  it('strips peer-dependency suffixes from keys', () => {
    const src = `lockfileVersion: '9.0'
packages:
  /react-dom@18.2.0(react@18.2.0):
    resolution: { integrity: sha512-foo }
`;
    const r = parsePnpmLock(src);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([{ name: 'react-dom', version: '18.2.0' }]);
  });

  it('returns { error } on invalid YAML', () => {
    const r = parsePnpmLock(':::not: valid: yaml: :');
    expect('error' in r).toBe(true);
  });

  it('returns empty entries when packages is absent', () => {
    const r = parsePnpmLock("lockfileVersion: '9.0'\n");
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([]);
  });
});
```

Run: `npx vitest run tests/lockfile-parsers.test.ts`
Expected: FAIL on the pnpm describe block — module not found.

- [ ] **Step 2: Implement parser**

```ts
// src/analysis/documents/pnpm-lock.ts
import { parse as parseYaml } from 'yaml';

export interface ParsedPnpmLock {
  entries: { name: string; version: string }[];
}

export type ParseError = { error: string };

/**
 * Parse `pnpm-lock.yaml`. Walks the top-level `packages` map and extracts
 * `{name, version}` from each key. Supports two key formats:
 *   - Modern (pnpm v6+): `/name@version` and `/@scope/name@version`
 *   - Legacy (pnpm ≤v5): `/name/version` and `/@scope/name/version`
 *
 * Peer-dependency suffixes (`/foo@1.0.0(bar@2.0.0)`) are stripped.
 */
export function parsePnpmLock(content: string): ParsedPnpmLock | ParseError {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid YAML' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { entries: [] };
  }
  const obj = raw as Record<string, unknown>;
  const pkgs = obj.packages;
  if (typeof pkgs !== 'object' || pkgs === null || Array.isArray(pkgs)) {
    return { entries: [] };
  }

  const entries: { name: string; version: string }[] = [];
  for (const rawKey of Object.keys(pkgs as Record<string, unknown>)) {
    const parsed = parsePnpmKey(rawKey);
    if (parsed) entries.push(parsed);
  }
  return { entries };
}

/**
 * Turn a pnpm packages-key into {name, version}.
 * Accepts modern `/name@version` and legacy `/name/version`. Returns null
 * if we can't confidently extract both.
 */
function parsePnpmKey(raw: string): { name: string; version: string } | null {
  let key = raw.startsWith('/') ? raw.slice(1) : raw;
  // Strip peer-dep suffix: `foo@1.0.0(react@18.2.0)` → `foo@1.0.0`
  const parenIdx = key.indexOf('(');
  if (parenIdx !== -1) key = key.slice(0, parenIdx);

  if (key.startsWith('@')) {
    // Scoped: @scope/name@version OR @scope/name/version
    const slash = key.indexOf('/');
    if (slash === -1) return null;
    const rest = key.slice(slash + 1); // `name@version` or `name/version`
    const at = rest.lastIndexOf('@');
    if (at > 0) {
      return { name: key.slice(0, slash + 1 + at), version: rest.slice(at + 1) };
    }
    const slash2 = rest.lastIndexOf('/');
    if (slash2 > 0) {
      return { name: key.slice(0, slash + 1 + slash2), version: rest.slice(slash2 + 1) };
    }
    return null;
  }

  const at = key.lastIndexOf('@');
  if (at > 0) {
    return { name: key.slice(0, at), version: key.slice(at + 1) };
  }
  const slash = key.lastIndexOf('/');
  if (slash > 0) {
    return { name: key.slice(0, slash), version: key.slice(slash + 1) };
  }
  return null;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/lockfile-parsers.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/analysis/documents/pnpm-lock.ts tests/lockfile-parsers.test.ts
git commit -m "feat(documents): parse pnpm-lock.yaml (v6 + legacy keys)"
```

---

## Task 3: Parser — `Cargo.lock`

**Files:**
- Create: `src/analysis/documents/cargo-lock.ts`
- Test: `tests/lockfile-parsers.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

```ts
import { parseCargoLock } from '../src/analysis/documents/cargo-lock.js';

describe('parseCargoLock', () => {
  it('parses [[package]] array', () => {
    const src = `version = 3

[[package]]
name = "serde"
version = "1.0.195"

[[package]]
name = "tokio"
version = "1.35.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
    const r = parseCargoLock(src);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([
      { name: 'serde', version: '1.0.195' },
      { name: 'tokio', version: '1.35.0' },
    ]);
  });

  it('skips entries missing name or version', () => {
    const src = `[[package]]
name = "ok"
version = "0.1.0"

[[package]]
name = "no-version"
`;
    const r = parseCargoLock(src);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([{ name: 'ok', version: '0.1.0' }]);
  });

  it('returns { error } on invalid TOML', () => {
    const r = parseCargoLock('not = [valid] = toml');
    expect('error' in r).toBe(true);
  });

  it('returns empty entries when no packages', () => {
    const r = parseCargoLock('version = 3\n');
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([]);
  });
});
```

Run: `npx vitest run tests/lockfile-parsers.test.ts`
Expected: FAIL on cargo-lock describe block.

- [ ] **Step 2: Implement parser**

```ts
// src/analysis/documents/cargo-lock.ts
import { parse as parseToml } from 'smol-toml';

export interface ParsedCargoLock {
  entries: { name: string; version: string }[];
}

export type ParseError = { error: string };

/**
 * Parse `Cargo.lock`. Uses `smol-toml`, which decodes `[[package]]` as an
 * array of tables at key `package`. Each entry with both a string `name` and
 * string `version` becomes an output row.
 */
export function parseCargoLock(content: string): ParsedCargoLock | ParseError {
  let raw: unknown;
  try {
    raw = parseToml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid TOML' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { entries: [] };
  }
  const pkgs = (raw as Record<string, unknown>).package;
  if (!Array.isArray(pkgs)) return { entries: [] };

  const entries: { name: string; version: string }[] = [];
  for (const item of pkgs) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== 'string' || typeof obj.version !== 'string') continue;
    entries.push({ name: obj.name, version: obj.version });
  }
  return { entries };
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/lockfile-parsers.test.ts`
Expected: PASS (all parser describes green).

- [ ] **Step 4: Commit**

```bash
git add src/analysis/documents/cargo-lock.ts tests/lockfile-parsers.test.ts
git commit -m "feat(documents): parse Cargo.lock"
```

---

## Task 4: Loaders + barrel re-exports

**Files:**
- Modify: `src/analysis/documents/loaders.ts`
- Modify: `src/analysis/documents/index.ts`
- Test: `tests/document-loaders.test.ts`

- [ ] **Step 1: Write failing tests — append to `tests/document-loaders.test.ts`**

```ts
import {
  loadPackageLock, loadPnpmLock, loadCargoLock,
} from '../src/analysis/documents/loaders.js';

// (`write` helper is defined at the top of the existing file.)

describe('lockfile loaders', () => {
  it('reads and parses package-lock.json', () => {
    const p = write('package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/react': { version: '18.2.0' },
      },
    }));
    const r = loadPackageLock(p);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([{ name: 'react', version: '18.2.0' }]);
  });

  it('reads and parses pnpm-lock.yaml', () => {
    const p = write('pnpm-lock.yaml', `lockfileVersion: '9.0'
packages:
  /react@18.2.0:
    resolution: { integrity: sha512-foo }
`);
    const r = loadPnpmLock(p);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([{ name: 'react', version: '18.2.0' }]);
  });

  it('reads and parses Cargo.lock', () => {
    const p = write('Cargo.lock', `[[package]]
name = "serde"
version = "1.0.195"
`);
    const r = loadCargoLock(p);
    if ('error' in r) throw new Error('unreachable');
    expect(r.entries).toEqual([{ name: 'serde', version: '1.0.195' }]);
  });

  it('returns file_too_large over 20 MB cap for package-lock.json', () => {
    const padding = 'x'.repeat(21 * 1024 * 1024);
    const p = write('package-lock.json', padding);
    const r = loadPackageLock(p);
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error).toBe('file_too_large');
      expect(r.limit).toBe(20 * 1024 * 1024);
    }
  });
});
```

Run: `npx vitest run tests/document-loaders.test.ts`
Expected: FAIL — `loadPackageLock` not exported.

- [ ] **Step 2: Extend `src/analysis/documents/loaders.ts`**

Add imports alongside the existing ones:

```ts
import { parsePackageLock, type ParsedPackageLock } from './package-lock.js';
import { parsePnpmLock, type ParsedPnpmLock } from './pnpm-lock.js';
import { parseCargoLock, type ParsedCargoLock } from './cargo-lock.js';
```

Extend `SIZE_CAPS` (preserve the existing `as const` block — add three entries):

```ts
export const SIZE_CAPS = {
  package_json: 1 * 1024 * 1024,
  tsconfig_json: 1 * 1024 * 1024,
  cargo_toml: 1 * 1024 * 1024,
  gha_workflow: 1 * 1024 * 1024,
  json_generic: 5 * 1024 * 1024,
  yaml_generic: 5 * 1024 * 1024,
  toml_generic: 5 * 1024 * 1024,
  yarn_lock: 20 * 1024 * 1024,
  package_lock: 20 * 1024 * 1024,
  pnpm_lock: 20 * 1024 * 1024,
  cargo_lock: 20 * 1024 * 1024,
} as const;
```

Add loader functions at the bottom of the file:

```ts
export function loadPackageLock(absPath: string): ParsedPackageLock | LoadError {
  return loadCached(absPath, SIZE_CAPS.package_lock, parsePackageLock);
}

export function loadPnpmLock(absPath: string): ParsedPnpmLock | LoadError {
  return loadCached(absPath, SIZE_CAPS.pnpm_lock, parsePnpmLock);
}

export function loadCargoLock(absPath: string): ParsedCargoLock | LoadError {
  return loadCached(absPath, SIZE_CAPS.cargo_lock, parseCargoLock);
}
```

- [ ] **Step 3: Extend `src/analysis/documents/index.ts`**

Add to the barrel file (follow existing style):

```ts
export { parsePackageLock } from './package-lock.js';
export type { ParsedPackageLock } from './package-lock.js';

export { parsePnpmLock } from './pnpm-lock.js';
export type { ParsedPnpmLock } from './pnpm-lock.js';

export { parseCargoLock } from './cargo-lock.js';
export type { ParsedCargoLock } from './cargo-lock.js';
```

And extend the loader re-export list:

```ts
export {
  loadPackageJson, loadTsconfig, loadGenericJson,
  loadGhaWorkflow, loadGenericYaml,
  loadCargoToml, loadGenericToml,
  loadYarnLock, loadPackageLock, loadPnpmLock, loadCargoLock,
  SIZE_CAPS,
} from './loaders.js';
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/document-loaders.test.ts`
Expected: PASS (4 new tests).

Run: `npm run build`
Expected: clean compile.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/documents/loaders.ts src/analysis/documents/index.ts tests/document-loaders.test.ts
git commit -m "feat(documents): loaders + size caps for package-lock/pnpm-lock/cargo-lock"
```

---

## Task 5: `QueryEngine.lockfileDeps()` + result type

**Files:**
- Modify: `src/query/engine.ts`
- Test: `tests/lockfile-deps.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/lockfile-deps.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTestDb, seedTestData } from './helpers.js';
import { QueryEngine } from '../src/query/engine.js';
import { resetDocumentCache } from '../src/analysis/documents/cache.js';

function writeTmp(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('QueryEngine.lockfileDeps', () => {
  let tmp: string;

  beforeEach(() => {
    resetDocumentCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lockfile-'));
  });

  it('lists entries from yarn.lock', () => {
    const { db, store } = createTestDb();
    seedTestData(store);
    store.setMeta('root_path', tmp);
    writeTmp(tmp, 'yarn.lock', `# yarn lockfile v1
"react@^18.0.0":
  version "18.2.0"

"lodash@^4.17.0", "lodash@^4.17.21":
  version "4.17.21"
`);
    const engine = new QueryEngine(db);
    const r = engine.lockfileDeps('yarn.lock');
    expect(r.type).toBe('lockfile_deps');
    const [first] = r.results;
    expect(first.kind).toBe('yarn_lock');
    expect(first.entries).toEqual(expect.arrayContaining([
      { name: 'react', version: '18.2.0' },
      { name: 'lodash', version: '4.17.21' },
    ]));
  });

  it('lists entries from package-lock.json', () => {
    const { db, store } = createTestDb();
    seedTestData(store);
    store.setMeta('root_path', tmp);
    writeTmp(tmp, 'package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/react': { version: '18.2.0' },
      },
    }));
    const r = new QueryEngine(db).lockfileDeps('package-lock.json');
    expect(r.results[0].kind).toBe('package_lock');
    expect(r.results[0].entries).toEqual([{ name: 'react', version: '18.2.0' }]);
  });

  it('lists entries from pnpm-lock.yaml', () => {
    const { db, store } = createTestDb();
    seedTestData(store);
    store.setMeta('root_path', tmp);
    writeTmp(tmp, 'pnpm-lock.yaml', `lockfileVersion: '9.0'
packages:
  /react@18.2.0:
    resolution: { integrity: sha512-foo }
`);
    const r = new QueryEngine(db).lockfileDeps('pnpm-lock.yaml');
    expect(r.results[0].kind).toBe('pnpm_lock');
    expect(r.results[0].entries).toEqual([{ name: 'react', version: '18.2.0' }]);
  });

  it('lists entries from Cargo.lock', () => {
    const { db, store } = createTestDb();
    seedTestData(store);
    store.setMeta('root_path', tmp);
    writeTmp(tmp, 'Cargo.lock', `[[package]]
name = "serde"
version = "1.0.195"
`);
    const r = new QueryEngine(db).lockfileDeps('Cargo.lock');
    expect(r.results[0].kind).toBe('cargo_lock');
    expect(r.results[0].entries).toEqual([{ name: 'serde', version: '1.0.195' }]);
  });

  it('filters by name when provided', () => {
    const { db, store } = createTestDb();
    seedTestData(store);
    store.setMeta('root_path', tmp);
    writeTmp(tmp, 'yarn.lock', `# yarn lockfile v1
"react@^18.0.0":
  version "18.2.0"

"lodash@^4.17.0":
  version "4.17.21"
`);
    const r = new QueryEngine(db).lockfileDeps('yarn.lock', 'react');
    expect(r.results[0].entries).toEqual([{ name: 'react', version: '18.2.0' }]);
  });

  it('returns error when file is not a lockfile kind', () => {
    const { db, store } = createTestDb();
    seedTestData(store);
    store.setMeta('root_path', tmp);
    writeTmp(tmp, 'README.md', '# hi\n');
    const r = new QueryEngine(db).lockfileDeps('README.md');
    expect(r.results[0].error).toBe('not a lockfile');
    expect(r.results[0].entries).toEqual([]);
  });

  it('surfaces file_too_large with limit + actual', () => {
    const { db, store } = createTestDb();
    seedTestData(store);
    store.setMeta('root_path', tmp);
    writeTmp(tmp, 'yarn.lock', 'x'.repeat(21 * 1024 * 1024));
    const r = new QueryEngine(db).lockfileDeps('yarn.lock');
    expect(r.results[0].error).toBe('file_too_large');
    expect(r.results[0].limit).toBe(20 * 1024 * 1024);
    expect(typeof r.results[0].actual).toBe('number');
  });

  it('returns error when file does not exist', () => {
    const { db, store } = createTestDb();
    seedTestData(store);
    store.setMeta('root_path', tmp);
    const r = new QueryEngine(db).lockfileDeps('yarn.lock');
    expect(typeof r.results[0].error).toBe('string');
    expect(r.results[0].entries).toEqual([]);
  });
});
```

Run: `npx vitest run tests/lockfile-deps.test.ts`
Expected: FAIL — `engine.lockfileDeps` is not a function.

- [ ] **Step 2: Add to `NexusResultType` union in `src/query/engine.ts`**

Find the existing union (near line 44) and add `'lockfile_deps'`:

```ts
export type NexusResultType =
  | 'symbols' | 'occurrences' | 'edges' | 'importers' | 'tree' | 'stats'
  | 'grep' | 'outline' | 'batch_outline' | 'source' | 'slice' | 'deps'
  | 'callers' | 'pack' | 'changed' | 'diff_outline' | 'signatures'
  | 'unused_exports' | 'kind_index' | 'doc' | 'batch'
  | 'structured_query'
  | 'structured_outline'
  | 'lockfile_deps'
  | 'policy_check';
```

(Keep the real union order/contents — only add `'lockfile_deps'` alongside the other structured types.)

- [ ] **Step 3: Add `LockfileDepsResult` interface near the other structured result types**

```ts
export interface LockfileDepsResult {
  file: string;
  kind: string;
  entries: { name: string; version: string }[];
  error?: string;
  limit?: number;
  actual?: number;
}
```

- [ ] **Step 4: Add loader imports at the top of `src/query/engine.ts`**

Extend the existing `from './analysis/documents/index.js'` import to include:

```ts
import {
  loadPackageJson, loadTsconfig,
  loadGhaWorkflow, loadCargoToml,
  loadGenericJson, loadGenericYaml, loadGenericToml,
  loadYarnLock, loadPackageLock, loadPnpmLock, loadCargoLock,
} from '../analysis/documents/index.js';
```

(Match whatever exact import path the file currently uses — just extend the name list.)

- [ ] **Step 5: Implement `lockfileDeps()` method**

Add inside the `QueryEngine` class, next to `structuredOutline`:

```ts
/**
 * List `{name, version}` entries from a lockfile. Supported kinds:
 *   - yarn.lock
 *   - package-lock.json (lockfileVersion 1/2/3)
 *   - pnpm-lock.yaml (v6+ and legacy v5 keys)
 *   - Cargo.lock
 *
 * If `name` is provided, entries are filtered to exact matches (multiple
 * versions of the same package are preserved).
 */
lockfileDeps(filePath: string, name?: string): NexusResult<LockfileDepsResult> {
  const start = performance.now();
  const root = this.store.getMeta('root_path') ?? '';
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const basename = path.basename(filePath);
  const rel = root ? normalizePath(path.relative(root, absPath)) : normalizePath(filePath);
  const kind = classifyPath(rel, basename, { languages: {} });

  const make = (r: Partial<LockfileDepsResult>): NexusResult<LockfileDepsResult> => {
    const result: LockfileDepsResult = {
      file: filePath, kind: kind.kind, entries: [], ...r,
    };
    return this.wrap('lockfile_deps', `lockfile_deps ${filePath}${name ? ' ' + name : ''}`, [result], start);
  };

  const loaded = loadLockfile(absPath, kind.kind);
  if (loaded === null) return make({ error: 'not a lockfile' });
  const err = asLoadError(loaded);
  if (err) {
    return make({
      error: err.error,
      ...(err.limit !== undefined ? { limit: err.limit } : {}),
      ...(err.actual !== undefined ? { actual: err.actual } : {}),
    });
  }

  const entries = (loaded as { entries: { name: string; version: string }[] }).entries;
  const filtered = name ? entries.filter(e => e.name === name) : entries;
  return make({ entries: filtered });
}
```

- [ ] **Step 6: Add `loadLockfile` helper near `loadStructuredFile`**

```ts
/**
 * Dispatch to the right lockfile loader based on FileKind. Returns:
 *   - ParsedXxxLock on success
 *   - `{ error, limit?, actual? }` on loader error
 *   - `null` if the kind isn't a supported lockfile
 */
function loadLockfile(absPath: string, kindStr: string): unknown {
  switch (kindStr) {
    case 'yarn_lock': return loadYarnLock(absPath);
    case 'package_lock': return loadPackageLock(absPath);
    case 'pnpm_lock': return loadPnpmLock(absPath);
    case 'cargo_lock': return loadCargoLock(absPath);
    default: return null;
  }
}
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/lockfile-deps.test.ts`
Expected: PASS (8 tests).

Run: `npm run build`
Expected: clean compile.

- [ ] **Step 8: Commit**

```bash
git add src/query/engine.ts tests/lockfile-deps.test.ts
git commit -m "feat(query): lockfileDeps engine method (yarn/npm/pnpm/cargo)"
```

---

## Task 6: MCP tool `nexus_lockfile_deps`

**Files:**
- Modify: `src/transports/mcp.ts`
- Modify: `src/query/compact.ts`
- Test: `tests/mcp.test.ts`

- [ ] **Step 1: Write failing tests — append to mcp.test.ts**

```ts
it('registers nexus_lockfile_deps with file + optional name', async () => {
  const { server, close } = await createTestServer();
  const tools = await listTools(server);
  const tool = tools.find(t => t.name === 'nexus_lockfile_deps');
  expect(tool).toBeDefined();
  expect(tool!.inputSchema.required).toEqual(['file']);
  expect(Object.keys(tool!.inputSchema.properties)).toEqual(
    expect.arrayContaining(['file', 'name', 'compact']),
  );
  close();
});

it('dispatches nexus_lockfile_deps to QueryEngine.lockfileDeps', async () => {
  const { server, tmp, close } = await createTestServerWithRoot();
  fs.writeFileSync(path.join(tmp, 'yarn.lock'), `"react@^18.0.0":
  version "18.2.0"
`);
  const response = await callTool(server, 'nexus_lockfile_deps', { file: 'yarn.lock' });
  const parsed = JSON.parse(response.content[0].text);
  expect(parsed.type).toBe('lockfile_deps');
  expect(parsed.results[0].entries).toEqual([{ name: 'react', version: '18.2.0' }]);
  close();
});
```

Use whichever helper names `tests/mcp.test.ts` already exposes (the A3 structured tests are a template; reuse the same helpers — `createTestServer`, `callTool`, `listTools`).

Run: `npx vitest run tests/mcp.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 2: Register tool schema in `setRequestHandler(ListToolsRequestSchema, ...)`**

Add the object entry next to `nexus_structured_outline`:

```ts
{
  name: 'nexus_lockfile_deps',
  description: 'List {name, version} entries from a lockfile. Supported: yarn.lock, package-lock.json (v1/v2/v3), pnpm-lock.yaml, Cargo.lock. Optional name filter returns all versions of that package.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      file: { type: 'string', description: 'Path to the lockfile (relative to repo root or absolute).' },
      name: { type: 'string', description: 'Optional: filter to entries with this exact package name.' },
      ...COMPACT_PROP,
    },
    required: ['file'],
  },
},
```

- [ ] **Step 3: Add dispatch case inside `dispatch(toolName, args)`**

Next to the structured cases:

```ts
case 'nexus_lockfile_deps':
  return qe.lockfileDeps(args.file as string, args.name as string | undefined);
```

- [ ] **Step 4: Extend compact key map in `src/query/compact.ts`**

Add the single new entry (alphabetized, between `value_kind` and whatever follows):

```ts
  value: 'v',
  value_kind: 'vk',
  version: 've',
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS (all existing + 2 new).

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/transports/mcp.ts src/query/compact.ts tests/mcp.test.ts
git commit -m "feat(mcp): register nexus_lockfile_deps tool"
```

---

## Task 7: CLI subcommand `lockfile-deps`

**Files:**
- Modify: `src/transports/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write failing test — append to cli.test.ts**

Follow the existing `structured-query` / `structured-outline` CLI test pattern (spawn the compiled bin with a tmp dir). If the file has a helper to run a compiled subcommand, reuse it. Assert:
- Command exists (exit 0).
- JSON output matches `engine.lockfileDeps` shape.
- `--pretty` prints indented JSON.

```ts
it('runs nexus lockfile-deps against a yarn.lock', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-lockdeps-'));
  fs.writeFileSync(path.join(tmp, 'yarn.lock'), `"react@^18.0.0":
  version "18.2.0"
`);
  // createTestIndex / runCli helpers mirror structured-query test.
  runCli(tmp, ['index']);
  const { stdout, code } = runCli(tmp, ['lockfile-deps', 'yarn.lock']);
  expect(code).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.type).toBe('lockfile_deps');
  expect(parsed.results[0].entries[0].name).toBe('react');
});
```

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — unknown command.

- [ ] **Step 2: Register command in `createProgram()` (near `structured-outline`)**

```ts
program
  .command('lockfile-deps <file> [name]')
  .description('List {name, version} entries from a lockfile (yarn.lock, package-lock.json, pnpm-lock.yaml, Cargo.lock)')
  .option('--pretty', 'Pretty-print JSON')
  .action((file: string, name: string | undefined, opts: { pretty?: boolean }) => {
    const { db } = openQueryDb(process.cwd());
    try {
      const engine = new QueryEngine(db);
      const result = engine.lockfileDeps(file, name);
      printJson(result, !!opts.pretty);
    } finally {
      db.close();
    }
  });
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS.

Run: `npm run build && npm run test`
Expected: full suite green (ignoring pre-existing `.claude/worktrees/*` stale-copy failures, which are not introduced by this work).

- [ ] **Step 4: Commit**

```bash
git add src/transports/cli.ts tests/cli.test.ts
git commit -m "feat(cli): lockfile-deps subcommand"
```

---

## Task 8: Public API re-exports + e2e smoke test

**Files:**
- Modify: `src/index.ts`
- Test: `tests/e2e.test.ts`

- [ ] **Step 1: Extend `tests/e2e.test.ts`**

Append a test mirroring the existing public-API smoke test pattern:

```ts
it('re-exports A3 P2 lockfile helpers from the public API', async () => {
  const api = await import('../src/index.js');
  expect(typeof api.parsePackageLock).toBe('function');
  expect(typeof api.parsePnpmLock).toBe('function');
  expect(typeof api.parseCargoLock).toBe('function');
  expect(typeof api.loadPackageLock).toBe('function');
  expect(typeof api.loadPnpmLock).toBe('function');
  expect(typeof api.loadCargoLock).toBe('function');
});
```

Run: `npx vitest run tests/e2e.test.ts`
Expected: FAIL — symbols not exported.

- [ ] **Step 2: Extend `src/index.ts`**

Extend the document parsers export block:

```ts
export {
  parsePackageJson, parseTsconfig, parseGenericJson,
  parseGhaWorkflow, parseGenericYaml,
  parseCargoToml, parseGenericToml,
  parseYarnLock, parsePackageLock, parsePnpmLock, parseCargoLock,
} from './analysis/documents/index.js';
export type {
  ParsedPackageJson, ParsedTsconfig, ParsedGhaWorkflow, ParsedCargoToml,
  ParsedYarnLock, ParsedPackageLock, ParsedPnpmLock, ParsedCargoLock,
} from './analysis/documents/index.js';
```

Extend the loaders export block:

```ts
export {
  loadPackageJson, loadTsconfig, loadGenericJson,
  loadGhaWorkflow, loadGenericYaml,
  loadCargoToml, loadGenericToml,
  loadYarnLock, loadPackageLock, loadPnpmLock, loadCargoLock,
  SIZE_CAPS,
  getDocumentCache, resetDocumentCache, DocumentCache,
} from './analysis/documents/index.js';
```

Extend the QueryEngine type export block to include `LockfileDepsResult`:

```ts
export type {
  // ...existing types...
  StructuredQueryResult, StructuredOutlineEntry, StructuredOutlineFileResult, StructuredValueKind,
  LockfileDepsResult,
} from './query/engine.js';
```

- [ ] **Step 3: Run tests + typecheck**

Run: `npx vitest run tests/e2e.test.ts && npm run build`
Expected: PASS + clean.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts tests/e2e.test.ts
git commit -m "feat(api): re-export A3 P2 lockfile parsers/loaders + LockfileDepsResult"
```

---

## Task 9: Docs

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`
- Modify: `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md`

- [ ] **Step 1: Prepend a new section to `CHANGELOG.md`**

```md
## [Unreleased] — A3 P2 lockfile_deps

### Added
- `nexus_lockfile_deps(file, name?)` — list `{name, version}` entries from a lockfile. Supported: `yarn.lock`, `package-lock.json` (lockfileVersion 1/2/3), `pnpm-lock.yaml` (v6+ and legacy v5 keys), `Cargo.lock`. Optional `name` filters to matching entries (multiple versions preserved).
- CLI: `nexus lockfile-deps <file> [name]`.
- Parsers: `parsePackageLock`, `parsePnpmLock`, `parseCargoLock` (plus existing `parseYarnLock`).
- Loaders: `loadPackageLock`, `loadPnpmLock`, `loadCargoLock` — each enforces a 20 MB size cap per the V3 spec. Reuse the A2 LRU cache.
- Public re-exports: `LockfileDepsResult`, `Parsed{PackageLock,PnpmLock,CargoLock}`.
- Compact-mode key: `version → ve`.

### Notes
- Query-time only. Lockfile data is not indexed.
- No transitive graph or dedupe — entries are the raw `{name, version}` pairs from the lockfile.
- Parse errors surface as `{ error, ... }` on the single result; `file_too_large` includes `limit` and `actual` bytes.
- Supported lockfile kinds derived from `classifyPath()` exact-basename rules; other lockfiles (Gemfile.lock, go.sum, poetry.lock, …) deferred.
```

- [ ] **Step 2: Update `CLAUDE.md` — extend the Structured files section**

Replace the existing A3 tools bullet block with:

```md
**Structured files (A3):** `nexus_structured_query`, `nexus_structured_outline`, `nexus_lockfile_deps`
```

Under the per-tool descriptions:

```md
- **`nexus_lockfile_deps(file, name?)`** — List `{name, version}` entries from a lockfile. Supported: `yarn.lock`, `package-lock.json` (v1/v2/v3), `pnpm-lock.yaml` (v6+ and legacy), `Cargo.lock`. Optional `name` filters to all versions of one package. Over-cap → `error: 'file_too_large'` with 20 MB limit.
```

- [ ] **Step 3: Annotate the V3 roadmap**

In `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md`, change:

```
- **`nexus_lockfile_deps(file, name?)`** — ships in A3 P2.
```

to:

```
- **`nexus_lockfile_deps(file, name?)`** — ✅ shipped (A3 P2, 2026-04-23).
```

And in the "Ship order" block:

```
- P2: lockfiles. May defer if P0/P1 adoption doesn't validate.
```

to:

```
- P2: lockfiles. ✅ shipped 2026-04-23.
```

- [ ] **Step 4: Final verification**

Run: `npm run build && npm run test`
Expected: clean build; test suite green (modulo the known pre-existing `.claude/worktrees/*` stale-copy failures).

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md CLAUDE.md "C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md"
git commit -m "docs: A3 P2 lockfile_deps shipped"
```

---

## Self-Review Checklist

- **Spec coverage:** V3 A3 P2 line item is `nexus_lockfile_deps(file, name?)`. Covered by Tasks 5–7. Size-cap (20 MB) covered in Task 4. "Query-time, no indexed storage" implicit in the design — the whole flow is `classifyPath → loader → engine method`, never touching the SQLite index.
- **Placeholders:** None. Every step has literal code or a literal command.
- **Type consistency:** `LockfileDepsResult` (Task 5) is used verbatim in mcp.ts dispatch (Task 6), cli.ts subcommand (Task 7), and re-exports (Task 8). Parser return shape `{ entries: {name, version}[] } | { error }` is identical across all four parsers and matches the existing `parseYarnLock` contract.
- **Compat:** Existing `parseYarnLock` / `loadYarnLock` are untouched. All new parsers mirror its shape exactly.
- **Scope discipline:** No new indexed tables. No workspace/monorepo logic. No graph traversal. No line anchors. No extra lockfile formats.
