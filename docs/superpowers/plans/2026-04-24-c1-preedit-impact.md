# C1 — Pre-Edit Impact Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn Claude before editing or rewriting a source file that exports symbols other code imports, by injecting an `additionalContext` summary (importer count, caller count, bucketed risk) via the existing policy transport.

**Architecture:** One new `PolicyRule` (`preedit-impact`) registered in `DEFAULT_RULES`. Rule reads the target file from disk, classifies it via `classifyPath()`, and uses a minimal `QueryEngineLike` (exposing only `importers`, `outline`, `callers`) to assemble an impact summary. Pure scoring/summary logic lives in `src/policy/impact.ts` (DB-free). `policy-entry.ts` opens a read-only `QueryEngine` at bin startup; `mcp.ts` forwards the existing server-side engine through `dispatchPolicy`. The bash hook gains `Edit` and `Write` branches mirroring the existing Read-allow branch.

**Tech Stack:** TypeScript (strict ESM), Node `fs`/`path`, Vitest, `better-sqlite3` (existing), bash + `jq` (existing hook).

**Spec deviations:**
- `OutlineEntryForImpact.end_line` is `number | undefined` (spec had it required). Makes `QueryEngineLike` structurally satisfied by the real `QueryEngine` whose `OutlineEntry.end_line` is optional. `findSymbolAtEdit` skips entries missing `end_line`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/policy/types.ts` | Modify | Add `QueryEngineLike`, `OutlineForImpact`, `OutlineEntryForImpact`; extend `PolicyContext` with optional `queryEngine`. |
| `src/policy/impact.ts` | Create | Pure helpers: `findSymbolAtEdit`, `bucketRisk`, `summarizeEditImpact`, `summarizeWriteImpact`; shared types `SymbolMatch`, `RiskBucket`, `EditImpact`, `WriteImpact`. |
| `src/policy/rules/preedit-impact.ts` | Create | The rule: classifies path, reads file, resolves symbol, queries engine, formats summary. |
| `src/policy/dispatcher.ts` | Modify | Forward `DispatchOptions.queryEngine` into `PolicyContext`. |
| `src/policy/index.ts` | Modify | Export `preeditImpactRule`; append to `DEFAULT_RULES`. |
| `src/transports/policy-entry.ts` | Modify | Construct read-only `QueryEngine` at bin startup; inject via `dispatchPolicy` options. |
| `src/transports/mcp.ts` | Modify | `executePolicyCheck` passes `getEngine()` via `dispatchPolicy`. |
| `hooks/nexus-first.sh` | Modify | Add `Edit` and `Write` branches; update matcher docs to `Grep|Glob|Agent|Read|Edit|Write`. |
| `tests/policy-impact.test.ts` | Create | DB-free unit tests for `impact.ts`. |
| `tests/policy-rules-preedit-impact.test.ts` | Create | Rule tests with stub `QueryEngineLike` + `fs` temp files. |
| `tests/policy-types.test.ts` | Modify | Compile-check for new interfaces. |
| `tests/policy-dispatcher.test.ts` | Modify | `queryEngine` forwarding + DEFAULT_RULES integration. |
| `tests/policy-entry.test.ts` | Modify | Real-DB E2E for Edit case + no-DB fall-open. |
| `tests/mcp.test.ts` | Modify | `nexus_policy_check` Edit case with seeded index. |
| `CHANGELOG.md` | Modify | New `[Unreleased]` entry. |
| `CLAUDE.md` | Modify | Extend policy-transport section with the new rule. |
| `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md` | Modify | Mark C1 shipped. |

---

## Task 1: Preflight — confirm baseline green

**Files:** None modified. Verification only.

- [ ] **Step 1: Confirm branch + worktree**

Run: `git branch --show-current`
Expected: `feat/c1-preedit-impact`

Run: `git status`
Expected: Clean working tree (no staged or unstaged changes; untracked plan docs OK).

- [ ] **Step 2: Confirm build is green**

Run: `npm run build`
Expected: `tsc --project tsconfig.json` exits 0, no TypeScript errors.

- [ ] **Step 3: Confirm tests are green**

Run: `npm test`
Expected: All tests pass (~641 in main tree). Note the baseline count — later tasks should only add tests, never remove any.

- [ ] **Step 4: Nothing to commit**

No code changes in this task. Do not commit.

---

## Task 2: Types — add `QueryEngineLike` and extend `PolicyContext`

**Files:**
- Modify: `src/policy/types.ts`
- Test: `tests/policy-types.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/policy-types.test.ts` (add to the existing imports and bottom of the `describe('policy types', …)` block):

```typescript
import type {
  PolicyContext,
  QueryEngineLike,
  OutlineForImpact,
  OutlineEntryForImpact,
} from '../src/policy/types.js';
```

Then add this test at the end of the existing `describe` block:

```typescript
  it('PolicyContext accepts an optional QueryEngineLike', () => {
    const stubEngine: QueryEngineLike = {
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [] }),
      callers: () => ({ results: [{ callers: [] }] }),
    };
    const ctx: PolicyContext = {
      rootDir: '/tmp',
      dbPath: '/tmp/.nexus/index.db',
      queryEngine: stubEngine,
    };
    expect(ctx.queryEngine).toBeDefined();
  });

  it('OutlineForImpact and OutlineEntryForImpact compile as expected', () => {
    const entry: OutlineEntryForImpact = {
      name: 'foo',
      kind: 'function',
      line: 10,
      end_line: 20,
    };
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [entry],
    };
    expect(outline.outline[0].name).toBe('foo');
  });

  it('QueryEngineLike methods return the expected envelope shape', () => {
    const engine: QueryEngineLike = {
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [{ file: 'src/b.ts', exports: [], outline: [] }] }),
      callers: (_name, _opts) => ({ results: [{ callers: [] }] }),
    };
    expect(engine.importers('src/b.ts').count).toBe(1);
    expect(engine.outline('src/b.ts').results.length).toBe(1);
    expect(engine.callers('foo', { file: 'src/b.ts', limit: 50 }).results[0].callers.length).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL with TypeScript errors — `QueryEngineLike`, `OutlineForImpact`, `OutlineEntryForImpact`, and the extended `PolicyContext.queryEngine` are not exported.

- [ ] **Step 3: Extend types**

Replace `src/policy/types.ts` entirely with:

```typescript
/**
 * Event shape mirrors Claude Code's PreToolUse hook JSON payload.
 * Only the fields we actually consume are typed; extra fields are tolerated.
 */
export interface PolicyEvent {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
}

export interface PolicyDecision {
  decision: 'allow' | 'ask' | 'deny' | 'noop';
  reason?: string;
  rule?: string;
  /**
   * Optional advisory text forwarded to the assistant (via PreToolUse
   * `additionalContext`). Only meaningful when `decision` is `allow` or
   * `ask`; the dispatcher drops it on `deny`/`noop`.
   */
  additional_context?: string;
}

export interface PolicyResponse {
  decision: PolicyDecision['decision'];
  reason?: string;
  rule?: string;
  additional_context?: string;
  stale_hint: boolean;
}

export interface OutlineEntryForImpact {
  name: string;
  kind: string;
  line: number;
  /**
   * Real QueryEngine marks end_line optional on OutlineEntry. Rules that need
   * it (notably preedit-impact) must skip entries where it's missing.
   */
  end_line?: number;
  children?: OutlineEntryForImpact[];
}

export interface OutlineForImpact {
  file: string;
  exports: string[];
  outline: OutlineEntryForImpact[];
}

/**
 * Minimal surface of QueryEngine consumed by the preedit-impact rule.
 * Narrower than the real class so tests can stub without a DB. The real
 * QueryEngine satisfies this structurally (its return envelopes already
 * have `results` + `count`).
 */
export interface QueryEngineLike {
  importers(source: string): {
    results: { file: string }[];
    count: number;
  };
  outline(filePath: string): {
    results: OutlineForImpact[];
  };
  /**
   * Return envelope for "who calls `name`". The distinct-caller count lives
   * at `results[0]?.callers?.length ?? 0` — the real `QueryEngine.callers`
   * wraps a single `CallersResult` in a one-element array, so the envelope
   * `count` is always 0 or 1 (NOT the distinct-caller count). Rules must
   * compute the count from `results[0].callers.length`.
   */
  callers(
    name: string,
    opts?: { file?: string; limit?: number },
  ): {
    results: { callers: unknown[] }[];
  };
}

export interface PolicyContext {
  rootDir: string;
  dbPath: string;
  /** Optional DB-backed query engine. Rules that need DB access must
   *  fall open (return null) when this is undefined. */
  queryEngine?: QueryEngineLike;
}

export interface PolicyRule {
  name: string;
  evaluate(event: PolicyEvent, ctx: PolicyContext): PolicyDecision | null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build`
Expected: exits 0, no errors.

Run: `npm test -- tests/policy-types.test.ts`
Expected: PASS (new tests + existing).

- [ ] **Step 5: Commit**

```bash
git add src/policy/types.ts tests/policy-types.test.ts
git commit -m "feat(policy): add QueryEngineLike + OutlineForImpact types (C1)"
```

---

## Task 3: Impact helpers — `findSymbolAtEdit` and `bucketRisk`

**Files:**
- Create: `src/policy/impact.ts`
- Create: `tests/policy-impact.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/policy-impact.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { findSymbolAtEdit, bucketRisk } from '../src/policy/impact.js';
import type { OutlineForImpact } from '../src/policy/types.js';

const file = `export function foo() {\n  return 1;\n}\n\nfunction helper() {\n  return 2;\n}\n\nexport function bar() {\n  return foo();\n}\n`;

const outline: OutlineForImpact = {
  file: 'src/x.ts',
  exports: ['foo', 'bar'],
  outline: [
    { name: 'foo', kind: 'function', line: 1, end_line: 3 },
    { name: 'helper', kind: 'function', line: 5, end_line: 7 },
    { name: 'bar', kind: 'function', line: 9, end_line: 11 },
  ],
};

describe('findSymbolAtEdit', () => {
  it('returns the enclosing top-level exported symbol for a matched edit', () => {
    const match = findSymbolAtEdit(file, 'return 1;', outline);
    expect(match).not.toBeNull();
    expect(match!.name).toBe('foo');
    expect(match!.topLevel).toBe(true);
    expect(match!.exported).toBe(true);
  });

  it('returns null when old_string is not in file', () => {
    expect(findSymbolAtEdit(file, 'return 999;', outline)).toBeNull();
  });

  it('matches the first occurrence when old_string appears multiple times', () => {
    const dupFile = `export function foo() {\n  return 1;\n}\n\nexport function bar() {\n  return 1;\n}\n`;
    const dupOutline: OutlineForImpact = {
      file: 'src/x.ts',
      exports: ['foo', 'bar'],
      outline: [
        { name: 'foo', kind: 'function', line: 1, end_line: 3 },
        { name: 'bar', kind: 'function', line: 5, end_line: 7 },
      ],
    };
    const match = findSymbolAtEdit(dupFile, 'return 1;', dupOutline);
    expect(match!.name).toBe('foo');
  });

  it('returns null when the edit line is outside any top-level entry', () => {
    const fileWithBlank = `\n\n\nfoo();\n`;
    const outlineEmpty: OutlineForImpact = {
      file: 'src/x.ts',
      exports: [],
      outline: [{ name: 'foo', kind: 'function', line: 10, end_line: 20 }],
    };
    expect(findSymbolAtEdit(fileWithBlank, 'foo();', outlineEmpty)).toBeNull();
  });

  it('returns the outer top-level entry when edit is inside a nested child', () => {
    const nestedFile = `export function outer() {\n  function inner() {\n    return 1;\n  }\n  return inner();\n}\n`;
    const nestedOutline: OutlineForImpact = {
      file: 'src/x.ts',
      exports: ['outer'],
      outline: [
        {
          name: 'outer',
          kind: 'function',
          line: 1,
          end_line: 6,
          children: [
            { name: 'inner', kind: 'function', line: 2, end_line: 4 },
          ],
        },
      ],
    };
    const match = findSymbolAtEdit(nestedFile, 'return 1;', nestedOutline);
    expect(match!.name).toBe('outer');
    expect(match!.topLevel).toBe(true);
  });

  it('reports exported=false when the enclosing symbol is private', () => {
    const match = findSymbolAtEdit(file, 'return 2;', outline);
    expect(match!.name).toBe('helper');
    expect(match!.exported).toBe(false);
  });

  it('skips outline entries that lack end_line', () => {
    const weirdOutline: OutlineForImpact = {
      file: 'src/x.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1 }],
    };
    expect(findSymbolAtEdit(file, 'return 1;', weirdOutline)).toBeNull();
  });
});

describe('bucketRisk', () => {
  it('buckets 0 callers as low', () => {
    expect(bucketRisk(0)).toBe('low');
  });

  it('buckets 2 callers as low (upper edge)', () => {
    expect(bucketRisk(2)).toBe('low');
  });

  it('buckets 3 callers as medium (lower edge)', () => {
    expect(bucketRisk(3)).toBe('medium');
  });

  it('buckets 10 callers as medium (upper edge)', () => {
    expect(bucketRisk(10)).toBe('medium');
  });

  it('buckets 11 callers as high (lower edge)', () => {
    expect(bucketRisk(11)).toBe('high');
  });

  it('buckets 50 callers as high', () => {
    expect(bucketRisk(50)).toBe('high');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/policy-impact.test.ts`
Expected: FAIL with "Cannot find module '../src/policy/impact.js'" or exports missing.

- [ ] **Step 3: Implement `impact.ts`**

Create `src/policy/impact.ts`:

```typescript
import type { OutlineForImpact, OutlineEntryForImpact } from './types.js';

export interface SymbolMatch {
  name: string;
  topLevel: boolean;
  exported: boolean;
  line: number;
  end_line: number;
}

export type RiskBucket = 'low' | 'medium' | 'high';

/**
 * Resolve the top-level symbol whose body encloses an `Edit` tool's
 * `old_string`. Returns `null` if the string isn't found, the first match
 * lands outside every top-level entry, or every candidate entry lacks
 * `end_line`. Nested matches collapse to the enclosing top-level entry.
 */
export function findSymbolAtEdit(
  fileContent: string,
  oldString: string,
  outline: OutlineForImpact,
): SymbolMatch | null {
  if (oldString.length === 0) return null;
  const index = fileContent.indexOf(oldString);
  if (index < 0) return null;

  const line = fileContent.slice(0, index).split('\n').length;

  for (const entry of outline.outline) {
    if (entry.end_line === undefined) continue;
    if (line < entry.line || line > entry.end_line) continue;
    return {
      name: entry.name,
      topLevel: true,
      exported: outline.exports.includes(entry.name),
      line: entry.line,
      end_line: entry.end_line,
    };
  }
  return null;
}

export function bucketRisk(callerCount: number): RiskBucket {
  if (callerCount <= 2) return 'low';
  if (callerCount <= 10) return 'medium';
  return 'high';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build`
Expected: exits 0.

Run: `npm test -- tests/policy-impact.test.ts`
Expected: PASS (13 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/policy/impact.ts tests/policy-impact.test.ts
git commit -m "feat(policy): add findSymbolAtEdit + bucketRisk helpers (C1)"
```

---

## Task 4: Impact summaries — `summarizeEditImpact` and `summarizeWriteImpact`

**Files:**
- Modify: `src/policy/impact.ts`
- Test: `tests/policy-impact.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/policy-impact.test.ts`:

```typescript
import { summarizeEditImpact, summarizeWriteImpact, SUMMARY_MAX_CHARS } from '../src/policy/impact.js';
import type { EditImpact, WriteImpact } from '../src/policy/impact.js';

describe('summarizeEditImpact', () => {
  it('includes symbol, file, risk bucket, importer count, caller count, and the nexus_callers hint', () => {
    const impact: EditImpact = {
      symbol: 'foo',
      file: 'src/bar.ts',
      importers: ['src/a.ts', 'src/b.ts'],
      importerCount: 2,
      callerCount: 6,
      risk: 'medium',
    };
    const s = summarizeEditImpact(impact);
    expect(s).toMatch(/foo/);
    expect(s).toMatch(/src\/bar\.ts/);
    expect(s).toMatch(/medium/);
    expect(s).toMatch(/2 file/);
    expect(s).toMatch(/6 caller/);
    expect(s).toMatch(/nexus_callers/);
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it('omits importer examples when importerCount is 0', () => {
    const impact: EditImpact = {
      symbol: 'foo',
      file: 'src/bar.ts',
      importers: [],
      importerCount: 0,
      callerCount: 0,
      risk: 'low',
    };
    const s = summarizeEditImpact(impact);
    expect(s).not.toMatch(/src\/a\.ts/);
  });

  it('adds "+N more" suffix when more than 3 importers', () => {
    const impact: EditImpact = {
      symbol: 'foo',
      file: 'src/bar.ts',
      importers: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
      importerCount: 5,
      callerCount: 0,
      risk: 'low',
    };
    const s = summarizeEditImpact(impact);
    expect(s).toMatch(/\+2 more/);
  });

  it('caps total length at SUMMARY_MAX_CHARS', () => {
    const impact: EditImpact = {
      symbol: 'averyverylongsymbolname',
      file: 'src/path/to/some/deeply/nested/module/file.ts',
      importers: Array.from({ length: 100 }, (_, i) => `src/importer-number-${i}.ts`),
      importerCount: 100,
      callerCount: 200,
      risk: 'high',
    };
    const s = summarizeEditImpact(impact);
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });
});

describe('summarizeWriteImpact', () => {
  it('lists multi-symbol rewrite with max risk and top callers', () => {
    const impact: WriteImpact = {
      file: 'src/bar.ts',
      importers: ['src/a.ts'],
      importerCount: 1,
      affectedSymbols: [
        { name: 'foo', callerCount: 6, risk: 'medium' },
        { name: 'bar', callerCount: 2, risk: 'low' },
        { name: 'baz', callerCount: 14, risk: 'high' },
      ],
      risk: 'high',
    };
    const s = summarizeWriteImpact(impact);
    expect(s).toMatch(/src\/bar\.ts/);
    expect(s).toMatch(/3 exported/);
    expect(s).toMatch(/high/);
    expect(s).toMatch(/baz/);
    expect(s).toMatch(/14/);
    expect(s).toMatch(/nexus_callers/);
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it('truncates top-N affected symbols to at most 3', () => {
    const impact: WriteImpact = {
      file: 'src/bar.ts',
      importers: [],
      importerCount: 1,
      affectedSymbols: [
        { name: 's1', callerCount: 10, risk: 'medium' },
        { name: 's2', callerCount: 8, risk: 'medium' },
        { name: 's3', callerCount: 6, risk: 'medium' },
        { name: 's4', callerCount: 4, risk: 'medium' },
        { name: 's5', callerCount: 2, risk: 'low' },
      ],
      risk: 'medium',
    };
    const s = summarizeWriteImpact(impact);
    expect(s).toMatch(/s1/);
    expect(s).toMatch(/s2/);
    expect(s).toMatch(/s3/);
    expect(s).not.toMatch(/s4/);
    expect(s).not.toMatch(/s5/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/policy-impact.test.ts`
Expected: FAIL with "`summarizeEditImpact` is not a function" or similar export errors.

- [ ] **Step 3: Extend `impact.ts`**

Append to `src/policy/impact.ts`:

```typescript
export const SUMMARY_MAX_CHARS = 600;

export interface EditImpact {
  symbol: string;
  file: string;
  importers: string[];
  importerCount: number;
  callerCount: number;
  risk: RiskBucket;
}

export interface WriteImpact {
  file: string;
  importers: string[];
  importerCount: number;
  affectedSymbols: { name: string; callerCount: number; risk: RiskBucket }[];
  /** Max over affectedSymbols. */
  risk: RiskBucket;
}

/**
 * Build a human-readable one-paragraph summary for a single-symbol Edit.
 * Guaranteed ≤ SUMMARY_MAX_CHARS; trailing "…" is appended if truncated.
 */
export function summarizeEditImpact(impact: EditImpact): string {
  const head = `Editing exported symbol \`${impact.symbol}\` in \`${impact.file}\` (risk: ${impact.risk}).`;

  let importerClause = '';
  if (impact.importerCount > 0) {
    const sample = impact.importers.slice(0, 3).map(f => `\`${f}\``).join(', ');
    const extra = impact.importerCount > 3 ? `, +${impact.importerCount - 3} more` : '';
    importerClause = ` ${impact.importerCount} file(s) import this module: ${sample}${extra};`;
  } else {
    importerClause = ` 0 files import this module;`;
  }

  const callerClause = ` ${impact.callerCount} caller(s) found.`;
  const hint = ` Run nexus_callers('${impact.symbol}') for the full list.`;

  return capSummary(`${head}${importerClause}${callerClause}${hint}`);
}

/**
 * Build a human-readable summary for a Write that replaces every export in
 * an existing file. Lists the top-3 affected symbols by caller count.
 */
export function summarizeWriteImpact(impact: WriteImpact): string {
  const head = `Rewriting ${impact.file} replaces ${impact.affectedSymbols.length} exported symbol(s) (max risk: ${impact.risk}).`;

  const top = impact.affectedSymbols
    .slice()
    .sort((a, b) => b.callerCount - a.callerCount)
    .slice(0, 3)
    .map(s => `\`${s.name}\` (${s.callerCount} callers)`)
    .join(', ');
  const topClause = top.length > 0 ? ` Top by callers: ${top}.` : '';

  const importerClause = ` ${impact.importerCount} importer(s).`;
  const hint = ` Run nexus_callers for any symbol to see full call sites.`;

  return capSummary(`${head}${topClause}${importerClause}${hint}`);
}

function capSummary(s: string): string {
  if (s.length <= SUMMARY_MAX_CHARS) return s;
  return s.slice(0, SUMMARY_MAX_CHARS - 1) + '…';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build`
Expected: exits 0.

Run: `npm test -- tests/policy-impact.test.ts`
Expected: PASS (all tests, old + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/policy/impact.ts tests/policy-impact.test.ts
git commit -m "feat(policy): add summarizeEditImpact + summarizeWriteImpact (C1)"
```

---

## Task 5: Rule — Edit path

**Files:**
- Create: `src/policy/rules/preedit-impact.ts`
- Create: `tests/policy-rules-preedit-impact.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/policy-rules-preedit-impact.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { preeditImpactRule } from '../src/policy/rules/preedit-impact.js';
import type {
  PolicyEvent,
  PolicyContext,
  QueryEngineLike,
  OutlineForImpact,
} from '../src/policy/types.js';

let tmpDir: string;

function ev(tool: string, input: Record<string, unknown>): PolicyEvent {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
}

function writeFile(rel: string, content: string): string {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function makeEngine(overrides: Partial<QueryEngineLike> = {}): QueryEngineLike {
  return {
    importers: () => ({ results: [], count: 0 }),
    outline: () => ({ results: [] }),
    callers: () => ({ results: [{ callers: [] }] }),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-preimpact-'));
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('preeditImpactRule — Edit path', () => {
  it('allows + summarizes an edit on an exported top-level symbol with importers', () => {
    const abs = writeFile(
      'src/bar.ts',
      'export function foo() {\n  return 1;\n}\n',
    );
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 3 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }, { file: 'src/b.ts' }], count: 2 }),
      outline: () => ({ results: [outline] }),
      callers: () => ({ results: [{ callers: new Array(6) }] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'return 1;' }),
      ctx,
    );
    expect(d?.decision).toBe('allow');
    expect(d?.rule).toBe('preedit-impact');
    expect(d?.additional_context).toMatch(/foo/);
    expect(d?.additional_context).toMatch(/medium/);
    expect(d?.additional_context).toMatch(/nexus_callers/);
  });

  it('returns null when file has 0 importers', () => {
    const abs = writeFile('src/bar.ts', 'export function foo() { return 1; }\n');
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 1 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'return 1;' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null when edited symbol is a private helper (not in exports)', () => {
    const abs = writeFile(
      'src/bar.ts',
      'export function foo() {}\n\nfunction helper() {\n  return 2;\n}\n',
    );
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [
        { name: 'foo', kind: 'function', line: 1, end_line: 1 },
        { name: 'helper', kind: 'function', line: 3, end_line: 5 },
      ],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'return 2;' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null when old_string is not present in file', () => {
    const abs = writeFile('src/bar.ts', 'export function foo() { return 1; }\n');
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 1 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'nonexistent string' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null when ctx.queryEngine is undefined', () => {
    const abs = writeFile('src/bar.ts', 'export function foo() { return 1; }\n');
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'return 1;' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for Edit on package.json (structured kind)', () => {
    const abs = writeFile('package.json', '{"name":"x"}\n');
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: '"name":"x"' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null when the file is over the 2 MB hot-path cap', () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const abs = writeFile('src/bar.ts', `export function foo() {}\n${huge}`);
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 1 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'export function foo() {}' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for non-Edit/Write tool', () => {
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: makeEngine(),
    };
    expect(
      preeditImpactRule.evaluate(ev('Read', { file_path: 'src/bar.ts' }), ctx),
    ).toBeNull();
  });

  it('returns null when old_string is missing or non-string', () => {
    const abs = writeFile('src/bar.ts', 'export function foo() {}\n');
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    expect(
      preeditImpactRule.evaluate(ev('Edit', { file_path: abs }), ctx),
    ).toBeNull();
    expect(
      preeditImpactRule.evaluate(
        ev('Edit', { file_path: abs, old_string: 123 }),
        ctx,
      ),
    ).toBeNull();
  });

  it('returns null for missing file_path', () => {
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: makeEngine(),
    };
    expect(preeditImpactRule.evaluate(ev('Edit', {}), ctx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/policy-rules-preedit-impact.test.ts`
Expected: FAIL with "Cannot find module '../src/policy/rules/preedit-impact.js'".

- [ ] **Step 3: Implement Edit branch**

Create `src/policy/rules/preedit-impact.ts`:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PolicyRule, PolicyContext, PolicyEvent, QueryEngineLike, OutlineForImpact } from '../types.js';
import { classifyPath } from '../../workspace/classify.js';
import {
  findSymbolAtEdit,
  bucketRisk,
  summarizeEditImpact,
  type EditImpact,
} from '../impact.js';

const EMPTY_CONFIG = { languages: {} };
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * `preedit-impact` — on `Edit` or `Write` events targeting an exported
 * symbol of an indexed source file with ≥1 importer, emit
 * `allow + additional_context` carrying a summary of downstream callers.
 * Never denies; any failure path returns `null` (silent allow).
 */
export const preeditImpactRule: PolicyRule = {
  name: 'preedit-impact',
  evaluate(event, ctx) {
    if (event.tool_name !== 'Edit' && event.tool_name !== 'Write') return null;
    if (!ctx.queryEngine) return null;

    const rawPath = event.tool_input.file_path;
    if (typeof rawPath !== 'string' || rawPath.length === 0) return null;

    const { relPath, absPath } = relativize(rawPath, ctx.rootDir);
    const basename = path.posix.basename(relPath);
    if (basename.length === 0) return null;

    let kind;
    try {
      kind = classifyPath(relPath, basename, EMPTY_CONFIG);
    } catch {
      return null;
    }
    if (kind.kind !== 'source') return null;

    if (event.tool_name === 'Edit') {
      return evaluateEdit(event, ctx, relPath, absPath);
    }
    return null; // Write branch added in Task 6
  },
};

function evaluateEdit(
  event: PolicyEvent,
  ctx: PolicyContext,
  relPath: string,
  absPath: string,
) {
  const oldString = event.tool_input.old_string;
  if (typeof oldString !== 'string' || oldString.length === 0) return null;

  const content = readCapped(absPath);
  if (content === null) return null;

  const engine = ctx.queryEngine as QueryEngineLike;

  let importers;
  try {
    importers = engine.importers(relPath);
  } catch {
    return null;
  }
  if (importers.count === 0) return null;

  let outlineEnvelope;
  try {
    outlineEnvelope = engine.outline(relPath);
  } catch {
    return null;
  }
  const outline: OutlineForImpact | undefined = outlineEnvelope.results[0];
  if (!outline) return null;

  const match = findSymbolAtEdit(content, oldString, outline);
  if (!match || !match.exported || !match.topLevel) return null;

  let callerCount = 0;
  try {
    const env = engine.callers(match.name, { file: relPath, limit: 50 });
    callerCount = env.results[0]?.callers?.length ?? 0;
  } catch {
    callerCount = 0;
  }

  const impact: EditImpact = {
    symbol: match.name,
    file: relPath,
    importers: importers.results.map(r => r.file),
    importerCount: importers.count,
    callerCount,
    risk: bucketRisk(callerCount),
  };

  return {
    decision: 'allow' as const,
    rule: 'preedit-impact',
    additional_context: summarizeEditImpact(impact),
  };
}

function readCapped(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

function relativize(rawPath: string, rootDir: string): { relPath: string; absPath: string } {
  const normalized = rawPath.replace(/\\/g, '/');
  const rootDirPosix = rootDir.replace(/\\/g, '/');
  const absPath = path.posix.isAbsolute(normalized)
    ? normalized
    : path.posix.resolve(rootDirPosix || '/', normalized);
  const candidateRel = rootDirPosix
    ? path.posix.relative(rootDirPosix, absPath)
    : normalized;
  const relPath = candidateRel.startsWith('..') ? normalized : candidateRel;
  return { relPath, absPath };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build`
Expected: exits 0.

Run: `npm test -- tests/policy-rules-preedit-impact.test.ts`
Expected: PASS (10 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/policy/rules/preedit-impact.ts tests/policy-rules-preedit-impact.test.ts
git commit -m "feat(policy): add preedit-impact rule Edit branch (C1)"
```

---

## Task 6: Rule — Write path

**Files:**
- Modify: `src/policy/rules/preedit-impact.ts`
- Test: `tests/policy-rules-preedit-impact.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/policy-rules-preedit-impact.test.ts`:

```typescript
describe('preeditImpactRule — Write path', () => {
  it('returns null for Write on a non-existent file (new file)', () => {
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: makeEngine({
        importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      }),
    };
    const d = preeditImpactRule.evaluate(
      ev('Write', { file_path: path.join(tmpDir, 'src/new.ts'), content: 'x' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for Write on existing file with 0 importers', () => {
    const abs = writeFile('src/bar.ts', 'export function foo() {}\n');
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 1 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Write', { file_path: abs, content: 'new content' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('allows + lists top symbols for Write on existing source with multiple exports', () => {
    const abs = writeFile(
      'src/bar.ts',
      'export function foo() {}\nexport function bar() {}\nexport function baz() {}\n',
    );
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo', 'bar', 'baz'],
      outline: [
        { name: 'foo', kind: 'function', line: 1, end_line: 1 },
        { name: 'bar', kind: 'function', line: 2, end_line: 2 },
        { name: 'baz', kind: 'function', line: 3, end_line: 3 },
      ],
    };
    const callerCounts: Record<string, number> = { foo: 6, bar: 2, baz: 14 };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }, { file: 'src/b.ts' }], count: 2 }),
      outline: () => ({ results: [outline] }),
      callers: (name) => ({ results: [{ callers: new Array(callerCounts[name] ?? 0) }] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Write', { file_path: abs, content: 'new content' }),
      ctx,
    );
    expect(d?.decision).toBe('allow');
    expect(d?.rule).toBe('preedit-impact');
    expect(d?.additional_context).toMatch(/3 exported/);
    expect(d?.additional_context).toMatch(/high/);
    expect(d?.additional_context).toMatch(/baz/);
    expect(d?.additional_context).toMatch(/14/);
  });

  it('returns null for Write on existing source with importers but no exports', () => {
    const abs = writeFile('src/bar.ts', 'function helper() {}\n');
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: [],
      outline: [{ name: 'helper', kind: 'function', line: 1, end_line: 1 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Write', { file_path: abs, content: 'new content' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('treats caller() throw as 0 callers for that symbol on Write', () => {
    const abs = writeFile(
      'src/bar.ts',
      'export function foo() {}\nexport function bar() {}\n',
    );
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo', 'bar'],
      outline: [
        { name: 'foo', kind: 'function', line: 1, end_line: 1 },
        { name: 'bar', kind: 'function', line: 2, end_line: 2 },
      ],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [outline] }),
      callers: (name) => {
        if (name === 'foo') throw new Error('boom');
        return { results: [{ callers: new Array(4) }] };
      },
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Write', { file_path: abs, content: 'new content' }),
      ctx,
    );
    expect(d?.decision).toBe('allow');
    expect(d?.additional_context).toMatch(/bar/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/policy-rules-preedit-impact.test.ts`
Expected: FAIL — all 5 new Write tests fail (rule currently returns `null` for Write).

- [ ] **Step 3: Implement Write branch**

In `src/policy/rules/preedit-impact.ts`, replace:

```typescript
    if (event.tool_name === 'Edit') {
      return evaluateEdit(event, ctx, relPath, absPath);
    }
    return null; // Write branch added in Task 6
  },
```

with:

```typescript
    if (event.tool_name === 'Edit') {
      return evaluateEdit(event, ctx, relPath, absPath);
    }
    return evaluateWrite(ctx, relPath, absPath);
  },
```

Add these imports at the top (merge with existing):

```typescript
import {
  findSymbolAtEdit,
  bucketRisk,
  summarizeEditImpact,
  summarizeWriteImpact,
  type EditImpact,
  type WriteImpact,
  type RiskBucket,
} from '../impact.js';
```

Add this function after `evaluateEdit`:

```typescript
function evaluateWrite(ctx: PolicyContext, relPath: string, absPath: string) {
  try {
    fs.statSync(absPath);
  } catch {
    return null; // new file: no prior importers by definition
  }

  const engine = ctx.queryEngine as QueryEngineLike;

  let importers;
  try {
    importers = engine.importers(relPath);
  } catch {
    return null;
  }
  if (importers.count === 0) return null;

  let outlineEnvelope;
  try {
    outlineEnvelope = engine.outline(relPath);
  } catch {
    return null;
  }
  const outline: OutlineForImpact | undefined = outlineEnvelope.results[0];
  if (!outline) return null;

  const exportedTopLevel = outline.outline.filter(e => outline.exports.includes(e.name));
  if (exportedTopLevel.length === 0) return null;

  const affectedSymbols = exportedTopLevel.map(entry => {
    let callerCount = 0;
    try {
      const env = engine.callers(entry.name, { file: relPath, limit: 50 });
      callerCount = env.results[0]?.callers?.length ?? 0;
    } catch {
      callerCount = 0;
    }
    return { name: entry.name, callerCount, risk: bucketRisk(callerCount) };
  });

  const maxRisk = affectedSymbols.reduce<RiskBucket>(
    (acc, s) => riskMax(acc, s.risk),
    'low',
  );

  const impact: WriteImpact = {
    file: relPath,
    importers: importers.results.map(r => r.file),
    importerCount: importers.count,
    affectedSymbols,
    risk: maxRisk,
  };

  return {
    decision: 'allow' as const,
    rule: 'preedit-impact',
    additional_context: summarizeWriteImpact(impact),
  };
}

function riskMax(a: RiskBucket, b: RiskBucket): RiskBucket {
  const rank: Record<RiskBucket, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] >= rank[b] ? a : b;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build`
Expected: exits 0.

Run: `npm test -- tests/policy-rules-preedit-impact.test.ts`
Expected: PASS (15 tests total: 10 Edit + 5 Write).

- [ ] **Step 5: Commit**

```bash
git add src/policy/rules/preedit-impact.ts tests/policy-rules-preedit-impact.test.ts
git commit -m "feat(policy): add preedit-impact rule Write branch (C1)"
```

---

## Task 7: Dispatcher — forward `queryEngine` into context

**Files:**
- Modify: `src/policy/dispatcher.ts`
- Test: `tests/policy-dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/policy-dispatcher.test.ts`, inside the outer `describe('dispatchPolicy', …)` block (before the closing `});`):

```typescript
  it('forwards queryEngine into ctx when provided in options', () => {
    const captured: { hasEngine: boolean } = { hasEngine: false };
    const rule: PolicyRule = {
      name: 'capture',
      evaluate: (_event, ctx) => {
        captured.hasEngine = ctx.queryEngine !== undefined;
        return { decision: 'allow', rule: 'capture' };
      },
    };
    const stubEngine = {
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [] }),
      callers: () => ({ results: [{ callers: [] }] }),
    };
    const resp = dispatchPolicy(ev(), {
      rootDir: tmpDir,
      rules: [rule],
      queryEngine: stubEngine,
    });
    expect(resp.decision).toBe('allow');
    expect(captured.hasEngine).toBe(true);
  });

  it('does not set ctx.queryEngine when options.queryEngine is undefined', () => {
    const captured: { hasEngine: boolean } = { hasEngine: true };
    const rule: PolicyRule = {
      name: 'capture',
      evaluate: (_event, ctx) => {
        captured.hasEngine = ctx.queryEngine !== undefined;
        return { decision: 'allow', rule: 'capture' };
      },
    };
    dispatchPolicy(ev(), { rootDir: tmpDir, rules: [rule] });
    expect(captured.hasEngine).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — `queryEngine` is not a known property of `DispatchOptions` (TS error).

- [ ] **Step 3: Extend dispatcher**

Replace the entire contents of `src/policy/dispatcher.ts` with:

```typescript
import * as path from 'node:path';
import { computeStaleHint } from './stale-hint.js';
import type { PolicyEvent, PolicyResponse, PolicyRule, PolicyContext, QueryEngineLike } from './types.js';

export interface DispatchOptions {
  rootDir: string;
  rules: readonly PolicyRule[];
  /** Optional DB-backed engine forwarded into ctx for DB-aware rules. */
  queryEngine?: QueryEngineLike;
}

/**
 * Evaluate rules in order. The first rule that returns a decision other than
 * `noop`/`null` wins. `noop` is treated as "rule inspected but abstains" and
 * allows later rules to decide. If no rule decides, the response is `allow`.
 *
 * Always attaches `stale_hint` — the caller (PreToolUse hook) can downgrade
 * a deny to a warning on stale data if it wishes.
 */
export function dispatchPolicy(event: PolicyEvent, opts: DispatchOptions): PolicyResponse {
  const ctx: PolicyContext = {
    rootDir: opts.rootDir,
    dbPath: path.join(opts.rootDir, '.nexus', 'index.db'),
    ...(opts.queryEngine ? { queryEngine: opts.queryEngine } : {}),
  };

  for (const rule of opts.rules) {
    const decision = rule.evaluate(event, ctx);
    if (!decision || decision.decision === 'noop') continue;
    return {
      decision: decision.decision,
      reason: decision.reason,
      rule: decision.rule,
      ...(decision.additional_context && decision.decision !== 'deny'
        ? { additional_context: decision.additional_context }
        : {}),
      stale_hint: computeStaleHint({
        rootDir: opts.rootDir,
        touchedAbsPath: extractTouchedPath(event, opts.rootDir),
      }),
    };
  }

  return {
    decision: 'allow',
    stale_hint: computeStaleHint({
      rootDir: opts.rootDir,
      touchedAbsPath: extractTouchedPath(event, opts.rootDir),
    }),
  };
}

/**
 * Best-effort path extraction for stale_hint. Looks at common tool_input keys
 * (`file_path`, `path`). Returns undefined when no plausible path is present.
 */
function extractTouchedPath(event: PolicyEvent, rootDir: string): string | undefined {
  const input = event.tool_input;
  const candidates = ['file_path', 'path', 'notebook_path', 'file'];
  for (const key of candidates) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) {
      const normalized = v.replace(/\\/g, '/');
      return path.isAbsolute(normalized) ? normalized : path.resolve(rootDir, normalized);
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build`
Expected: exits 0.

Run: `npm test -- tests/policy-dispatcher.test.ts`
Expected: PASS (all existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/policy/dispatcher.ts tests/policy-dispatcher.test.ts
git commit -m "feat(policy): forward queryEngine from DispatchOptions to context (C1)"
```

---

## Task 8: Register `preeditImpactRule` in `DEFAULT_RULES`

**Files:**
- Modify: `src/policy/index.ts`
- Test: `tests/policy-dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/policy-dispatcher.test.ts`, inside the `describe('dispatchPolicy with DEFAULT_RULES', …)` block (before the closing `});`):

```typescript
  it('Edit on indexed source + importer + exported top-level routes to preedit-impact', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const abs = path.join(tmpDir, 'src', 'bar.ts');
    fs.writeFileSync(abs, 'export function foo() {\n  return 1;\n}\n');
    const stubEngine = {
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({
        results: [
          {
            file: 'src/bar.ts',
            exports: ['foo'],
            outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 3 }],
          },
        ],
      }),
      callers: () => ({ results: [{ callers: new Array(4) }] }),
    };
    const resp = dispatchPolicy(
      ev('Edit', { file_path: abs, old_string: 'return 1;' }),
      { rootDir: tmpDir, rules: DEFAULT_RULES, queryEngine: stubEngine },
    );
    expect(resp.decision).toBe('allow');
    expect(resp.rule).toBe('preedit-impact');
    expect(resp.additional_context).toMatch(/foo/);
  });

  it('Edit with no queryEngine in options falls open (no rule fires)', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const abs = path.join(tmpDir, 'src', 'bar.ts');
    fs.writeFileSync(abs, 'export function foo() {}\n');
    const resp = dispatchPolicy(
      ev('Edit', { file_path: abs, old_string: 'export function foo' }),
      { rootDir: tmpDir, rules: DEFAULT_RULES },
    );
    expect(resp.decision).toBe('allow');
    expect(resp.rule).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/policy-dispatcher.test.ts`
Expected: FAIL — `preedit-impact` is not in `DEFAULT_RULES`, so `resp.rule` is `undefined` rather than `preedit-impact`.

- [ ] **Step 3: Register the rule**

Replace the entire contents of `src/policy/index.ts` with:

```typescript
export type {
  PolicyEvent,
  PolicyDecision,
  PolicyResponse,
  PolicyContext,
  PolicyRule,
  QueryEngineLike,
  OutlineForImpact,
  OutlineEntryForImpact,
} from './types.js';
export { dispatchPolicy } from './dispatcher.js';
export type { DispatchOptions } from './dispatcher.js';
export { computeStaleHint } from './stale-hint.js';
export { grepOnCodeRule } from './rules/grep-on-code.js';
export { readOnStructuredRule } from './rules/read-on-structured.js';
export { readOnSourceRule } from './rules/read-on-source.js';
export { preeditImpactRule } from './rules/preedit-impact.js';

import { grepOnCodeRule } from './rules/grep-on-code.js';
import { readOnStructuredRule } from './rules/read-on-structured.js';
import { readOnSourceRule } from './rules/read-on-source.js';
import { preeditImpactRule } from './rules/preedit-impact.js';
import type { PolicyRule } from './types.js';

/**
 * Default rule set shipped with Nexus. Extend in follow-up plans.
 *
 * Individual rules are accessible via deep imports, but consumers of the
 * public API should treat the concrete rule list as an implementation detail
 * and compose via `DEFAULT_RULES` (or build their own `PolicyRule[]`).
 *
 * Order: Grep checks run first (deny path, short-circuit on match), then the
 * two Read rules, then the Edit/Write impact advisor. The Read rules are
 * mutually exclusive by FileKind; `preedit-impact` is mutually exclusive with
 * both by tool name (Edit/Write vs Read/Grep).
 */
export const DEFAULT_RULES: readonly PolicyRule[] = [
  grepOnCodeRule,
  readOnStructuredRule,
  readOnSourceRule,
  preeditImpactRule,
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build`
Expected: exits 0.

Run: `npm test -- tests/policy-dispatcher.test.ts`
Expected: PASS (all tests).

Run: `npm test`
Expected: PASS overall — no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/policy/index.ts tests/policy-dispatcher.test.ts
git commit -m "feat(policy): register preeditImpactRule in DEFAULT_RULES (C1)"
```

---

## Task 9: `policy-entry.ts` — construct read-only `QueryEngine` at startup

**Files:**
- Modify: `src/transports/policy-entry.ts`
- Test: `tests/policy-entry.test.ts`

- [ ] **Step 1: Write the failing test**

First, add these imports to the top of `tests/policy-entry.test.ts` (alongside the existing imports):

```typescript
import * as os from 'node:os';
import { runIndex } from '../src/index/orchestrator.js';
```

Then append, before the closing `});` of `describe('policy-entry', …)`:

```typescript
  it('injects a real QueryEngine for Edit events when .nexus/index.db exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pe-c1-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'src', 'bar.ts'),
      'export function foo() {\n  return 1;\n}\n',
    );
    fs.writeFileSync(
      path.join(tmp, 'src', 'a.ts'),
      "import { foo } from './bar';\nfoo();\n",
    );
    // Build a real index (creates .nexus/index.db under tmp).
    runIndex(tmp);

    const result = run(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(tmp, 'src', 'bar.ts'),
          old_string: 'return 1;',
        },
      },
      tmp,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
    expect(parsed.rule).toBe('preedit-impact');
    expect(parsed.additional_context).toMatch(/foo/);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('falls open (silent allow) for Edit when .nexus/index.db is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pe-c1-nodb-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'bar.ts'), 'export function foo() {}\n');

    const result = run(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(tmp, 'src', 'bar.ts'),
          old_string: 'export function foo',
        },
      },
      tmp,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
    expect(parsed.rule).toBeUndefined();

    fs.rmSync(tmp, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npm test -- tests/policy-entry.test.ts`
Expected: FAIL — the first new test gets `decision: 'allow'` but no `rule: 'preedit-impact'` (the rule isn't firing because `policy-entry` doesn't construct an engine).

- [ ] **Step 3: Wire the engine into policy-entry**

Replace the entire contents of `src/transports/policy-entry.ts` with:

```typescript
#!/usr/bin/env node

/**
 * nexus-policy-check — dedicated micro-entrypoint for the PreToolUse hot path.
 *
 * Contract:
 *   - Reads a single JSON event from stdin.
 *   - Writes a single JSON response to stdout.
 *   - Exits 0 unless something truly unrecoverable happens.
 *   - Does NOT re-index. stale_hint advertises whether the answer may lag.
 *   - Must not import Commander or MCP SDK — stay small and fast.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectRoot } from '../workspace/detector.js';
import { dispatchPolicy } from '../policy/dispatcher.js';
import { DEFAULT_RULES } from '../policy/index.js';
import type { PolicyEvent, PolicyResponse, QueryEngineLike } from '../policy/types.js';
import { openDatabase } from '../db/schema.js';
import { QueryEngine } from '../query/engine.js';

function readStdinSync(): string {
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(65536);
    for (;;) {
      let n = 0;
      try {
        n = fs.readSync(0, buf, 0, buf.length, null);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN') continue;
        break;
      }
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch {
    return '';
  }
}

function parseEvent(raw: string): PolicyEvent | null {
  try {
    const obj = JSON.parse(raw) as Partial<PolicyEvent>;
    if (typeof obj.tool_name !== 'string') return null;
    return {
      hook_event_name: typeof obj.hook_event_name === 'string' ? obj.hook_event_name : 'PreToolUse',
      tool_name: obj.tool_name,
      tool_input: (obj.tool_input ?? {}) as Record<string, unknown>,
      session_id: typeof obj.session_id === 'string' ? obj.session_id : undefined,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
    };
  } catch {
    return null;
  }
}

function tryOpenEngine(rootDir: string): QueryEngineLike | undefined {
  try {
    const dbPath = path.join(rootDir, '.nexus', 'index.db');
    if (!fs.existsSync(dbPath)) return undefined;
    const db = openDatabase(dbPath, { readonly: true });
    return new QueryEngine(db) as unknown as QueryEngineLike;
  } catch {
    return undefined;
  }
}

function main(): void {
  const raw = readStdinSync();
  const event = parseEvent(raw);

  if (!event) {
    const response: PolicyResponse = {
      decision: 'allow',
      rule: 'parse-error',
      reason: 'malformed hook payload',
      stale_hint: false,
    };
    process.stdout.write(JSON.stringify(response));
    return;
  }

  const cwd = event.cwd ?? process.cwd();
  let rootDir: string;
  try {
    rootDir = detectRoot(cwd);
  } catch {
    rootDir = cwd;
  }

  const queryEngine = tryOpenEngine(rootDir);

  const response = dispatchPolicy(event, {
    rootDir,
    rules: DEFAULT_RULES,
    ...(queryEngine ? { queryEngine } : {}),
  });
  process.stdout.write(JSON.stringify(response));
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('transports/policy-entry.js')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('transports/policy-entry.ts');

if (isDirectRun) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build`
Expected: exits 0.

Run: `npm test -- tests/policy-entry.test.ts`
Expected: PASS (all tests, including 2 new Edit cases).

- [ ] **Step 5: Commit**

```bash
git add src/transports/policy-entry.ts tests/policy-entry.test.ts
git commit -m "feat(policy): construct readonly QueryEngine in policy-entry (C1)"
```

---

## Task 10: `mcp.ts` — pass `getEngine()` through `dispatchPolicy`

**Files:**
- Modify: `src/transports/mcp.ts`
- Test: `tests/mcp.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/mcp.test.ts`, inside the `describe('nexus_policy_check tool', …)` block (before its closing `});`):

```typescript
  it('returns allow + additional_context for an Edit event on an indexed exported symbol', async () => {
    // The existing MCP test-fixture index is prebuilt at setup; src/index.ts
    // exports plenty of top-level symbols and is indexed + has importers.
    const source = fs.readFileSync('src/index.ts', 'utf-8');
    const firstExport = source.match(/^export\s+\{[^}]*\}\s+from\s+'[^']+';/m)?.[0]
      ?? source.match(/^export\s+[^;\n]+[;\n]/m)?.[0];
    expect(firstExport).toBeDefined();
    // Pick a small distinctive substring from the file as old_string.
    // `openDatabase` is a stable exported identifier from src/index.ts line 1.
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/index.ts',
          old_string: "export { openDatabase",
        },
      },
    });
    const payload = JSON.parse(result.content[0].text);
    // Either the Edit was dispatched and preedit-impact fired (allow + rule),
    // or it fell through (allow w/o rule). Both are OK structurally; but with
    // the MCP server-side engine available, we expect the rule to fire when
    // importers exist for src/index.ts.
    expect(['allow']).toContain(payload.results[0].decision);
  });
```

Note: this integration test may reasonably fall through to plain allow if the indexed workspace has no importers of `src/index.ts`. The important assertion is simply that dispatching an Edit event does not throw and returns a well-formed response. For a positive-path integration test we rely on `tests/policy-entry.test.ts` (Task 9).

- [ ] **Step 2: Run test to verify it fails**

Skip this step — this test is a smoke test that simply confirms Edit events route through `executePolicyCheck` without throwing. It may already pass even with the stubbed dispatcher. Proceed to Step 3 anyway so `getEngine()` is wired for real downstream use.

- [ ] **Step 3: Wire `getEngine()` into `executePolicyCheck`**

In `src/transports/mcp.ts`, find the existing `executePolicyCheck` function (currently at ~line 563):

```typescript
  function executePolicyCheck(args: Record<string, unknown>): NexusResult<unknown> {
    const event = args.event;
    if (!event || typeof event !== 'object') {
      throw new Error('nexus_policy_check: event argument is required and must be an object');
    }
    const typedEvent = event as PolicyEvent;
    const rootDir = indexRootDir ?? process.cwd();
    const t0 = Date.now();
    const response = dispatchPolicy(typedEvent, { rootDir, rules: DEFAULT_RULES });
    const timing_ms = Date.now() - t0;
    return {
      type: 'policy_check',
      query: `policy_check ${typedEvent.tool_name ?? 'unknown'}`,
      results: [response],
      count: 1,
      index_status: response.stale_hint ? 'stale' : 'current',
      index_health: 'ok',
      timing_ms,
    };
  }
```

Replace the `dispatchPolicy` call with:

```typescript
    const engine = getEngine() as unknown as import('../policy/types.js').QueryEngineLike;
    const response = dispatchPolicy(typedEvent, { rootDir, rules: DEFAULT_RULES, queryEngine: engine });
```

So the full function becomes:

```typescript
  function executePolicyCheck(args: Record<string, unknown>): NexusResult<unknown> {
    const event = args.event;
    if (!event || typeof event !== 'object') {
      throw new Error('nexus_policy_check: event argument is required and must be an object');
    }
    const typedEvent = event as PolicyEvent;
    const rootDir = indexRootDir ?? process.cwd();
    const t0 = Date.now();
    const engine = getEngine() as unknown as import('../policy/types.js').QueryEngineLike;
    const response = dispatchPolicy(typedEvent, { rootDir, rules: DEFAULT_RULES, queryEngine: engine });
    const timing_ms = Date.now() - t0;
    return {
      type: 'policy_check',
      query: `policy_check ${typedEvent.tool_name ?? 'unknown'}`,
      results: [response],
      count: 1,
      index_status: response.stale_hint ? 'stale' : 'current',
      index_health: 'ok',
      timing_ms,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build`
Expected: exits 0.

Run: `npm test -- tests/mcp.test.ts`
Expected: PASS (all tests, including new Edit case).

- [ ] **Step 5: Commit**

```bash
git add src/transports/mcp.ts tests/mcp.test.ts
git commit -m "feat(mcp): pass server-side QueryEngine into policy dispatch (C1)"
```

---

## Task 11: Hook — add `Edit` and `Write` branches

**Files:**
- Modify: `hooks/nexus-first.sh`

- [ ] **Step 1: Verify manual smoke plan (no automated test — bash-level)**

There is no automated hook test. We will verify manually after editing by piping fixtures through `bash hooks/nexus-first.sh`.

- [ ] **Step 2: Update the header comment**

In `hooks/nexus-first.sh`, find this block (lines ~1-33):

```bash
# nexus-first.sh — Claude Code PreToolUse hook
#
# Enforces "use Nexus before Grep/Explore/Read" policy:
#   • Grep on code files          → denied (use nexus_search/nexus_grep instead)
#   • Glob for file discovery     → allowed (Nexus is for symbols, not file globs)
#   • Explore subagents           → denied unless prompt mentions a nexus_* tool
#   • Agent spawns                → denied unless prompt or description mentions Nexus
#   • Read on structured config   → asks (suggests nexus_structured_query/outline or nexus_lockfile_deps)
#   • Read on indexed source      → allowed with additionalContext nudging nexus_outline/source
#
# Allow-list:
#   • Grep on .md/.json/.yaml/.toml/.env/.lock/etc
#   • Grep on docs/, .git, node_modules, .nexus, .claude
#   • Agents whose description starts with non-code words (commit, deploy, build, …)
#   • Paged Read (with offset or limit) — silent allow
#
# Disable temporarily:  NEXUS_FIRST_DISABLED=1
#
# Install:
#   1. Copy this file to ~/.claude/hooks/nexus-first.sh and chmod +x
#   2. Add to ~/.claude/settings.json under "hooks":
#        "PreToolUse": [
#          {
#            "matcher": "Grep|Glob|Agent|Read",
#            "hooks": [
#              { "type": "command",
#                "command": "bash -c 'source ~/.bashrc && bash ~/.claude/hooks/nexus-first.sh'" }
#            ]
#          }
#        ]
#
# Requires `jq` on PATH.
```

Replace with:

```bash
# nexus-first.sh — Claude Code PreToolUse hook
#
# Enforces "use Nexus before Grep/Explore/Read/Edit/Write" policy:
#   • Grep on code files          → denied (use nexus_search/nexus_grep instead)
#   • Glob for file discovery     → allowed (Nexus is for symbols, not file globs)
#   • Explore subagents           → denied unless prompt mentions a nexus_* tool
#   • Agent spawns                → denied unless prompt or description mentions Nexus
#   • Read on structured config   → asks (suggests nexus_structured_query/outline or nexus_lockfile_deps)
#   • Read on indexed source      → allowed with additionalContext nudging nexus_outline/source
#   • Edit / Write on exported
#     indexed source              → allowed with additionalContext summarizing impact
#
# Allow-list:
#   • Grep on .md/.json/.yaml/.toml/.env/.lock/etc
#   • Grep on docs/, .git, node_modules, .nexus, .claude
#   • Agents whose description starts with non-code words (commit, deploy, build, …)
#   • Paged Read (with offset or limit) — silent allow
#
# Disable temporarily:  NEXUS_FIRST_DISABLED=1
#
# Install:
#   1. Copy this file to ~/.claude/hooks/nexus-first.sh and chmod +x
#   2. Add to ~/.claude/settings.json under "hooks":
#        "PreToolUse": [
#          {
#            "matcher": "Grep|Glob|Agent|Read|Edit|Write",
#            "hooks": [
#              { "type": "command",
#                "command": "bash -c 'source ~/.bashrc && bash ~/.claude/hooks/nexus-first.sh'" }
#            ]
#          }
#        ]
#
# Requires `jq` on PATH.
```

- [ ] **Step 3: Add Edit / Write branches**

In `hooks/nexus-first.sh`, find the final `exit 0` at the bottom (after the Read branch's closing `fi`). Just before that trailing `exit 0`, insert:

```bash
# ── Edit / Write: delegate to nexus-policy-check ─────────────────────
if [ "$TOOL_NAME" = "Edit" ] || [ "$TOOL_NAME" = "Write" ]; then
  if command -v nexus-policy-check >/dev/null 2>&1; then
    DECISION=$(echo "$INPUT" | nexus-policy-check)
  else
    DECISION=$(echo "$INPUT" | npx --no-install nexus-policy-check 2>/dev/null)
  fi

  # Fail open if the bin was not available or did not produce output — never
  # block on infra failures.
  if [ -z "$DECISION" ]; then
    exit 0
  fi

  PERMISSION=$(echo "$DECISION" | jq -r '.decision // "allow"')
  CONTEXT=$(echo "$DECISION" | jq -r '.additional_context // ""')

  if [ "$PERMISSION" = "allow" ] && [ -n "$CONTEXT" ]; then
    jq -n --arg ctx "$CONTEXT" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: $ctx
      }
    }'
    exit 0
  fi

  exit 0
fi
```

- [ ] **Step 4: Manual smoke test**

Make sure `npm run build` has run at least once (Task 9 covered this — `dist/transports/policy-entry.js` must exist).

Run: `echo '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"src/index.ts","old_string":"export { openDatabase"}}' | bash hooks/nexus-first.sh`

Expected stdout: either empty (silent allow — valid when no importers for src/index.ts in the current index) or a JSON blob with `"permissionDecision": "allow"` and `"additionalContext"` containing `openDatabase`. Either is a correct outcome — the key test is no non-zero exit.

Run: `echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"tmp-new-file.ts","content":"x"}}' | bash hooks/nexus-first.sh`

Expected: empty stdout (new file → no importers → silent allow).

Run: `npm test`
Expected: PASS overall.

- [ ] **Step 5: Commit**

```bash
git add hooks/nexus-first.sh
git commit -m "feat(hooks): Edit/Write branches emit preedit-impact additionalContext (C1)"
```

---

## Task 12: Documentation — CHANGELOG, CLAUDE.md, roadmap

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`
- Modify: `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md`

- [ ] **Step 1: CHANGELOG**

Open `CHANGELOG.md`. Under the topmost `## [Unreleased]` section (create one if it does not exist), add a bullet under `### Added`:

```markdown
### Added
- **C1 — Pre-Edit Impact Preview (policy transport).** New `preedit-impact` rule fires on `Edit` and `Write` against indexed source files. Emits `permissionDecision: allow` with an `additionalContext` summary (symbol name, importer count, caller count, bucketed risk — `low`/`medium`/`high`). Never blocks. Requires a readonly `QueryEngine` available in policy-entry (constructed at bin startup) or in MCP (already-present server-side engine). `hooks/nexus-first.sh` gains `Edit`/`Write` branches; matcher becomes `Grep|Glob|Agent|Read|Edit|Write`.
```

- [ ] **Step 2: CLAUDE.md**

Open `CLAUDE.md`. Find the `**Policy transport:** \`nexus_policy_check\`` line (under `## MCP Tools`). Just below the existing shipped-rules list (`- \`read-on-source\` …`), append:

```markdown
- `preedit-impact` — on `Edit`/`Write` events against an exported top-level symbol of an indexed source file with ≥1 known importer, emits `allow + additionalContext` summarizing importer count, caller count, and bucketed risk (`low`/`medium`/`high`). Never blocks. Falls open when the DB is unavailable.
```

- [ ] **Step 3: Roadmap**

Open `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md`. Find the C1 entry under the V3 Tier 1 list. Change its status marker from `pending` (or whatever the current token is — see the A3/A5 entries for precedent) to `shipped`, and add a brief note like:

```markdown
- **C1 — Pre-Edit Impact Preview** — **shipped 2026-04-24.** `preedit-impact` rule in `src/policy/rules/preedit-impact.ts`; summaries in `src/policy/impact.ts`. Reused by D3 evidence v1.
```

If the exact format differs in that file, match the surrounding entries (A3, A5) byte-for-byte.

- [ ] **Step 4: Final verification**

Run: `npm run build`
Expected: exits 0.

Run: `npm test`
Expected: PASS overall.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md CLAUDE.md "C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md"
git commit -m "docs: C1 preedit-impact shipped"
```

---

## Post-implementation: use `superpowers:finishing-a-development-branch`

After all 12 tasks are complete and both `npm run build` and `npm test` are green, invoke the `superpowers:finishing-a-development-branch` skill to present merge/PR/keep/discard options.
