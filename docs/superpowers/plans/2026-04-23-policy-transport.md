# Policy Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a dedicated micro-entrypoint (`nexus-policy-check`) + `src/policy/` TypeScript layer so `PreToolUse` hooks can consult Nexus in sub-150ms without spinning up the full Commander CLI. This unblocks every later V3 policy spec (A5/C2 read-redirect, C1 pre-edit impact, D3 evidence summary).

**Architecture:** A new second bin (`nexus-policy-check`) maps to `src/transports/policy-entry.ts`, a 60-ish-line wrapper that reads one JSON event from stdin, routes it through a pure-function dispatcher in `src/policy/`, and writes a JSON decision to stdout. The entry does **not** call `ensureFresh()` — the hot path accepts stale data and marks every response with `stale_hint: bool` computed from `index_runs.completed_at` vs. the touched file's mtime. The MCP server re-uses the same dispatcher under a new tool `nexus_policy_check` so platforms without hook support (Codex partial) still get policy answers. Ships with one real rule — migrating the Grep-on-code deny currently hard-coded in `hooks/nexus-first.sh:40` — to prove end-to-end routing. Other existing bash rules (Agent, Glob allow-list) stay in bash for this iteration; they migrate in follow-up plans alongside their owning specs.

**Tech Stack:** TypeScript (strict), better-sqlite3, @modelcontextprotocol/sdk, Vitest, Node.js ≥18.

**Spec reference:** `C:\Users\Shlom\.claude\plans\sourcegraph-closest-analog-sharded-seahorse.md` — "Policy Transport" + "Hook Philosophy" + V3 Tier 1 A5/C2 prerequisites.

---

### File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/policy/types.ts` | Create | `PolicyEvent`, `PolicyDecision`, `PolicyResponse`, `PolicyRule` interfaces. |
| `src/policy/stale-hint.ts` | Create | `computeStaleHint({ rootDir, touchedAbsPath? })` — reads `meta.last_indexed_at`, stats file, returns `boolean`. |
| `src/policy/rules/grep-on-code.ts` | Create | First real rule: deny `Grep` on code files; allow on docs/node_modules/.git/.nexus/.claude + non-code globs. Mirrors existing `nexus-first.sh:42-72` logic. |
| `src/policy/dispatcher.ts` | Create | `dispatchPolicy(event, ctx) → PolicyResponse` — run registered rules, first explicit decision wins, always attaches `stale_hint`. |
| `src/policy/index.ts` | Create | Re-exports for consumers (transport + MCP). |
| `src/transports/policy-entry.ts` | Create | Stdin JSON → dispatcher → stdout JSON. Opens DB read-only, short-circuits on parse error, never re-indexes. Shebang, main-guard. |
| `src/transports/mcp.ts` | Modify | Add `nexus_policy_check` MCP tool wrapping the same dispatcher. Does **not** call `ensureFresh()`. |
| `src/index.ts` | Modify | Public re-exports: `PolicyEvent`, `PolicyDecision`, `PolicyResponse`, `dispatchPolicy`. |
| `package.json` | Modify | Add `"nexus-policy-check": "dist/transports/policy-entry.js"` to `bin`. |
| `hooks/nexus-first.sh` | Modify | Grep branch delegates to `nexus-policy-check` (≤50 lines total). Agent/Glob branches unchanged in this plan. |
| `benchmarks/policy-latency.mjs` | Create | Ad-hoc timing harness (p50/p95 over N synthetic events). Plain `.mjs` — no TS toolchain needed. Non-blocking. |
| `benchmarks/README.md` | Create | Short note on running the harness + interpreting output. |
| `tests/policy-types.test.ts` | Create | Type-shape smoke tests (cheap invariants). |
| `tests/policy-stale-hint.test.ts` | Create | stale_hint correctness across touched/untouched/missing cases. |
| `tests/policy-dispatcher.test.ts` | Create | Rule routing, precedence, default allow. |
| `tests/policy-rules-grep.test.ts` | Create | Grep-on-code: deny/allow matrix mirroring current bash rules. |
| `tests/policy-entry.test.ts` | Create | Spawn compiled `dist/transports/policy-entry.js`, pipe JSON, assert stdout shape + exit code. |
| `tests/mcp.test.ts` | Modify | Add `nexus_policy_check` smoke test. |
| `CHANGELOG.md` | Modify | Entry under next unreleased version. |
| `CLAUDE.md` | Modify | Document new MCP tool + policy transport. |

---

### Task 1: Define policy types

**Files:**
- Create: `src/policy/types.ts`
- Test: `tests/policy-types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/policy-types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type {
  PolicyEvent,
  PolicyDecision,
  PolicyResponse,
  PolicyRule,
} from '../src/policy/types.js';

describe('policy types', () => {
  it('PolicyDecision is one of allow|ask|deny|noop', () => {
    const decisions: PolicyDecision['decision'][] = ['allow', 'ask', 'deny', 'noop'];
    expect(decisions).toEqual(['allow', 'ask', 'deny', 'noop']);
  });

  it('PolicyEvent is structurally a Claude Code PreToolUse payload', () => {
    const event: PolicyEvent = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
      session_id: 'test',
      cwd: '/tmp',
    };
    expect(event.tool_name).toBe('Grep');
  });

  it('PolicyResponse carries stale_hint and optional decision', () => {
    const resp: PolicyResponse = {
      decision: 'allow',
      stale_hint: false,
    };
    expect(resp.stale_hint).toBe(false);
  });

  it('PolicyRule has name + evaluate signature', () => {
    const rule: PolicyRule = {
      name: 'test-rule',
      evaluate: () => null,
    };
    expect(rule.name).toBe('test-rule');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/policy-types.test.ts`
Expected: FAIL — `src/policy/types.ts` does not exist.

- [ ] **Step 3: Create the types file**

Create `src/policy/types.ts`:

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
}

export interface PolicyResponse {
  decision: PolicyDecision['decision'];
  reason?: string;
  rule?: string;
  stale_hint: boolean;
}

export interface PolicyContext {
  rootDir: string;
  dbPath: string;
}

export interface PolicyRule {
  name: string;
  evaluate(event: PolicyEvent, ctx: PolicyContext): PolicyDecision | null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/policy-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/policy/types.ts tests/policy-types.test.ts
git commit -m "feat(policy): types — PolicyEvent, PolicyDecision, PolicyRule"
```

---

### Task 2: Implement stale_hint computation

**Files:**
- Create: `src/policy/stale-hint.ts`
- Test: `tests/policy-stale-hint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/policy-stale-hint.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDatabase, applySchema } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import { computeStaleHint } from '../src/policy/stale-hint.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stale-'));
  fs.mkdirSync(path.join(tmpDir, '.nexus'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLastIndexed(dbPath: string, iso: string) {
  const db = openDatabase(dbPath);
  applySchema(db);
  const store = new NexusStore(db);
  store.setMeta('last_indexed_at', iso);
  db.close();
}

describe('computeStaleHint', () => {
  it('returns false when no touched file given and index exists', () => {
    const dbPath = path.join(tmpDir, '.nexus', 'index.db');
    writeLastIndexed(dbPath, new Date().toISOString());
    const hint = computeStaleHint({ rootDir: tmpDir });
    expect(hint).toBe(false);
  });

  it('returns true when touched file mtime is newer than last_indexed_at', () => {
    const dbPath = path.join(tmpDir, '.nexus', 'index.db');
    const touched = path.join(tmpDir, 'src.ts');
    writeLastIndexed(dbPath, '2000-01-01T00:00:00Z');
    fs.writeFileSync(touched, 'x');
    const hint = computeStaleHint({ rootDir: tmpDir, touchedAbsPath: touched });
    expect(hint).toBe(true);
  });

  it('returns false when touched file mtime is older than last_indexed_at', () => {
    const dbPath = path.join(tmpDir, '.nexus', 'index.db');
    const touched = path.join(tmpDir, 'src.ts');
    fs.writeFileSync(touched, 'x');
    writeLastIndexed(dbPath, new Date(Date.now() + 60_000).toISOString());
    const hint = computeStaleHint({ rootDir: tmpDir, touchedAbsPath: touched });
    expect(hint).toBe(false);
  });

  it('returns true when DB is missing', () => {
    const hint = computeStaleHint({ rootDir: tmpDir });
    expect(hint).toBe(true);
  });

  it('returns false when touched file is missing (cannot disprove freshness)', () => {
    const dbPath = path.join(tmpDir, '.nexus', 'index.db');
    writeLastIndexed(dbPath, new Date().toISOString());
    const hint = computeStaleHint({
      rootDir: tmpDir,
      touchedAbsPath: path.join(tmpDir, 'does-not-exist.ts'),
    });
    expect(hint).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/policy-stale-hint.test.ts`
Expected: FAIL — `src/policy/stale-hint.ts` does not exist.

- [ ] **Step 3: Implement stale-hint**

Create `src/policy/stale-hint.ts`:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDatabase } from '../db/schema.js';

export interface StaleHintInput {
  rootDir: string;
  touchedAbsPath?: string;
}

/**
 * Best-effort staleness hint. True = the policy decision MAY be based on
 * out-of-date index state. The policy entry intentionally does not re-index.
 *
 * - No DB yet → stale (nothing has been indexed).
 * - No touched file → compare only against presence of last_indexed_at meta.
 * - Touched file exists → stale if its mtime is newer than last_indexed_at.
 * - Touched file missing → cannot prove staleness; return false.
 */
export function computeStaleHint(input: StaleHintInput): boolean {
  const dbPath = path.join(input.rootDir, '.nexus', 'index.db');
  if (!fs.existsSync(dbPath)) return true;

  let lastIndexedAtMs = 0;
  try {
    const db = openDatabase(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('last_indexed_at') as { value: string } | undefined;
    db.close();
    if (!row) return true;
    const t = Date.parse(row.value);
    if (Number.isNaN(t)) return true;
    lastIndexedAtMs = t;
  } catch {
    return true;
  }

  if (!input.touchedAbsPath) return false;

  try {
    const stat = fs.statSync(input.touchedAbsPath);
    return stat.mtimeMs > lastIndexedAtMs;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Extend openDatabase to accept readonly option**

`src/db/schema.ts:113` currently reads `export function openDatabase(dbPath: string): Database.Database { … }`. Replace the signature and body to:

```typescript
export function openDatabase(
  dbPath: string,
  opts?: { readonly?: boolean },
): Database.Database {
  const db = opts?.readonly
    ? new Database(dbPath, { readonly: true, fileMustExist: true })
    : new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  return db;
}
```

All existing callers use positional (path only), so `opts` being optional keeps them source-compatible. Confirm by running `npm run lint`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/policy-stale-hint.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 6: Verify no regression in db tests**

Run: `npm test -- tests/db.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/policy/stale-hint.ts src/db/schema.ts tests/policy-stale-hint.test.ts
git commit -m "feat(policy): stale_hint based on index mtime vs touched file"
```

---

### Task 3: First rule — Grep-on-code

**Files:**
- Create: `src/policy/rules/grep-on-code.ts`
- Test: `tests/policy-rules-grep.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/policy-rules-grep.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { grepOnCodeRule } from '../src/policy/rules/grep-on-code.js';
import type { PolicyEvent, PolicyContext } from '../src/policy/types.js';

const ctx: PolicyContext = { rootDir: '/tmp', dbPath: '/tmp/.nexus/index.db' };

function ev(tool: string, input: Record<string, unknown>): PolicyEvent {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
}

describe('grepOnCodeRule', () => {
  it('denies bare Grep (no allowlist match)', () => {
    const d = grepOnCodeRule.evaluate(ev('Grep', { pattern: 'foo' }), ctx);
    expect(d?.decision).toBe('deny');
    expect(d?.rule).toBe('grep-on-code');
  });

  it('allows Grep when glob filter is a non-code extension', () => {
    const d = grepOnCodeRule.evaluate(ev('Grep', { pattern: 'foo', glob: '*.md' }), ctx);
    expect(d?.decision).toBe('allow');
  });

  it('allows Grep when type is a non-code type', () => {
    const d = grepOnCodeRule.evaluate(ev('Grep', { pattern: 'foo', type: 'md' }), ctx);
    expect(d?.decision).toBe('allow');
  });

  it('allows Grep on node_modules', () => {
    const d = grepOnCodeRule.evaluate(ev('Grep', { pattern: 'foo', path: 'node_modules/react' }), ctx);
    expect(d?.decision).toBe('allow');
  });

  it('allows Grep on docs/', () => {
    const d = grepOnCodeRule.evaluate(ev('Grep', { pattern: 'foo', path: 'docs/whatever.md' }), ctx);
    expect(d?.decision).toBe('allow');
  });

  it('ignores non-Grep tools', () => {
    const d = grepOnCodeRule.evaluate(ev('Glob', { pattern: '*.ts' }), ctx);
    expect(d).toBeNull();
  });

  it('ignores Grep with non-string input (defensive)', () => {
    const d = grepOnCodeRule.evaluate(
      { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 123 } },
      ctx,
    );
    expect(d?.decision).toBe('deny');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/policy-rules-grep.test.ts`
Expected: FAIL — `src/policy/rules/grep-on-code.ts` does not exist.

- [ ] **Step 3: Implement the rule**

Create `src/policy/rules/grep-on-code.ts`:

```typescript
import type { PolicyRule } from '../types.js';

const NON_CODE_EXT = /\.(md|json|yaml|yml|toml|env|lock|txt|csv|html|xml|sql|sh|bat|cmd|log)$/i;
const NON_CODE_TYPE = /^(md|json|yaml|yml|toml)$/i;
const NON_CODE_PATH = /(node_modules|\.git|\.nexus|\/?docs\/|\.env|\.claude\/)/i;

const DENY_REASON =
  'NEXUS ONLY: Use nexus_find, nexus_refs, nexus_search, or nexus_grep instead of Grep for code files. Grep is NOT allowed for code — use Nexus.';

export const grepOnCodeRule: PolicyRule = {
  name: 'grep-on-code',
  evaluate(event) {
    if (event.tool_name !== 'Grep') return null;

    const input = event.tool_input;
    const glob = typeof input.glob === 'string' ? input.glob : '';
    const type = typeof input.type === 'string' ? input.type : '';
    const searchPath = typeof input.path === 'string' ? input.path : '';

    if (glob && NON_CODE_EXT.test(glob)) {
      return { decision: 'allow', rule: 'grep-on-code', reason: 'non-code glob' };
    }
    if (type && NON_CODE_TYPE.test(type)) {
      return { decision: 'allow', rule: 'grep-on-code', reason: 'non-code type' };
    }
    if (searchPath && NON_CODE_PATH.test(searchPath)) {
      return { decision: 'allow', rule: 'grep-on-code', reason: 'non-code path' };
    }

    return { decision: 'deny', rule: 'grep-on-code', reason: DENY_REASON };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/policy-rules-grep.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/policy/rules/grep-on-code.ts tests/policy-rules-grep.test.ts
git commit -m "feat(policy): grep-on-code rule — port nexus-first Grep allowlist to TS"
```

---

### Task 4: Implement dispatcher

**Files:**
- Create: `src/policy/dispatcher.ts`
- Create: `src/policy/index.ts`
- Test: `tests/policy-dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/policy-dispatcher.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { dispatchPolicy } from '../src/policy/dispatcher.js';
import { openDatabase, applySchema } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import type { PolicyRule, PolicyEvent } from '../src/policy/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-disp-'));
  fs.mkdirSync(path.join(tmpDir, '.nexus'), { recursive: true });
  const db = openDatabase(path.join(tmpDir, '.nexus', 'index.db'));
  applySchema(db);
  new NexusStore(db).setMeta('last_indexed_at', new Date().toISOString());
  db.close();
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function ev(tool = 'Grep', input: Record<string, unknown> = { pattern: 'x' }): PolicyEvent {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
}

describe('dispatchPolicy', () => {
  it('defaults to allow when no rule matches', () => {
    const resp = dispatchPolicy(ev('UnknownTool'), { rootDir: tmpDir, rules: [] });
    expect(resp.decision).toBe('allow');
    expect(resp.stale_hint).toBe(false);
  });

  it('first explicit non-null rule decision wins', () => {
    const ruleA: PolicyRule = { name: 'A', evaluate: () => ({ decision: 'deny', rule: 'A' }) };
    const ruleB: PolicyRule = { name: 'B', evaluate: () => ({ decision: 'allow', rule: 'B' }) };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [ruleA, ruleB] });
    expect(resp.decision).toBe('deny');
    expect(resp.rule).toBe('A');
  });

  it('skips rules that return null', () => {
    const ruleA: PolicyRule = { name: 'A', evaluate: () => null };
    const ruleB: PolicyRule = { name: 'B', evaluate: () => ({ decision: 'allow', rule: 'B' }) };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [ruleA, ruleB] });
    expect(resp.decision).toBe('allow');
    expect(resp.rule).toBe('B');
  });

  it('attaches stale_hint=true when index missing', () => {
    fs.rmSync(path.join(tmpDir, '.nexus'), { recursive: true });
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [] });
    expect(resp.stale_hint).toBe(true);
  });

  it('noop rule decision does not block default allow fallthrough', () => {
    const ruleA: PolicyRule = { name: 'A', evaluate: () => ({ decision: 'noop', rule: 'A' }) };
    const ruleB: PolicyRule = { name: 'B', evaluate: () => ({ decision: 'deny', rule: 'B' }) };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [ruleA, ruleB] });
    expect(resp.decision).toBe('deny');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/policy-dispatcher.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement dispatcher**

Create `src/policy/dispatcher.ts`:

```typescript
import * as path from 'node:path';
import { computeStaleHint } from './stale-hint.js';
import type { PolicyEvent, PolicyResponse, PolicyRule } from './types.js';

export interface DispatchOptions {
  rootDir: string;
  rules: PolicyRule[];
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
  const ctx = {
    rootDir: opts.rootDir,
    dbPath: path.join(opts.rootDir, '.nexus', 'index.db'),
  };

  for (const rule of opts.rules) {
    const decision = rule.evaluate(event, ctx);
    if (!decision || decision.decision === 'noop') continue;
    return {
      decision: decision.decision,
      reason: decision.reason,
      rule: decision.rule,
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
      return path.isAbsolute(v) ? v : path.resolve(rootDir, v);
    }
  }
  return undefined;
}
```

Create `src/policy/index.ts`:

```typescript
export type {
  PolicyEvent,
  PolicyDecision,
  PolicyResponse,
  PolicyContext,
  PolicyRule,
} from './types.js';
export { dispatchPolicy } from './dispatcher.js';
export type { DispatchOptions } from './dispatcher.js';
export { computeStaleHint } from './stale-hint.js';
export { grepOnCodeRule } from './rules/grep-on-code.js';

import { grepOnCodeRule } from './rules/grep-on-code.js';
import type { PolicyRule } from './types.js';

/** Default rule set shipped with Nexus. Extend in follow-up plans. */
export const DEFAULT_RULES: PolicyRule[] = [grepOnCodeRule];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/policy-dispatcher.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/policy/dispatcher.ts src/policy/index.ts tests/policy-dispatcher.test.ts
git commit -m "feat(policy): dispatcher + DEFAULT_RULES export"
```

---

### Task 5: Micro-entrypoint — `policy-entry.ts`

**Files:**
- Create: `src/transports/policy-entry.ts`
- Test: `tests/policy-entry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/policy-entry.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const ENTRY = path.resolve('dist/transports/policy-entry.js');

beforeAll(() => {
  // Make sure the build output exists. If not, fail fast with a clear message.
  if (!fs.existsSync(ENTRY)) {
    throw new Error(`policy-entry not built. Run "npm run build" before this test.`);
  }
});

function run(stdinJson: unknown, cwd = process.cwd()) {
  return spawnSync('node', [ENTRY], {
    input: JSON.stringify(stdinJson),
    encoding: 'utf-8',
    cwd,
  });
}

describe('policy-entry', () => {
  it('denies Grep on a code file with reason text', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('deny');
    expect(typeof parsed.reason).toBe('string');
    expect(parsed.reason).toMatch(/NEXUS ONLY/);
    expect(typeof parsed.stale_hint).toBe('boolean');
  });

  it('allows Grep on a non-code glob', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'foo', glob: '*.md' },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
  });

  it('defaults to allow on unmatched tools', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
  });

  it('exits 0 with decision=allow on malformed stdin', () => {
    const result = run('not-json-at-all');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
    expect(parsed.rule).toBe('parse-error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npm test -- tests/policy-entry.test.ts`
Expected: FAIL — `dist/transports/policy-entry.js` does not exist after build, or tests error on missing entry.

- [ ] **Step 3: Implement the entry**

Create `src/transports/policy-entry.ts`:

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

import { detectRoot } from '../workspace/detector.js';
import { dispatchPolicy } from '../policy/dispatcher.js';
import { DEFAULT_RULES } from '../policy/index.js';
import type { PolicyEvent, PolicyResponse } from '../policy/types.js';

function readStdinSync(): string {
  try {
    // Node exposes fd 0 synchronously; empty stdin → empty string.
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(65536);
    const fs = require('node:fs') as typeof import('node:fs');
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
      chunks.push(Buffer.from(buf.slice(0, n)));
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

  const response = dispatchPolicy(event, { rootDir, rules: DEFAULT_RULES });
  process.stdout.write(JSON.stringify(response));
}

main();
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npm test -- tests/policy-entry.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/transports/policy-entry.ts tests/policy-entry.test.ts
git commit -m "feat(transports): nexus-policy-check micro-entrypoint (stdin JSON → stdout decision)"
```

---

### Task 6: Register the second bin

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Add to `tests/cli.test.ts` in a new describe block:

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('package.json bins', () => {
  it('registers nexus-policy-check alongside nexus', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({
      nexus: 'dist/transports/cli.js',
      'nexus-policy-check': 'dist/transports/policy-entry.js',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/cli.test.ts`
Expected: FAIL — `nexus-policy-check` not in `bin`.

- [ ] **Step 3: Add the bin**

Edit `package.json`:

```json
  "bin": {
    "nexus": "dist/transports/cli.js",
    "nexus-policy-check": "dist/transports/policy-entry.js"
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/cli.test.ts
git commit -m "chore(pkg): expose nexus-policy-check as second bin"
```

---

### Task 7: Add `nexus_policy_check` MCP tool

**Files:**
- Modify: `src/transports/mcp.ts`
- Modify: `tests/mcp.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/mcp.test.ts` already has `getRegisteredTools()` (around line 74) that reaches into `server._requestHandlers`. Reuse that helper, and add a sibling `callTool()` helper at the top of the file (below `getRegisteredTools`):

```typescript
async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const server = createMcpServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = (server as any)._requestHandlers as Map<string, (req: unknown, extra: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>>;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('tools/call handler not registered');
  return handler({ method: 'tools/call', params: { name, arguments: args } }, {});
}
```

Then add this describe block:

```typescript
describe('nexus_policy_check tool', () => {
  it('is listed in tools/list', async () => {
    const tools = await getRegisteredTools();
    expect(tools.find(t => t.name === 'nexus_policy_check')).toBeDefined();
  });

  it('has event in required schema properties', async () => {
    const tools = await getRegisteredTools();
    const tool = tools.find(t => t.name === 'nexus_policy_check');
    const schema = tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty('event');
    expect(schema.required).toEqual(expect.arrayContaining(['event']));
  });

  it('dispatches a Grep-on-code event and returns a deny decision', async () => {
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'foo' },
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].decision).toBe('deny');
    expect(typeof payload.results[0].stale_hint).toBe('boolean');
  });

  it('returns allow for a non-Grep event', async () => {
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'README.md' },
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].decision).toBe('allow');
  });
});
```

**On the "does not call ensureFresh" contract:** not asserted by a test here — the contract is guarded by the code structure in Task 7 Step 3 (the branch sits before `ensureFresh()` in the CallToolRequest handler, just like `nexus_reindex`). Reviewed at PR time, not at runtime. Adding a reliable mock of `runIndex` would require restructuring imports and is out of scope for this plan.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/mcp.test.ts`
Expected: FAIL — `nexus_policy_check` not registered.

- [ ] **Step 3: Register the tool**

In `src/transports/mcp.ts`, inside the `ListToolsRequestSchema` handler's tool array, add:

```typescript
{
  name: 'nexus_policy_check',
  description:
    'Evaluate the Nexus policy layer against a hook event. Fallback for platforms without PreToolUse hook support; otherwise hook dispatchers should call the nexus-policy-check bin directly. Does NOT trigger a reindex — responses carry stale_hint.',
  inputSchema: {
    type: 'object',
    properties: {
      event: {
        type: 'object',
        description: 'Claude Code hook event payload',
        properties: {
          hook_event_name: { type: 'string' },
          tool_name: { type: 'string' },
          tool_input: { type: 'object' },
          session_id: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['tool_name', 'tool_input'],
      },
      ...COMPACT_PROP,
    },
    required: ['event'],
  },
},
```

In the `dispatch` function switch, add a case **before** the default:

```typescript
case 'nexus_policy_check': {
  const event = args.event as PolicyEvent;
  const rootDir = indexRootDir ?? process.cwd();
  const response = dispatchPolicy(event, { rootDir, rules: DEFAULT_RULES });
  // Wrap as NexusResult<PolicyResponse> so respond() / compactify() work.
  return {
    type: 'policy_check',
    query: `policy_check ${event.tool_name}`,
    results: [response],
    count: 1,
    index_status: 'current',
    index_health: 'ok',
    timing_ms: 0,
  };
}
```

Add imports at the top of `src/transports/mcp.ts`:

```typescript
import { dispatchPolicy } from '../policy/dispatcher.js';
import { DEFAULT_RULES } from '../policy/index.js';
import type { PolicyEvent } from '../policy/types.js';
```

**Critical:** Handle `nexus_policy_check` in the `CallToolRequest` handler BEFORE `ensureFresh()` is called (same branch as `nexus_reindex` — it must not trigger a reindex on the hot path):

```typescript
// Near line 619, inside server.setRequestHandler(CallToolRequestSchema, …):
if (name === 'nexus_reindex') { /* existing */ }

if (name === 'nexus_policy_check') {
  const result = dispatch(name, args);
  return respond(result, compact);
}

// Auto-refresh if stale (>30s since last check)
ensureFresh();
```

Also extend `NexusResultType` in `src/query/engine.ts` to include `'policy_check'`. Find the union and add the new literal.

- [ ] **Step 4: Extend NexusResultType**

In `src/query/engine.ts`, around line 21-45 where `NexusResultType` is defined, add `'policy_check'` to the union.

- [ ] **Step 5: Run full test suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/transports/mcp.ts src/query/engine.ts tests/mcp.test.ts
git commit -m "feat(mcp): nexus_policy_check tool (hook-less fallback, no ensureFresh)"
```

---

### Task 8: Public re-exports

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/e2e.test.ts` (or wherever public API is asserted):

```typescript
describe('public policy API', () => {
  it('re-exports policy primitives', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.dispatchPolicy).toBe('function');
    expect(Array.isArray(mod.DEFAULT_RULES)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/e2e.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Add re-exports**

Edit `src/index.ts`. Add at the end (or wherever other transport re-exports live):

```typescript
export type {
  PolicyEvent,
  PolicyDecision,
  PolicyResponse,
  PolicyContext,
  PolicyRule,
} from './policy/types.js';
export { dispatchPolicy, DEFAULT_RULES, computeStaleHint } from './policy/index.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npm test -- tests/e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/e2e.test.ts
git commit -m "feat(api): export policy primitives from root index"
```

---

### Task 9: Migrate nexus-first.sh Grep branch

**Files:**
- Modify: `hooks/nexus-first.sh`

- [ ] **Step 1: Rewrite the Grep branch to delegate**

Replace the Grep-branch block (`if [ "$TOOL_NAME" = "Grep" ] || [ "$TOOL_NAME" = "Glob" ]; then … fi`) with:

```bash
# ── Grep: delegate to nexus-policy-check ─────────────────────────────
if [ "$TOOL_NAME" = "Grep" ]; then
  # Find the policy binary. Prefer npx (picks up local install), fall back to PATH.
  if command -v nexus-policy-check >/dev/null 2>&1; then
    DECISION=$(echo "$INPUT" | nexus-policy-check)
  else
    DECISION=$(echo "$INPUT" | npx --no-install nexus-policy-check 2>/dev/null)
  fi

  # If we got no output (binary missing, crashed), fall open — never block on infra failures.
  if [ -z "$DECISION" ]; then
    exit 0
  fi

  PERMISSION=$(echo "$DECISION" | jq -r '.decision // "allow"')
  REASON=$(echo "$DECISION" | jq -r '.reason // ""')

  if [ "$PERMISSION" = "deny" ]; then
    jq -n --arg reason "$REASON" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
    exit 0
  fi
  exit 0
fi

# ── Glob: always allow (file discovery) ──────────────────────────────
if [ "$TOOL_NAME" = "Glob" ]; then
  exit 0
fi
```

Keep the Agent branch unchanged for this plan — it migrates separately.

- [ ] **Step 2: Manual smoke check (no unit test — bash is out of Vitest scope)**

Build: `npm run build`

Verify the entry exists: `ls dist/transports/policy-entry.js`

Pipe a Grep event:
```bash
echo '{"tool_name":"Grep","tool_input":{"pattern":"foo"}}' | node dist/transports/policy-entry.js
```
Expected stdout: JSON with `"decision":"deny"` and `"reason":"NEXUS ONLY: …"`.

Pipe an allowed event:
```bash
echo '{"tool_name":"Grep","tool_input":{"pattern":"foo","glob":"*.md"}}' | node dist/transports/policy-entry.js
```
Expected stdout: JSON with `"decision":"allow"`.

- [ ] **Step 3: Commit**

```bash
git add hooks/nexus-first.sh
git commit -m "refactor(hooks): nexus-first.sh Grep branch delegates to nexus-policy-check"
```

---

### Task 10: Latency benchmark scaffold

**Files:**
- Create: `benchmarks/policy-latency.ts`
- Create: `benchmarks/README.md`

- [ ] **Step 1: Create the harness**

Written as plain `.mjs` so no TS toolchain is needed — the project does not ship `tsx`. Create `benchmarks/policy-latency.mjs`:

```javascript
// Ad-hoc latency harness for nexus-policy-check. NOT part of `npm test`.
// Run with: `node benchmarks/policy-latency.mjs` (after `npm run build`).
//
// Informational only — per the V3 roadmap, the CI gate fails only on 3
// consecutive main-branch regressions, not on a single run.

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ITERATIONS = 200;
const ENTRY = path.resolve('dist/transports/policy-entry.js');

const events = [
  { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'foo' } },
  { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'foo', glob: '*.md' } },
  { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' } },
];

const timings = [];
for (let i = 0; i < ITERATIONS; i++) {
  const event = events[i % events.length];
  const start = process.hrtime.bigint();
  spawnSync('node', [ENTRY], { input: JSON.stringify(event), encoding: 'utf-8' });
  const end = process.hrtime.bigint();
  timings.push(Number(end - start) / 1_000_000);
}

timings.sort((a, b) => a - b);
const p = (q) => timings[Math.floor(timings.length * q)];
const summary = {
  iterations: ITERATIONS,
  p50_ms: Number(p(0.5).toFixed(2)),
  p95_ms: Number(p(0.95).toFixed(2)),
  p99_ms: Number(p(0.99).toFixed(2)),
  max_ms: Number(timings[timings.length - 1].toFixed(2)),
  target: { p50_ms: 50, p95_ms: 150 },
  timestamp: new Date().toISOString(),
};
console.log(JSON.stringify(summary, null, 2));
```

Create `benchmarks/README.md`:

```markdown
# Nexus Benchmarks

## Policy latency

`policy-latency.mjs` spawns the compiled `nexus-policy-check` bin N times and
reports p50/p95/p99. Per the V3 roadmap, targets are p50 < 50ms and p95 < 150ms
on representative payloads. Single-run regressions are not blocking — CI only
fails on three consecutive main-branch regressions.

Run locally:

```bash
npm run build
node benchmarks/policy-latency.mjs
```

Output is JSON; commit historical runs to `benchmarks/policy-latency.json` if
desired (not automated in this plan).
```

- [ ] **Step 2: Verify the harness compiles and runs**

```bash
npm run build
node benchmarks/policy-latency.mjs
```
Expected: JSON summary printed. No assertion — informational only.

- [ ] **Step 3: Commit**

```bash
git add benchmarks/
git commit -m "chore(bench): policy latency harness (non-blocking)"
```

---

### Task 11: Docs + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add CHANGELOG entry**

Add to the top of `CHANGELOG.md`:

```markdown
## [Unreleased]

### Added
- **Policy transport** — new `nexus-policy-check` bin and `src/policy/` layer.
  PreToolUse hooks can consult Nexus policy without spawning the full CLI.
  Every response carries `stale_hint: boolean`; the entry does not reindex.
- **`nexus_policy_check` MCP tool** — hook-less fallback that evaluates policy
  against a Claude Code hook event. Does not trigger `ensureFresh()`.
- **First reference rule** — `grep-on-code`: ports the Grep allow-list from
  `hooks/nexus-first.sh` to TypeScript.

### Changed
- `hooks/nexus-first.sh` Grep branch now delegates to `nexus-policy-check`;
  Agent and Glob branches unchanged.
```

- [ ] **Step 2: Add CLAUDE.md entry**

Under the existing MCP tool list in `CLAUDE.md`, add:

```markdown
**Policy transport:** `nexus_policy_check` — evaluate a Claude Code hook event
against the Nexus policy layer. Dedicated `nexus-policy-check` bin for the
PreToolUse hot path (no CLI spin-up, no reindex). Every response carries
`stale_hint`. See `src/policy/` for rules.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: policy transport in CHANGELOG + CLAUDE.md"
```

---

### Verification — end of plan

- [ ] `npm run build` — clean.
- [ ] `npm test` — all green.
- [ ] `echo '{"tool_name":"Grep","tool_input":{"pattern":"foo"}}' | node dist/transports/policy-entry.js` → `{"decision":"deny", …, "stale_hint": …}`.
- [ ] `echo '{"tool_name":"Grep","tool_input":{"pattern":"foo","glob":"*.md"}}' | node dist/transports/policy-entry.js` → `{"decision":"allow", …}`.
- [ ] `node benchmarks/policy-latency.mjs` — p95 ideally < 150ms (informational; not blocking).
- [ ] `hooks/nexus-first.sh` still blocks Grep on code and allows Grep on docs.
- [ ] MCP: `nexus_policy_check` listed by tools/list and returns a deny response for the Grep-on-code case.
