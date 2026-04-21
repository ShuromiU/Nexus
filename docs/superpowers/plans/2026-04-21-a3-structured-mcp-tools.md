# A3 — Structured Document MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two MCP tools that let agents query structured config files (package.json, tsconfig, Cargo.toml, GHA workflows, and generic JSON/YAML/TOML) without reading them: `nexus_structured_query(file, path)` extracts one value by dotted path; `nexus_structured_outline(file)` returns top-level keys + value kinds. Consumes A2's loaders; no index storage.

**Architecture:** New QueryEngine methods `structuredQuery()` and `structuredOutline()`. Both classify the requested path via `classifyPath()`, dispatch to the matching A2 loader, then operate on the parsed value. No line anchors in V3 per the spec. New result types wrap single-value responses in the standard `NexusResult` envelope. MCP tools + CLI commands mirror the existing tool patterns.

**Tech Stack:** TypeScript (strict), Vitest, no new deps.

**Spec reference:** V3 roadmap section "A3 — MCP tools (query-time)" in [~/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md](../../../../../Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md). P2 (`nexus_lockfile_deps`) deferred per spec's "may defer" clause.

---

### Scope Decisions

- **P0 + P1 together.** The two tools dispatch on `FileKind`; adding P1 kinds (`json_generic`, `yaml_generic`, `toml_generic`) is one extra case each. Ship as one unit.
- **P2 deferred.** `nexus_lockfile_deps` is a different tool shape (list, not single value). Separate plan when adopted.
- **Path syntax: dotted, array indices as numeric segments.** `compilerOptions.strict`, `dependencies.react`, `jobs.test.steps.0.run`. Keys containing dots or brackets are NOT supported — document and punt. Workaround: use the outline tool to confirm structure.
- **No line anchors.** V3 ships keys + value kinds + short preview. Anchors are parser-library work (`yaml` CST, etc.) and out of A3 scope.
- **No `json_query` alias.** The spec mentions preserving `nexus_json_query` as an alias, but it never shipped in any prior release. Skip — adding an alias for a non-existent predecessor is noise.
- **Structured file lookup is by exact path (relative to `root_path` or absolute).** Not `findFile()`-style fuzzy matching. Structured files aren't indexed; fuzzy lookup would require a directory walk on every call.

---

### File Map

| File | Action | Responsibility |
|---|---|---|
| `src/query/engine.ts` | Modify | Add result types + `structuredQuery()` + `structuredOutline()` + `'structured_query'` / `'structured_outline'` in `NexusResultType` union |
| `src/query/compact.ts` | Modify | Key mapping for the two new result shapes |
| `src/transports/mcp.ts` | Modify | Two new tool schemas + dispatcher cases |
| `src/transports/cli.ts` | Modify | Two new CLI commands + formatters |
| `src/index.ts` | Modify | Re-export the two new result interfaces |
| `tests/structured-query.test.ts` | Create | Unit suite for the engine methods |
| `tests/mcp.test.ts` | Modify | Add MCP dispatch coverage for the two tools |
| `CHANGELOG.md` | Modify | Unreleased A3 entry |
| `CLAUDE.md` | Modify | Two new MCP tools listed |

---

### Task 1: Engine methods + result types

**Files:**
- Modify: `src/query/engine.ts`
- Create: `tests/structured-query.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/structured-query.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, applySchema, initializeMeta } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import { QueryEngine } from '../src/query/engine.js';
import { resetDocumentCache } from '../src/analysis/documents/cache.js';

let tmpRoot: string;
let db: Database.Database;
let engine: QueryEngine;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-a3-'));
  db = openDatabase(':memory:');
  applySchema(db);
  initializeMeta(db, { rootPath: tmpRoot, caseSensitive: true, configHash: 'x' });
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
    expect(r.results[0]).toMatchObject({ found: false, error: expect.stringContaining('not a structured') });
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/structured-query.test.ts`
Expected: FAIL — `structuredQuery` / `structuredOutline` methods don't exist.

- [ ] **Step 3: Add result types + methods**

Open `src/query/engine.ts`.

**Extend `NexusResultType` (line 15):**

```typescript
// Before:
export type NexusResultType =
  | 'find'
  // ...
  | 'batch';

// After:
export type NexusResultType =
  | 'find'
  // ...
  | 'batch'
  | 'structured_query'
  | 'structured_outline';
```

**Add new result interfaces** (before the `// ── Query Engine ──` divider, around line 290):

```typescript
export interface StructuredQueryResult {
  file: string;
  path: string;
  kind: string;          // FileKind discriminant
  found: boolean;
  value?: unknown;       // omitted when !found
  error?: string;        // 'file_too_large', 'not a structured file', parse error, fs error
  limit?: number;        // populated when error === 'file_too_large'
  actual?: number;       // populated when error === 'file_too_large'
}

export type StructuredValueKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface StructuredOutlineEntry {
  key: string;
  value_kind: StructuredValueKind;
  preview?: string;      // short preview for scalars (≤80 chars)
  length?: number;       // populated for arrays
}

export interface StructuredOutlineFileResult {
  file: string;
  kind: string;          // FileKind discriminant, or '' on error
  entries: StructuredOutlineEntry[];
  error?: string;
}
```

**Add imports near the top of the file:**

```typescript
import { classifyPath } from '../workspace/classify.js';
import { loadConfig } from '../config.js';
import {
  loadPackageJson, loadTsconfig, loadGenericJson,
  loadGhaWorkflow, loadGenericYaml,
  loadCargoToml, loadGenericToml,
} from '../analysis/documents/index.js';
```

**Add the two methods to the `QueryEngine` class** (just before the existing `private wrap<T>(` method near line 1797):

```typescript
  /**
   * Read a structured file and extract the value at a dotted path.
   * Path syntax: dotted keys; numeric segments index into arrays.
   *   "scripts.test", "dependencies.react", "jobs.test.steps.0.run"
   * Keys containing dots or brackets are not supported in V3.
   */
  structuredQuery(filePath: string, queryPath: string): NexusResult<StructuredQueryResult> {
    const start = performance.now();
    const root = this.store.getMeta('root_path') ?? '';
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
    const basename = path.basename(filePath);

    // No config overrides here — we don't honor custom source-extension mappings
    // for structured-file classification (keep it predictable).
    const kind = classifyPath(
      normalizePath(path.relative(root, absPath)) || normalizePath(filePath),
      basename,
      { languages: {} },
    );

    const make = (r: Partial<StructuredQueryResult>): NexusResult<StructuredQueryResult> => {
      const result: StructuredQueryResult = {
        file: filePath, path: queryPath, kind: kind.kind, found: false, ...r,
      };
      return this.wrap('structured_query', `structured_query ${filePath} ${queryPath}`, [result], start);
    };

    const loaded = loadStructuredFile(absPath, kind.kind);
    if (loaded === null) {
      return make({ error: 'not a structured file' });
    }
    if (loaded && typeof loaded === 'object' && 'error' in loaded && typeof (loaded as { error: unknown }).error === 'string') {
      const err = loaded as { error: string; limit?: number; actual?: number };
      return make({
        error: err.error,
        ...(err.limit !== undefined ? { limit: err.limit } : {}),
        ...(err.actual !== undefined ? { actual: err.actual } : {}),
      });
    }

    const value = resolveDottedPath(loaded, queryPath);
    if (value === undefined) return make({ found: false });
    return make({ found: true, value });
  }

  /**
   * Read a structured file and list its top-level keys with value kinds.
   * Shallow only — no recursion, no line anchors (V3 spec defers anchors).
   */
  structuredOutline(filePath: string): NexusResult<StructuredOutlineFileResult> {
    const start = performance.now();
    const root = this.store.getMeta('root_path') ?? '';
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
    const basename = path.basename(filePath);

    const kind = classifyPath(
      normalizePath(path.relative(root, absPath)) || normalizePath(filePath),
      basename,
      { languages: {} },
    );

    const make = (r: Partial<StructuredOutlineFileResult>): NexusResult<StructuredOutlineFileResult> => {
      const result: StructuredOutlineFileResult = {
        file: filePath, kind: kind.kind, entries: [], ...r,
      };
      return this.wrap('structured_outline', `structured_outline ${filePath}`, [result], start);
    };

    const loaded = loadStructuredFile(absPath, kind.kind);
    if (loaded === null) return make({ error: 'not a structured file' });
    if (loaded && typeof loaded === 'object' && 'error' in loaded && typeof (loaded as { error: unknown }).error === 'string') {
      return make({ error: (loaded as { error: string }).error });
    }

    if (loaded === undefined || loaded === null || typeof loaded !== 'object') {
      return make({ error: 'root is not a mapping' });
    }

    // Arrays at the root (rare — `toml`/`yaml` with top-level sequences) map to
    // numeric-keyed entries.
    const entries: StructuredOutlineEntry[] = [];
    if (Array.isArray(loaded)) {
      for (let i = 0; i < loaded.length; i++) {
        entries.push(describeEntry(String(i), loaded[i]));
      }
    } else {
      for (const [k, v] of Object.entries(loaded as Record<string, unknown>)) {
        entries.push(describeEntry(k, v));
      }
    }
    return make({ entries });
  }
```

**Add module-level helpers** (at the bottom of the file, after the existing `function getSlicePreferenceScore` around line 1920):

```typescript
/**
 * Dispatch to the right A2 loader based on FileKind. Returns:
 *   - parsed value on success (object / array / scalar / null)
 *   - `{ error, limit?, actual? }` on loader error
 *   - `null` if the kind isn't a supported structured file
 */
function loadStructuredFile(absPath: string, kindStr: string): unknown {
  switch (kindStr) {
    case 'package_json': return loadPackageJson(absPath);
    case 'tsconfig_json': return loadTsconfig(absPath);
    case 'cargo_toml': return loadCargoToml(absPath);
    case 'gha_workflow': return loadGhaWorkflow(absPath);
    case 'json_generic': return loadGenericJson(absPath);
    case 'yaml_generic': return loadGenericYaml(absPath);
    case 'toml_generic': return loadGenericToml(absPath);
    default: return null;
  }
}

/**
 * Walk a dotted path ("a.b.0.c") into a parsed structured value.
 * Numeric segments index into arrays when the current node is an array;
 * otherwise they're treated as object keys (so `{"0":"x"}.0` works).
 * Returns undefined on any missing step.
 */
function resolveDottedPath(root: unknown, dotted: string): unknown {
  const parts = dotted.split('.').filter(p => p.length > 0);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function describeEntry(key: string, value: unknown): StructuredOutlineEntry {
  const kind = valueKind(value);
  const entry: StructuredOutlineEntry = { key, value_kind: kind };
  if (kind === 'array' && Array.isArray(value)) entry.length = value.length;
  const preview = makePreview(value, kind);
  if (preview !== null) entry.preview = preview;
  return entry;
}

function valueKind(v: unknown): StructuredValueKind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  if (t === 'object') return 'object';
  return 'null';
}

function makePreview(v: unknown, kind: StructuredValueKind): string | null {
  switch (kind) {
    case 'string': return JSON.stringify((v as string).length > 78 ? (v as string).slice(0, 75) + '...' : v);
    case 'number':
    case 'boolean':
    case 'null':
      return JSON.stringify(v);
    case 'array':
    case 'object':
      return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/structured-query.test.ts`
Expected: PASS — all cases for both methods.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/query/engine.ts tests/structured-query.test.ts
git commit -m "feat(query): structuredQuery + structuredOutline engine methods"
```

---

### Task 2: MCP tool registration + dispatcher

**Files:**
- Modify: `src/transports/mcp.ts`
- Modify: `tests/mcp.test.ts`

- [ ] **Step 1: Inspect existing mcp test pattern**

Open `tests/mcp.test.ts` — note the pattern: each test creates an isolated MCP server instance, sends a tool-call JSON-RPC message, asserts on the response shape.

- [ ] **Step 2: Write the failing tests**

Append to `tests/mcp.test.ts` (keep imports consistent with the existing style — reuse whatever helper is already defined to construct a server + call a tool). If the file uses `callTool(server, name, args)` or similar, mirror it exactly.

```typescript
// Inside the existing describe block, or as a new one if the existing tests
// group by tool:
describe('nexus_structured_query / nexus_structured_outline', () => {
  // Use whatever fixture helpers the existing mcp test suite already has.
  // Pattern: instantiate engine over a temp dir, write a package.json, call
  // the tool, assert on the result shape. If the suite doesn't already have
  // a temp-dir helper, skip the MCP-level assertion and rely on the direct
  // engine tests in tests/structured-query.test.ts — this task is primarily
  // about tool registration, not redundant coverage.
});
```

**Important:** if adding MCP-level tests duplicates what `tests/structured-query.test.ts` already covers, keep this task focused on **tool registration** — a smoke test that the tool names are listed and the dispatcher routes correctly is enough. Don't re-test engine logic through the MCP layer.

Concrete smoke test:

```typescript
it('registers nexus_structured_query and nexus_structured_outline', async () => {
  const server = createMcpServer();
  const response = await (server as unknown as {
    _requestHandlers: Map<string, (req: unknown) => Promise<{ tools: { name: string }[] }>>;
  })._requestHandlers.get('tools/list')!({ method: 'tools/list', params: {} });
  const names = (response.tools ?? []).map(t => t.name);
  expect(names).toContain('nexus_structured_query');
  expect(names).toContain('nexus_structured_outline');
});
```

(If the existing suite uses a different introspection pattern, copy that pattern.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/mcp.test.ts`
Expected: FAIL — tools not yet registered.

- [ ] **Step 4: Register tools + add dispatcher cases**

In `src/transports/mcp.ts`:

**Inside the `ListToolsRequestSchema` handler's `tools` array**, add after the existing `nexus_doc` entry (or wherever A3-style tools belong):

```typescript
{
  name: 'nexus_structured_query',
  description: 'Extract a single value from a structured config file (package.json, tsconfig, Cargo.toml, GHA workflow, generic JSON/YAML/TOML). Path uses dotted keys with numeric array indices: "scripts.test", "jobs.test.steps.0.run". Avoids reading the whole file.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      file: { type: 'string', description: 'Path to the structured file (relative to repo root or absolute).' },
      path: { type: 'string', description: 'Dotted path into the parsed value. Numeric segments index into arrays.' },
      ...COMPACT_PROP,
    },
    required: ['file', 'path'],
  },
},
{
  name: 'nexus_structured_outline',
  description: 'List top-level keys of a structured file with their value kinds (string, number, boolean, null, array, object). Short previews for scalars; array length for arrays. Avoids reading the whole file.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      file: { type: 'string', description: 'Path to the structured file (relative to repo root or absolute).' },
      ...COMPACT_PROP,
    },
    required: ['file'],
  },
},
```

**Inside `dispatch()` (around line 503)**, add two cases before the `default:`:

```typescript
case 'nexus_structured_query':
  return qe.structuredQuery(args.file as string, args.path as string);
case 'nexus_structured_outline':
  return qe.structuredOutline(args.file as string);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/mcp.test.ts`
Expected: PASS.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/transports/mcp.ts tests/mcp.test.ts
git commit -m "feat(mcp): register nexus_structured_query and nexus_structured_outline"
```

---

### Task 3: CLI commands + formatters

**Files:**
- Modify: `src/transports/cli.ts`

- [ ] **Step 1: Inspect the existing CLI pattern**

Open `src/transports/cli.ts`. Locate (a) the `createProgram()` function and (b) where existing subcommands like `outline`, `source`, `find` are defined. Copy their structure.

- [ ] **Step 2: Add two subcommands**

Inside `createProgram()`, after the existing `doc` or `kind-index` subcommand (whichever is last in the "query" group):

```typescript
program
  .command('structured-query')
  .description('Extract a value from a structured config file by dotted path.')
  .argument('<file>', 'Path to the structured file (relative to repo root or absolute)')
  .argument('<path>', 'Dotted path into the parsed value (e.g. "compilerOptions.strict")')
  .option('--json', 'Output raw JSON instead of the formatted view')
  .action((file: string, queryPath: string, opts: { json?: boolean }) => {
    const qe = getEngine();
    const result = qe.structuredQuery(file, queryPath);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(formatStructuredQuery(result));
  });

program
  .command('structured-outline')
  .description('List top-level keys of a structured config file with value kinds.')
  .argument('<file>', 'Path to the structured file (relative to repo root or absolute)')
  .option('--json', 'Output raw JSON instead of the formatted view')
  .action((file: string, opts: { json?: boolean }) => {
    const qe = getEngine();
    const result = qe.structuredOutline(file);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(formatStructuredOutline(result));
  });
```

**Add formatters at the bottom of `cli.ts`** (after the existing `formatXxx` exports):

```typescript
export function formatStructuredQuery(
  result: NexusResult<StructuredQueryResult>,
): string {
  if (result.count === 0) return '(no result)';
  const r = result.results[0];
  if (r.error) {
    if (r.error === 'file_too_large') {
      return `error: ${r.file}: file_too_large (actual ${r.actual} > limit ${r.limit})`;
    }
    return `error: ${r.file}: ${r.error}`;
  }
  if (!r.found) return `${r.file} [${r.kind}]\n  ${r.path}: (not found)`;
  return `${r.file} [${r.kind}]\n  ${r.path}: ${JSON.stringify(r.value, null, 2)}`;
}

export function formatStructuredOutline(
  result: NexusResult<StructuredOutlineFileResult>,
): string {
  if (result.count === 0) return '(no result)';
  const r = result.results[0];
  if (r.error) return `error: ${r.file}: ${r.error}`;
  const lines = [`${r.file} [${r.kind}]`];
  for (const e of r.entries) {
    let line = `  ${e.key}: ${e.value_kind}`;
    if (e.length !== undefined) line += `[${e.length}]`;
    if (e.preview !== undefined) line += ` = ${e.preview}`;
    lines.push(line);
  }
  return lines.join('\n');
}
```

**Update imports at the top of `cli.ts`:**

```typescript
// Add to the existing type import from '../query/engine.js':
import type {
  // ... existing types
  StructuredQueryResult, StructuredOutlineFileResult,
} from '../query/engine.js';
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Smoke test the CLI manually**

```bash
# From the worktree root, after building:
node dist/transports/cli.js structured-query package.json name
node dist/transports/cli.js structured-outline package.json
```

Expected: both print formatted output; no errors. (If the index hasn't been built for this repo, run `node dist/transports/cli.js rebuild` first.)

- [ ] **Step 5: Commit**

```bash
git add src/transports/cli.ts
git commit -m "feat(cli): structured-query + structured-outline subcommands"
```

---

### Task 4: Compact-mode key mapping + `src/index.ts` re-exports

**Files:**
- Modify: `src/query/compact.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Review compact.ts conventions**

Open `src/query/compact.ts`. Note the `COMPACT_KEY_MAP` (each result-type property mapped to a single letter) and the per-type rename list. The two new result types need entries — miss this and `compact: true` either leaks long keys or drops values.

- [ ] **Step 2: Add compact mappings**

Find the existing mapping block (usually keyed like `{ file: 'f', line: 'l', ... }`). Extend it with any new property names the two new types introduce. Specifically, these property names need entries if not already present:

- `path` (on StructuredQueryResult) — may collide with existing path uses; keep the existing short form if present.
- `found` → `fd`
- `value` → `v`
- `limit` → `lm`
- `actual` → `ac`
- `entries` → `es`
- `key` → `ke`
- `value_kind` → `vk`
- `preview` → `pr`
- `length` → `ln`

(If the existing map already shortens some, reuse rather than duplicate.)

The `structured_query` / `structured_outline` result-type strings themselves don't need compact aliases unless the compact layer renames `type` values — inspect and follow the existing convention.

- [ ] **Step 3: Add re-exports to `src/index.ts`**

Append to the existing `export type { … } from './query/engine.js'` block:

```typescript
  StructuredQueryResult,
  StructuredOutlineEntry,
  StructuredOutlineFileResult,
  StructuredValueKind,
```

- [ ] **Step 4: Build + test**

```bash
npm run build
npm test
```

Expected: clean build + all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/query/compact.ts src/index.ts
git commit -m "feat(query): compact-mode keys + public re-exports for A3 tools"
```

---

### Task 5: Docs + verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: CHANGELOG entry**

Prepend to `CHANGELOG.md`:

```markdown
## [Unreleased] — structured document MCP tools (A3 P0+P1)

### Added
- `nexus_structured_query(file, path)` — extract a single value from a structured config file. Dotted path syntax; numeric segments index arrays. Supported kinds: `package.json`, `tsconfig*.json`, `Cargo.toml`, GHA workflows (P0), generic JSON/YAML/TOML (P1).
- `nexus_structured_outline(file)` — list top-level keys with value kinds (string / number / boolean / null / array / object), short previews for scalars, array lengths for arrays. Same supported kinds as `structured_query`.
- CLI: `nexus structured-query <file> <path>` and `nexus structured-outline <file>`.

### Notes
- No line anchors — V3 defers anchor support until a location-preserving parser set is chosen.
- `nexus_lockfile_deps` (P2) deferred per the V3 spec's "may defer" clause.
- Structured file lookup is by exact path (relative to `root_path` or absolute). Structured files are not indexed; no fuzzy matching.
- Parse and fs errors surface as `{ error, ... }` on the single result; `file_too_large` errors include `limit` and `actual` bytes.

---
```

- [ ] **Step 2: CLAUDE.md update**

Under the "MCP Tools" section, add to the "New token-savers" list (or create a "Structured files" sub-list near it):

```markdown
- **`nexus_structured_query(file, path)`** — Extract a value from a structured file by dotted path.
- **`nexus_structured_outline(file)`** — Top-level keys + value kinds for a structured file.
```

- [ ] **Step 3: Full verification**

```bash
npm run build
npm run lint
npm test
```

Expected: clean.

- [ ] **Step 4: Commit docs**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: A3 structured-document MCP tools in CHANGELOG and CLAUDE.md"
```

- [ ] **Step 5: Final status**

```bash
git log --oneline main..HEAD
git status
```

Expected: 5 feat/docs commits on top of main; clean tree.

---

## Notes for the Implementing Engineer

- **Single-result `NexusResult`.** Both tools wrap a single result in the standard `results: []` envelope. It's a list of length 1, not a bare value. Keeps the `NexusResult<T>` shape consistent with every other tool.
- **Path syntax is deliberately minimal.** No brackets, no quoted keys, no wildcards. If a user needs a key containing dots, they read the outline first and use the absolute structured value via the loader API directly. Extending the syntax is a V4 concern — do not creep it in now.
- **No index fingerprint check.** These tools read the filesystem directly via A2's cache; the index being stale doesn't affect them. The standard `ensureFresh()` call in the MCP handler still runs (harmless — it's a no-op if files haven't changed).
- **"Not a structured file" is a hard error.** If someone calls `nexus_structured_query('src/foo.ts', 'x')`, we return `{ error: 'not a structured file' }` — NOT silently falling through to parsing as JSON or anything else.
- **Compact-mode mapping is easy to forget.** The existing `COMPACT_KEY_MAP` is the source of truth; tests that exercise `compact: true` on the two new tools will flush any miss. If you add new result fields later, add them to the map in the same PR.
- **No new MCP boilerplate helper.** `dispatch()` is a big switch; fine — that's the established pattern. Don't refactor it as part of this PR.

## Success Criteria Checklist

- [ ] `structuredQuery()` and `structuredOutline()` methods exist on `QueryEngine` with the documented signatures.
- [ ] All 17 tests in `tests/structured-query.test.ts` pass (10 query + 7 outline).
- [ ] MCP `tools/list` includes both new tool names with correct schemas.
- [ ] CLI `structured-query` and `structured-outline` subcommands work on a real repo.
- [ ] `compact: true` returns the tool's result with the same shape every other compact tool has (short keys, no `query`/`timing_ms`/`index_status`).
- [ ] `npm run build`, `npm run lint`, `npm test` all clean.
- [ ] CHANGELOG + CLAUDE.md updated.
- [ ] No changes to DB schema (confirmed via `SCHEMA_VERSION` unchanged).
- [ ] No new npm deps.
