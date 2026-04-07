# nexus_importers Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `nexus_importers` query that answers "which files import from this module?" — the inverse of `nexus_imports`.

**Architecture:** New `importers(source)` method on `QueryEngine` that queries `module_edges` by `source` column (already indexed via `idx_edges_source`), joins back to `files` for path info, and supports both exact and substring matching. Exposed as `nexus_importers` MCP tool and `nexus importers` CLI command.

**Tech Stack:** TypeScript, better-sqlite3, @modelcontextprotocol/sdk

---

### File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db/store.ts` | Modify (add 1 method) | `getImportsBySource(source)` — substring LIKE query on module_edges.source |
| `src/query/engine.ts` | Modify (add method + result type) | `importers(source)` — core query logic, returns `ImporterResult[]` |
| `src/transports/mcp.ts` | Modify (add tool def + handler) | `nexus_importers` MCP tool registration |
| `src/transports/cli.ts` | Modify (add subcommand) | `nexus importers <source>` CLI command |
| `tests/query.test.ts` | Modify (add describe block) | Tests for `importers()` method |
| `tests/mcp.test.ts` | Modify (add test) | Integration test for MCP tool |

---

### Task 1: Store — add `getImportsBySource`

**Files:**
- Modify: `src/db/store.ts:293-297` (after existing `getEdgesBySource`)

- [ ] **Step 1: Write the failing test**

Add to `tests/query.test.ts` inside the `QueryEngine` describe block, after the `imports` section:

```typescript
// ── importers ────────────────────────────────────────────────────────

describe('importers', () => {
  it('finds files that import from a source (exact)', () => {
    const result = engine.importers('react');
    expect(result.type).toBe('imports');
    expect(result.count).toBe(1);
    expect(result.results[0].file).toBe('src/components/Button.tsx');
    expect(result.results[0].names).toContain('React');
  });

  it('finds files that import from a source (substring)', () => {
    const result = engine.importers('node:fs');
    expect(result.count).toBe(1);
    expect(result.results[0].file).toBe('src/utils.ts');
    expect(result.results[0].names).toContain('readFile');
  });

  it('finds files importing relative modules', () => {
    const result = engine.importers('../utils');
    expect(result.count).toBe(1);
    expect(result.results[0].file).toBe('src/components/Button.tsx');
  });

  it('finds multiple files importing from same package', () => {
    // Add another file that imports from react
    const file4 = store.insertFile({
      path: 'src/components/Card.tsx',
      path_key: 'src/components/card.tsx',
      hash: 'card123',
      mtime: 4000,
      size: 400,
      language: 'typescript',
      status: 'indexed',
      indexed_at: '2026-04-07T12:00:00Z',
    });
    store.insertModuleEdges([
      { file_id: file4, kind: 'import', name: 'useState', source: 'react', line: 1, is_default: false, is_star: false, is_type: false },
    ]);
    const result = engine.importers('react');
    expect(result.count).toBe(2);
    const files = result.results.map(r => r.file).sort();
    expect(files).toEqual(['src/components/Button.tsx', 'src/components/Card.tsx']);
  });

  it('returns empty for no matches', () => {
    const result = engine.importers('nonexistent-package');
    expect(result.count).toBe(0);
  });

  it('groups multiple imports from same source into one result per file', () => {
    // Button.tsx imports both React (default) and formatDate from ../utils
    // but only one import from react — so count for react should be 1 result with 1 name
    const result = engine.importers('react');
    expect(result.count).toBe(1);
    expect(result.results[0].names).toEqual(['React']);
    expect(result.results[0].is_type).toBe(false);
  });

  it('includes type import flag', () => {
    const file4 = store.insertFile({
      path: 'src/types.ts',
      path_key: 'src/types.ts',
      hash: 'types123',
      mtime: 5000,
      size: 200,
      language: 'typescript',
      status: 'indexed',
      indexed_at: '2026-04-07T12:00:00Z',
    });
    store.insertModuleEdges([
      { file_id: file4, kind: 'import', name: 'Config', source: './config', line: 1, is_default: false, is_star: false, is_type: true },
    ]);
    const result = engine.importers('./config');
    expect(result.count).toBe(1);
    expect(result.results[0].is_type).toBe(true);
  });

  it('query string is correct', () => {
    const result = engine.importers('react');
    expect(result.query).toBe('importers react');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/query.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `engine.importers is not a function`

- [ ] **Step 3: Add `getImportsBySourceLike` to store**

In `src/db/store.ts`, after the existing `getEdgesBySource` method (line ~297):

```typescript
getImportsBySourceLike(sourcePattern: string): (ModuleEdgeRow & { id: number })[] {
  return this.db
    .prepare(
      "SELECT * FROM module_edges WHERE kind = 'import' AND source LIKE ? ORDER BY file_id, line",
    )
    .all(`%${sourcePattern}%`) as (ModuleEdgeRow & { id: number })[];
}

getImportsBySourceExact(source: string): (ModuleEdgeRow & { id: number })[] {
  return this.db
    .prepare(
      "SELECT * FROM module_edges WHERE kind = 'import' AND source = ? ORDER BY file_id, line",
    )
    .all(source) as (ModuleEdgeRow & { id: number })[];
}
```

- [ ] **Step 4: Add `ImporterResult` type and `importers()` method to engine**

In `src/query/engine.ts`, add the result type after `ModuleEdgeResult` (around line 51):

```typescript
export interface ImporterResult {
  file: string;
  language: string;
  source: string;
  line: number;
  names: string[];
  is_type: boolean;
  is_default: boolean;
  is_star: boolean;
}
```

Add the `importers` method to `QueryEngine` class, after `imports()` (around line 208):

```typescript
/**
 * Find all files that import from a given source module.
 * Tries exact match first, then substring (LIKE) fallback.
 */
importers(source: string): NexusResult<ImporterResult> {
  const start = performance.now();

  // Try exact match first
  let rows = this.store.getImportsBySourceExact(source);

  // Fallback to substring match if no exact hits
  if (rows.length === 0) {
    rows = this.store.getImportsBySourceLike(source);
  }

  // Group by file_id → one result per file
  const byFile = new Map<number, typeof rows>();
  for (const row of rows) {
    const arr = byFile.get(row.file_id) ?? [];
    arr.push(row);
    byFile.set(row.file_id, arr);
  }

  const results: ImporterResult[] = [];
  for (const [fileId, edges] of byFile) {
    const file = this.store.getFileById(fileId);
    if (!file) continue;

    const names = edges
      .map(e => e.name ?? (e.is_star ? '*' : null))
      .filter((n): n is string => n !== null);

    results.push({
      file: file.path,
      language: file.language,
      source: edges[0].source ?? source,
      line: edges[0].line,
      names,
      is_type: edges.every(e => !!e.is_type),
      is_default: edges.some(e => !!e.is_default),
      is_star: edges.some(e => !!e.is_star),
    });
  }

  // Sort by file path for deterministic output
  results.sort((a, b) => a.file.localeCompare(b.file));

  return this.wrap('imports', `importers ${source}`, results, start);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/query.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: All importers tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/store.ts src/query/engine.ts tests/query.test.ts
git commit -m "feat: add importers() query — find files importing from a source module"
```

---

### Task 2: MCP tool — `nexus_importers`

**Files:**
- Modify: `src/transports/mcp.ts:102-111` (add tool def after `nexus_imports`)
- Modify: `src/transports/mcp.ts:190-197` (add case handler)

- [ ] **Step 1: Write the failing test**

Add to `tests/mcp.test.ts` — find the existing test pattern for tool calls and add:

```typescript
it('nexus_importers returns files importing from a source', async () => {
  const result = await callTool('nexus_importers', { source: 'react' });
  expect(result.count).toBeGreaterThanOrEqual(0);
  // Exact shape depends on test data seeding in mcp.test.ts
});
```

Note: if `mcp.test.ts` uses the real flowstate index, the assertion should match actual data. Adjust accordingly after reading the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — unknown tool `nexus_importers`

- [ ] **Step 3: Add tool definition to MCP ListTools**

In `src/transports/mcp.ts`, after the `nexus_imports` tool definition (around line 111), add:

```typescript
{
  name: 'nexus_importers',
  description: 'Find all files that import from a given source module. Answers "who depends on X?" — the inverse of nexus_imports. Supports exact and substring matching.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      source: { type: 'string', description: 'Module source to search for (e.g. "@dnd-kit/core", "react", "./utils")' },
    },
    required: ['source'],
  },
},
```

- [ ] **Step 4: Add case handler to CallTool**

In `src/transports/mcp.ts`, after the `nexus_imports` case (around line 197), add:

```typescript
case 'nexus_importers': {
  const { source } = args as { source: string };
  const result = qe.importers(source);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/mcp.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/transports/mcp.ts tests/mcp.test.ts
git commit -m "feat: expose nexus_importers as MCP tool"
```

---

### Task 3: CLI command — `nexus importers`

**Files:**
- Modify: `src/transports/cli.ts` (add formatter + command)

- [ ] **Step 1: Add the formatter function**

In `src/transports/cli.ts`, after `formatEdges` (around line 72), add:

```typescript
function formatImporters(results: ImporterResult[]): string {
  if (results.length === 0) return 'No files import from this source.';

  const lines: string[] = [];
  for (const r of results) {
    const flags: string[] = [];
    if (r.is_default) flags.push('default');
    if (r.is_star) flags.push('*');
    if (r.is_type) flags.push('type');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    const names = r.names.length > 0 ? r.names.join(', ') : '<side-effect>';
    lines.push(`  ${r.file}:${r.line}`);
    lines.push(`    imports { ${names} } from '${r.source}'${flagStr}`);
  }
  return lines.join('\n');
}
```

Also add `ImporterResult` to the import at the top of the file:

```typescript
import type {
  SymbolResult, OccurrenceResult, ModuleEdgeResult,
  TreeEntry, IndexStats, NexusResult, ImporterResult,
} from '../query/engine.js';
```

- [ ] **Step 2: Add the commander subcommand**

Find the existing `imports` command definition in cli.ts and add after it:

```typescript
program
  .command('importers <source>')
  .description('Find all files that import from a source module')
  .action((source: string) => {
    const engine = getQueryEngine();
    const result = engine.importers(source);
    printResult(result, formatImporters);
  });
```

- [ ] **Step 3: Build and test manually**

Run: `npm run build && node dist/transports/cli.js importers react`
Expected: list of files importing from 'react' (when run against the flowstate index)

- [ ] **Step 4: Commit**

```bash
git add src/transports/cli.ts
git commit -m "feat: add nexus importers CLI command"
```

---

### Task 4: Full build + test verification

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean compilation, no errors

- [ ] **Step 2: Run all tests**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -40`
Expected: All tests pass (318 + new tests)

- [ ] **Step 3: Integration smoke test**

Run: `node dist/transports/cli.js importers @dnd-kit` (from nexus project, targeting flowstate)
Expected: Shows files importing from @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities

- [ ] **Step 4: Final commit if any fixups needed**

---

### Task 5: Update CLAUDE.md Nexus documentation

**Files:**
- Modify: `C:\Users\Shlom\Downloads\Claude\flowstate\CLAUDE.md`

- [ ] **Step 1: Add `nexus_importers` to the Nexus tool list**

Add after the `nexus_imports` entry:

```
- **`nexus_importers`** — Find all files that import from a given source. Use INSTEAD of Grep when answering "who depends on X?" (e.g., `nexus_importers("@dnd-kit/core")`, `nexus_importers("./utils")`).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add nexus_importers to CLAUDE.md tool reference"
```
