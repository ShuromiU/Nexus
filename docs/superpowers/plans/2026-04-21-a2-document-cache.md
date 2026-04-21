# A2 — Document Cache + Per-Format Size Caps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the A1 document parsers with an on-disk loader that enforces per-format size caps and caches parsed results in an in-process LRU. A3's upcoming MCP tools consume this surface — they pass `(absPath, FileKind)` and get back a typed parsed value or a structured error.

**Architecture:** New module `src/analysis/documents/cache.ts` owns a singleton LRU (64 entries / 8 MB, whichever fills first) keyed on `(absPath, mtimeMs, size)`. New loader wrappers (`loadPackageJson`, `loadTsconfig`, …) in a new `src/analysis/documents/loaders.ts` read the file, check its size against a per-format cap, then parse and cache. Parsers stay pure and unchanged — this layer sits between them and the filesystem. No content hashing: the spec allows `(path, mtime, size)` alone on the fast path; adding a content hash for mtime-tick races is V4 scope.

**Tech Stack:** TypeScript (strict), Vitest, Node `fs` only. No new runtime deps.

**Spec reference:** [docs/superpowers/plans/2026-04-19-a1-classify-path.md](2026-04-19-a1-classify-path.md) (context) and the V3 roadmap's A2 section ([~/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md](../../../../../Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md), section "A2 — Cache + size caps + support matrix").

---

### File Map

| File | Action | Responsibility |
|---|---|---|
| `src/analysis/documents/cache.ts` | Create | `DocumentCache` class + module singleton + `getDocumentCache()` / `resetDocumentCache()` |
| `src/analysis/documents/loaders.ts` | Create | `loadPackageJson`, `loadTsconfig`, `loadGenericJson`, `loadGhaWorkflow`, `loadGenericYaml`, `loadCargoToml`, `loadGenericToml`, `loadYarnLock` + size-cap constants |
| `src/analysis/documents/index.ts` | Modify | Re-export loaders + cache reset helper |
| `src/index.ts` | Modify | Public re-export of loaders |
| `tests/document-cache.test.ts` | Create | LRU unit suite |
| `tests/document-loaders.test.ts` | Create | Per-format loader suite (fs-backed, uses temp files) |
| `CHANGELOG.md` | Modify | Unreleased entry for A2 |
| `CLAUDE.md` | Modify | Architecture note on the cache + loaders |

---

### Task 1: `DocumentCache` — core LRU with size + count caps

**Files:**
- Create: `src/analysis/documents/cache.ts`
- Create: `tests/document-cache.test.ts`

- [ ] **Step 1: Write the failing test suite**

Create `tests/document-cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { DocumentCache } from '../src/analysis/documents/cache.js';

describe('DocumentCache', () => {
  let cache: DocumentCache;
  beforeEach(() => {
    cache = new DocumentCache({ maxEntries: 4, maxBytes: 1000 });
  });

  it('returns undefined on miss', () => {
    expect(cache.get('/a', 1, 10)).toBeUndefined();
  });

  it('hits when key triple matches', () => {
    cache.set('/a', 100, 50, { value: 1 }, 50);
    expect(cache.get('/a', 100, 50)).toEqual({ value: 1 });
  });

  it('misses when mtime changes', () => {
    cache.set('/a', 100, 50, { value: 1 }, 50);
    expect(cache.get('/a', 101, 50)).toBeUndefined();
  });

  it('misses when size changes', () => {
    cache.set('/a', 100, 50, { value: 1 }, 50);
    expect(cache.get('/a', 100, 51)).toBeUndefined();
  });

  it('re-setting a path replaces its entry (no duplication)', () => {
    cache.set('/a', 100, 50, { v: 1 }, 50);
    cache.set('/a', 200, 60, { v: 2 }, 60);
    expect(cache.get('/a', 100, 50)).toBeUndefined();
    expect(cache.get('/a', 200, 60)).toEqual({ v: 2 });
    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().bytes).toBe(60);
  });

  it('evicts by LRU order when maxEntries exceeded', () => {
    cache.set('/a', 1, 10, 'a', 10);
    cache.set('/b', 1, 10, 'b', 10);
    cache.set('/c', 1, 10, 'c', 10);
    cache.set('/d', 1, 10, 'd', 10);
    // All 4 present.
    expect(cache.get('/a', 1, 10)).toBe('a');
    // Adding a 5th evicts the LRU. /a was just touched, /b is now LRU.
    cache.set('/e', 1, 10, 'e', 10);
    expect(cache.get('/b', 1, 10)).toBeUndefined();
    expect(cache.get('/a', 1, 10)).toBe('a');
    expect(cache.get('/e', 1, 10)).toBe('e');
  });

  it('evicts by LRU order when maxBytes exceeded', () => {
    const c = new DocumentCache({ maxEntries: 100, maxBytes: 100 });
    c.set('/a', 1, 40, 'a', 40);
    c.set('/b', 1, 40, 'b', 40);
    // 80 bytes, fits.
    c.set('/c', 1, 40, 'c', 40);
    // 120 bytes — /a must have been evicted.
    expect(c.get('/a', 1, 40)).toBeUndefined();
    expect(c.get('/b', 1, 40)).toBe('b');
    expect(c.get('/c', 1, 40)).toBe('c');
    expect(c.stats().bytes).toBe(80);
  });

  it('get() promotes entry to most-recently-used', () => {
    cache.set('/a', 1, 10, 'a', 10);
    cache.set('/b', 1, 10, 'b', 10);
    cache.set('/c', 1, 10, 'c', 10);
    cache.set('/d', 1, 10, 'd', 10);
    // /a is LRU. Touch it — now /b is LRU.
    cache.get('/a', 1, 10);
    cache.set('/e', 1, 10, 'e', 10);
    expect(cache.get('/b', 1, 10)).toBeUndefined();
    expect(cache.get('/a', 1, 10)).toBe('a');
  });

  it('clear() empties the cache', () => {
    cache.set('/a', 1, 10, 'a', 10);
    cache.set('/b', 1, 10, 'b', 10);
    cache.clear();
    expect(cache.get('/a', 1, 10)).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it('rejects entries larger than maxBytes outright', () => {
    const c = new DocumentCache({ maxEntries: 10, maxBytes: 50 });
    c.set('/big', 1, 100, 'big', 100);
    // Oversized entry is silently dropped — cache stays empty.
    expect(c.get('/big', 1, 100)).toBeUndefined();
    expect(c.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/document-cache.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `DocumentCache`**

Create `src/analysis/documents/cache.ts`:

```typescript
export interface CacheOptions {
  maxEntries: number;
  maxBytes: number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  value: unknown;
  bytes: number;
}

/**
 * In-process LRU for parsed document values. Keyed on absolute path; an entry
 * is considered a hit only when both mtimeMs and size also match — a classic
 * "fast path" that never reads the file.
 *
 * Two budgets enforce eviction: entry count and total bytes. Whichever is
 * exceeded first, we evict least-recently-used entries until both fit.
 * An individual set() that exceeds maxBytes on its own is silently rejected.
 *
 * Byte accounting is caller-supplied (see loaders.ts) — typically the length
 * of the original file content, since parsed object size is hard to estimate
 * in JS and content length is a close enough proxy.
 */
export class DocumentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: CacheOptions) {
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
  }

  get(absPath: string, mtimeMs: number, size: number): unknown | undefined {
    const entry = this.entries.get(absPath);
    if (!entry) return undefined;
    if (entry.mtimeMs !== mtimeMs || entry.size !== size) return undefined;
    // Promote to MRU — delete + set preserves insertion order.
    this.entries.delete(absPath);
    this.entries.set(absPath, entry);
    return entry.value;
  }

  set(
    absPath: string,
    mtimeMs: number,
    size: number,
    value: unknown,
    bytes: number,
  ): void {
    if (bytes > this.maxBytes) return;

    const existing = this.entries.get(absPath);
    if (existing) {
      this.totalBytes -= existing.bytes;
      this.entries.delete(absPath);
    }

    this.entries.set(absPath, { mtimeMs, size, value, bytes });
    this.totalBytes += bytes;

    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value)!;
      this.entries.delete(oldest.value);
      this.totalBytes -= evicted.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.totalBytes };
  }
}

const DEFAULT_OPTIONS: CacheOptions = {
  maxEntries: 64,
  maxBytes: 8 * 1024 * 1024,
};

let singleton: DocumentCache | null = null;

/**
 * Module-wide document cache. Lazily created on first access.
 * Tests should call resetDocumentCache() between cases to avoid cross-talk.
 */
export function getDocumentCache(): DocumentCache {
  if (singleton === null) singleton = new DocumentCache(DEFAULT_OPTIONS);
  return singleton;
}

export function resetDocumentCache(): void {
  singleton = null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/document-cache.test.ts`
Expected: PASS — all 10 cases.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/documents/cache.ts tests/document-cache.test.ts
git commit -m "feat(documents): DocumentCache — LRU with entry + byte budgets"
```

---

### Task 2: Per-format loaders — `loadPackageJson`, `loadTsconfig`, `loadGenericJson`

**Files:**
- Create: `src/analysis/documents/loaders.ts` (grows across tasks 2-4)
- Create: `tests/document-loaders.test.ts`

- [ ] **Step 1: Write the failing test suite**

Create `tests/document-loaders.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadPackageJson, loadTsconfig, loadGenericJson,
} from '../src/analysis/documents/loaders.js';
import { getDocumentCache, resetDocumentCache } from '../src/analysis/documents/cache.js';

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

  it('caches parsed results — second call doesn\'t re-read the file', () => {
    const p = write('package.json', JSON.stringify({ name: 'foo' }));
    const r1 = loadPackageJson(p);
    // Delete file; warm cache should still serve the parsed value because the
    // stat hasn't changed on the next call... but the file is gone, so we
    // can't call stat. Instead, mutate the file in place and check the cache
    // returns the OLD parsed value because mtime+size lookup still matches.
    // Actually the cleanest test: overwrite with garbage but preserve mtime/size.
    const stat = fs.statSync(p);
    fs.writeFileSync(p, 'x'.repeat(stat.size));
    fs.utimesSync(p, stat.atime, stat.mtime);
    const r2 = loadPackageJson(p);
    // Both should agree because cache key matches.
    expect(r1).toEqual(r2);
  });

  it('invalidates cache when mtime changes', () => {
    const p = write('package.json', JSON.stringify({ name: 'foo' }));
    const r1 = loadPackageJson(p);
    if ('error' in r1) throw new Error(r1.error);
    expect(r1.name).toBe('foo');
    // Rewrite with new content + a later mtime.
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/document-loaders.test.ts`
Expected: FAIL — `loaders.js` module doesn't exist.

- [ ] **Step 3: Implement the JSON-family loaders**

Create `src/analysis/documents/loaders.ts`:

```typescript
import * as fs from 'node:fs';
import { parsePackageJson, type ParsedPackageJson } from './package-json.js';
import { parseTsconfig, type ParsedTsconfig } from './tsconfig.js';
import { parseGenericJson } from './generic-json.js';
import { getDocumentCache } from './cache.js';

/**
 * Per-format size caps (bytes). Enforced by loaders before parse.
 * Over-cap → `{ error: 'file_too_large', limit, actual }`.
 */
export const SIZE_CAPS = {
  package_json: 1 * 1024 * 1024,
  tsconfig_json: 1 * 1024 * 1024,
  cargo_toml: 1 * 1024 * 1024,
  gha_workflow: 1 * 1024 * 1024,
  json_generic: 5 * 1024 * 1024,
  yaml_generic: 5 * 1024 * 1024,
  toml_generic: 5 * 1024 * 1024,
  yarn_lock: 20 * 1024 * 1024,
} as const;

/**
 * Unified error shape for loaders. Parse errors and fs errors carry just
 * `error`; the oversized case carries `error: 'file_too_large'` plus `limit`
 * and `actual`. Callers narrow on `error === 'file_too_large'`.
 */
export type LoadError = {
  error: string;
  limit?: number;
  actual?: number;
};

function loadCached<T>(
  absPath: string,
  limit: number,
  parse: (content: string) => T,
): T | LoadError {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'stat failed' };
  }
  if (!stat.isFile()) return { error: 'not a regular file' };
  if (stat.size > limit) {
    return { error: 'file_too_large', limit, actual: stat.size };
  }

  const cache = getDocumentCache();
  const cached = cache.get(absPath, stat.mtimeMs, stat.size) as T | undefined;
  if (cached !== undefined) return cached;

  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'read failed' };
  }

  const parsed = parse(content);
  // Cache parse errors too — same input yields the same error, and re-parsing
  // a 4 MB malformed doc on every call wastes cycles. Any edit bumps mtime
  // and invalidates the entry, so stale errors aren't a concern.
  cache.set(absPath, stat.mtimeMs, stat.size, parsed, content.length);
  return parsed;
}

export function loadPackageJson(absPath: string): ParsedPackageJson | LoadError {
  return loadCached(absPath, SIZE_CAPS.package_json, parsePackageJson);
}

export function loadTsconfig(absPath: string): ParsedTsconfig | LoadError {
  return loadCached(absPath, SIZE_CAPS.tsconfig_json, parseTsconfig);
}

export function loadGenericJson(absPath: string): unknown | LoadError {
  return loadCached(absPath, SIZE_CAPS.json_generic, parseGenericJson);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/document-loaders.test.ts`
Expected: PASS — cases covering JSON-family loaders.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/documents/loaders.ts tests/document-loaders.test.ts
git commit -m "feat(documents): JSON-family loaders with size caps + LRU cache"
```

---

### Task 3: YAML + TOML loaders

**Files:**
- Modify: `src/analysis/documents/loaders.ts`
- Modify: `tests/document-loaders.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/document-loaders.test.ts`:

```typescript
import {
  loadGhaWorkflow, loadGenericYaml, loadCargoToml, loadGenericToml,
} from '../src/analysis/documents/loaders.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/document-loaders.test.ts`
Expected: FAIL — new loader imports don't exist.

- [ ] **Step 3: Extend `loaders.ts`**

Append to `src/analysis/documents/loaders.ts` (after the imports, insert new imports; after `loadGenericJson`, add the new loaders):

```typescript
// Add near existing imports:
import { parseGhaWorkflow, type ParsedGhaWorkflow } from './gha-workflow.js';
import { parseGenericYaml } from './generic-yaml.js';
import { parseCargoToml, type ParsedCargoToml } from './cargo-toml.js';
import { parseGenericToml } from './generic-toml.js';
```

```typescript
// Add after loadGenericJson:

export function loadGhaWorkflow(absPath: string): ParsedGhaWorkflow | LoadError {
  return loadCached(absPath, SIZE_CAPS.gha_workflow, parseGhaWorkflow);
}

export function loadGenericYaml(absPath: string): unknown | LoadError {
  return loadCached(absPath, SIZE_CAPS.yaml_generic, parseGenericYaml);
}

export function loadCargoToml(absPath: string): ParsedCargoToml | LoadError {
  return loadCached(absPath, SIZE_CAPS.cargo_toml, parseCargoToml);
}

export function loadGenericToml(absPath: string): unknown | LoadError {
  return loadCached(absPath, SIZE_CAPS.toml_generic, parseGenericToml);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/document-loaders.test.ts`
Expected: PASS — cumulative cases.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/documents/loaders.ts tests/document-loaders.test.ts
git commit -m "feat(documents): YAML + TOML loaders with size caps"
```

---

### Task 4: `loadYarnLock`

**Files:**
- Modify: `src/analysis/documents/loaders.ts`
- Modify: `tests/document-loaders.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/document-loaders.test.ts`:

```typescript
import { loadYarnLock } from '../src/analysis/documents/loaders.js';

describe('loadYarnLock', () => {
  it('reads and parses a yarn v1 lockfile', () => {
    const src = `# yarn lockfile v1

"react@^18.0.0":
  version "18.2.0"

"@types/node@^20.0.0":
  version "20.10.5"
`;
    const p = write('yarn.lock', src);
    const r = loadYarnLock(p);
    if ('error' in r) throw new Error(r.error);
    expect(r.entries).toContainEqual({ name: 'react', version: '18.2.0' });
    expect(r.entries).toContainEqual({ name: '@types/node', version: '20.10.5' });
  });

  it('enforces the 20 MB cap', () => {
    // 21 MB of harmless padding above a tiny valid entry.
    const padding = 'x'.repeat(21 * 1024 * 1024);
    const p = write('yarn.lock', padding);
    const r = loadYarnLock(p);
    if (!('error' in r)) throw new Error('should have errored');
    expect(r.error).toBe('file_too_large');
    if ('limit' in r) expect(r.limit).toBe(20 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/document-loaders.test.ts`
Expected: FAIL — `loadYarnLock` doesn't exist.

- [ ] **Step 3: Implement `loadYarnLock`**

Append to `src/analysis/documents/loaders.ts`:

```typescript
import { parseYarnLock, type ParsedYarnLock } from './yarn-lock.js';
```

(Add to the imports block alongside the others.)

```typescript
// After loadGenericToml:

export function loadYarnLock(absPath: string): ParsedYarnLock | LoadError {
  return loadCached(absPath, SIZE_CAPS.yarn_lock, parseYarnLock);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/document-loaders.test.ts`
Expected: PASS — all loader tests.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/documents/loaders.ts tests/document-loaders.test.ts
git commit -m "feat(documents): yarn.lock loader with 20 MB cap"
```

---

### Task 5: Public re-exports

**Files:**
- Modify: `src/analysis/documents/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Update `documents/index.ts`**

Open `src/analysis/documents/index.ts`. Append below the existing parser exports:

```typescript
// Loaders (A2) — read + size-cap + parse + cache.
export {
  loadPackageJson, loadTsconfig, loadGenericJson,
  loadGhaWorkflow, loadGenericYaml,
  loadCargoToml, loadGenericToml,
  loadYarnLock,
  SIZE_CAPS,
} from './loaders.js';
export type { LoadError } from './loaders.js';
export {
  getDocumentCache, resetDocumentCache, DocumentCache,
} from './cache.js';
export type { CacheOptions } from './cache.js';
```

- [ ] **Step 2: Update `src/index.ts`**

Locate the block introduced in A1:

```typescript
// Document parsers (structured config / lockfile helpers — consumed by A3)
export {
  parsePackageJson, parseTsconfig, parseGenericJson,
  parseGhaWorkflow, parseGenericYaml,
  parseCargoToml, parseGenericToml,
  parseYarnLock,
} from './analysis/documents/index.js';
export type {
  ParsedPackageJson, ParsedTsconfig, ParsedGhaWorkflow, ParsedCargoToml, ParsedYarnLock,
} from './analysis/documents/index.js';
```

Append immediately after:

```typescript
// Document loaders + cache (A2) — fs-aware, size-capped, cached.
export {
  loadPackageJson, loadTsconfig, loadGenericJson,
  loadGhaWorkflow, loadGenericYaml,
  loadCargoToml, loadGenericToml,
  loadYarnLock,
  SIZE_CAPS,
  getDocumentCache, resetDocumentCache, DocumentCache,
} from './analysis/documents/index.js';
export type {
  LoadError, CacheOptions,
} from './analysis/documents/index.js';
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all existing tests + new A2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/documents/index.ts src/index.ts
git commit -m "feat(documents): public re-exports for loaders and cache"
```

---

### Task 6: Docs + final verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add CHANGELOG entry**

At the top of `CHANGELOG.md`, above the existing A1 Unreleased block, add:

```markdown
## [Unreleased] — document cache + per-format size caps (A2)

### Added
- `src/analysis/documents/cache.ts` — `DocumentCache` LRU (64 entries / 8 MB), module singleton via `getDocumentCache()`. Keyed on `(absPath, mtimeMs, size)`; no content hashing on the fast path.
- `src/analysis/documents/loaders.ts` — `loadPackageJson`, `loadTsconfig`, `loadGenericJson`, `loadGhaWorkflow`, `loadGenericYaml`, `loadCargoToml`, `loadGenericToml`, `loadYarnLock`. Each enforces a per-format byte cap before parse; over-cap returns `{ error: 'file_too_large', limit, actual }`.
- Per-format size caps (`SIZE_CAPS`): 1 MB for `package.json` / `tsconfig.json` / `Cargo.toml` / GHA workflows; 5 MB for generic JSON/YAML/TOML; 20 MB for `yarn.lock`.

### Notes
- Pure infrastructure for A3. No new MCP tools, no CLI surface. Parsers themselves are unchanged.
- Parse errors are cached alongside successes — same malformed input yields the same error without re-parsing.

---
```

- [ ] **Step 2: Update `CLAUDE.md` architecture section**

In the `src/` tree, under the existing `analysis/documents/` line, edit the description to mention the cache + loaders:

```markdown
    documents/     — Structured-file parsers + fs-aware loaders (size caps + LRU cache). Consumed by A3.
```

- [ ] **Step 3: Full verification pass**

Run each:

```bash
npm run build
npm run lint
npm test
```

Expected: build clean, `tsc --noEmit` clean, all tests pass (existing ~all + new ~25 A2 cases).

- [ ] **Step 4: Self-re-index**

```bash
npx --no -- nexus rebuild
npx --no -- nexus stats
```

Expected: rebuild succeeds (no schema bump — A2 is in-memory only). Same file count as before A2.

- [ ] **Step 5: Commit docs**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: A2 document cache + size caps in CHANGELOG and architecture"
```

- [ ] **Step 6: Final status check**

```bash
git log --oneline main..HEAD
git status
```

Expected: 6 feat/docs commits on top of main's merge base from A2; clean working tree. Branch ready for PR (or merge into a branch shared with A3).

---

## Notes for the Implementing Engineer

- **No new deps.** `jsonc-parser`, `yaml`, `smol-toml` landed in A1. A2 is pure TypeScript + node:fs.
- **Cache keys deliberately omit content hash.** The V3 spec allows this — the race where two writes land in the same mtime tick with identical size is extremely rare and is future work. Don't add it here.
- **Parse errors cached, not suppressed.** If the user's `tsconfig.json` is malformed, caching the `{ error }` result saves re-parsing on the next call until they fix the file (which bumps mtime and invalidates the entry anyway).
- **Byte budget is content-length, not parsed-object-size.** Estimating parsed JS heap size is hard; content length is a close-enough proxy and fast.
- **`getDocumentCache()` is a module singleton.** Tests MUST call `resetDocumentCache()` between cases or they'll cross-contaminate.
- **No MCP tools here.** A3 owns the MCP surface. Loaders are library-level only.
- **Lockfile caps (`package_lock`, `pnpm_lock`, `cargo_lock`) deliberately omitted from `SIZE_CAPS` in A2** — their parsers don't exist yet (A3 P2 or beyond). Adding the cap without a parser is dead code. When those parsers land, extend `SIZE_CAPS` and add a loader then.

## Success Criteria Checklist

- [ ] `DocumentCache` unit tests cover hit/miss/mtime-invalidation/count-LRU/byte-LRU/oversized-entry/clear.
- [ ] Every loader returns `{ error: 'file_too_large', limit, actual }` when the file exceeds its format's cap.
- [ ] Second call to the same loader for the same unchanged file returns the cached parsed value without re-reading.
- [ ] Modifying a file (new mtime) invalidates its cache entry and a subsequent call reflects the new content.
- [ ] `loaders.ts` has no new npm deps beyond A1.
- [ ] `npm run build`, `npm run lint`, `npm test` all clean.
- [ ] CHANGELOG + CLAUDE.md updated.
- [ ] Nexus self-rebuild still indexes the same file set (no behavior change for source indexing).
