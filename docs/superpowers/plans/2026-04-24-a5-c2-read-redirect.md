# A5/C2 Read-Redirect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two `PolicyRule`s (`read-on-structured`, `read-on-source`) that route `Read` events through the existing `nexus-policy-check` pipeline. Structured configs/lockfiles return `ask` with a suggested structured tool; indexed source files without `offset`/`limit` return `allow` with `additionalContext` nudging Claude toward `nexus_outline`/`nexus_source`.

**Architecture:** Two rules under `src/policy/rules/` registered in `DEFAULT_RULES`. One small type-layer change adds an optional `additional_context?: string` field to `PolicyDecision` and `PolicyResponse`; the dispatcher forwards it from rule → response. One small bash change adds a `Read` branch to `hooks/nexus-first.sh`. No new binaries, no new MCP tools, no schema bump.

**Tech Stack:** TypeScript (strict, ESM), Vitest, better-sqlite3, bash + jq for the hook dispatcher.

**Spec reference:** `docs/superpowers/specs/2026-04-24-a5-c2-read-redirect-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/policy/rules/common-paths.ts` | Create | Shared `NON_CODE_PATH` regex. |
| `src/policy/rules/grep-on-code.ts` | Modify | Import `NON_CODE_PATH` from common-paths. |
| `src/policy/rules/read-on-structured.ts` | Create | `ask` decision for structured configs + lockfiles. |
| `src/policy/rules/read-on-source.ts` | Create | `allow` + `additional_context` for bare Reads on source. |
| `src/policy/types.ts` | Modify | Add `additional_context?: string` to `PolicyDecision` and `PolicyResponse`. |
| `src/policy/dispatcher.ts` | Modify | Forward `additional_context` from decision to response (not on deny). |
| `src/policy/index.ts` | Modify | Register both new rules in `DEFAULT_RULES`; export them. |
| `hooks/nexus-first.sh` | Modify | New `Read` branch that emits `ask` or `allow+additionalContext`. |
| `tests/policy-rules-grep.test.ts` | Modify | Verify still-green after regex extraction (no behavior change). |
| `tests/policy-rules-read-structured.test.ts` | Create | Matrix over every structured `FileKind` + negatives. |
| `tests/policy-rules-read-source.test.ts` | Create | Source match + negatives (paging, excluded paths, non-source). |
| `tests/policy-types.test.ts` | Modify | Compile-check `additional_context` field. |
| `tests/policy-dispatcher.test.ts` | Modify | Three-rule integration + `additional_context` forwarding. |
| `tests/policy-entry.test.ts` | Modify | Spawn bin with Read events; assert decision/reason/context. |
| `tests/mcp.test.ts` | Modify | Call `nexus_policy_check` with Read events. |
| `CHANGELOG.md` | Modify | Unreleased entry. |
| `CLAUDE.md` | Modify | Document new rules under policy transport section. |
| `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md` | Modify | Mark A5/C2 shipped. |

---

## Task 1: Extract `NON_CODE_PATH` to `common-paths.ts`

**Files:**
- Create: `src/policy/rules/common-paths.ts`
- Modify: `src/policy/rules/grep-on-code.ts`
- Test: `tests/policy-rules-grep.test.ts` (no change — verify still passes)

This is a pure refactor so that `read-on-source` can share the regex without duplication. No behavior change.

- [ ] **Step 1: Create the shared-regex module**

Create `src/policy/rules/common-paths.ts`:

```typescript
/**
 * Path fragments that are not "code" for the purpose of policy rules.
 * Shared between grep-on-code and read-on-source. Matches are substring-based
 * (case-insensitive) — path need not start with the fragment.
 */
export const NON_CODE_PATH = /(node_modules|\.git|\.nexus|\/?docs\/|\.env|\.claude\/)/i;
```

- [ ] **Step 2: Update `grep-on-code.ts` to import from common-paths**

Replace the `NON_CODE_PATH` constant declaration in `src/policy/rules/grep-on-code.ts` with an import:

```typescript
import type { PolicyRule } from '../types.js';
import { NON_CODE_PATH } from './common-paths.js';

const NON_CODE_EXT = /\.(md|json|yaml|yml|toml|env|lock|txt|csv|html|xml|sql|sh|bat|cmd|log)$/i;
const NON_CODE_TYPE = /^(md|json|yaml|yml|toml)$/i;

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

- [ ] **Step 3: Run existing Grep rule tests**

Run: `npx vitest run tests/policy-rules-grep.test.ts`
Expected: PASS (all existing cases; refactor preserves behavior).

- [ ] **Step 4: Commit**

```bash
git add src/policy/rules/common-paths.ts src/policy/rules/grep-on-code.ts
git commit -m "refactor(policy): extract NON_CODE_PATH to common-paths.ts"
```

---

## Task 2: Add `additional_context?` field to policy types

**Files:**
- Modify: `src/policy/types.ts`
- Test: `tests/policy-types.test.ts`

- [ ] **Step 1: Extend the type-shape test**

Open `tests/policy-types.test.ts` and add a new test inside the existing `describe('policy types', …)` block, after the `PolicyResponse carries stale_hint` test:

```typescript
  it('PolicyDecision and PolicyResponse accept optional additional_context', () => {
    const decision: PolicyDecision = {
      decision: 'allow',
      rule: 'x',
      additional_context: 'use nexus_outline',
    };
    const resp: PolicyResponse = {
      decision: 'allow',
      stale_hint: false,
      additional_context: 'use nexus_outline',
    };
    expect(decision.additional_context).toBe('use nexus_outline');
    expect(resp.additional_context).toBe('use nexus_outline');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/policy-types.test.ts`
Expected: FAIL — compiler error `Object literal may only specify known properties, and 'additional_context' does not exist in type 'PolicyDecision'`.

- [ ] **Step 3: Extend the types**

Edit `src/policy/types.ts`. Replace the `PolicyDecision` and `PolicyResponse` interfaces with:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/policy-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/policy/types.ts tests/policy-types.test.ts
git commit -m "feat(policy): add additional_context? to PolicyDecision + PolicyResponse"
```

---

## Task 3: Forward `additional_context` in the dispatcher

**Files:**
- Modify: `src/policy/dispatcher.ts`
- Test: `tests/policy-dispatcher.test.ts`

- [ ] **Step 1: Add dispatcher tests for additional_context forwarding**

Append these tests to the existing `describe('dispatchPolicy', …)` block in `tests/policy-dispatcher.test.ts`:

```typescript
  it('forwards additional_context on allow', () => {
    const rule: PolicyRule = {
      name: 'A',
      evaluate: () => ({
        decision: 'allow',
        rule: 'A',
        additional_context: 'try nexus_outline',
      }),
    };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [rule] });
    expect(resp.decision).toBe('allow');
    expect(resp.additional_context).toBe('try nexus_outline');
  });

  it('forwards additional_context on ask', () => {
    const rule: PolicyRule = {
      name: 'A',
      evaluate: () => ({
        decision: 'ask',
        rule: 'A',
        additional_context: 'prefer nexus_structured_query',
        reason: 'use structured',
      }),
    };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [rule] });
    expect(resp.decision).toBe('ask');
    expect(resp.additional_context).toBe('prefer nexus_structured_query');
  });

  it('drops additional_context on deny', () => {
    const rule: PolicyRule = {
      name: 'A',
      evaluate: () => ({
        decision: 'deny',
        rule: 'A',
        additional_context: 'would be inappropriate here',
        reason: 'nope',
      }),
    };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [rule] });
    expect(resp.decision).toBe('deny');
    expect(resp.additional_context).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/policy-dispatcher.test.ts`
Expected: FAIL on the 3 new tests — `additional_context` is undefined in the response.

- [ ] **Step 3: Implement forwarding in the dispatcher**

In `src/policy/dispatcher.ts`, replace the inner return statement inside the `for (const rule of opts.rules)` loop with:

```typescript
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
```

The default-allow fallthrough at the bottom of the function is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/policy-dispatcher.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/policy/dispatcher.ts tests/policy-dispatcher.test.ts
git commit -m "feat(policy): forward additional_context from rule to response"
```

---

## Task 4: Implement `readOnStructuredRule`

**Files:**
- Create: `src/policy/rules/read-on-structured.ts`
- Test: `tests/policy-rules-read-structured.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/policy-rules-read-structured.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readOnStructuredRule } from '../src/policy/rules/read-on-structured.js';
import type { PolicyEvent, PolicyContext } from '../src/policy/types.js';

const ctx: PolicyContext = { rootDir: '/tmp', dbPath: '/tmp/.nexus/index.db' };

function ev(tool: string, input: Record<string, unknown>): PolicyEvent {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
}

describe('readOnStructuredRule', () => {
  const structuredCases: Array<[string, string, RegExp]> = [
    ['package.json', 'package_json', /nexus_structured_query|nexus_structured_outline/],
    ['tsconfig.json', 'tsconfig_json', /nexus_structured_query|nexus_structured_outline/],
    ['Cargo.toml', 'cargo_toml', /nexus_structured_query|nexus_structured_outline/],
    ['.github/workflows/ci.yml', 'gha_workflow', /nexus_structured_query|nexus_structured_outline/],
    ['some-config.json', 'json_generic', /nexus_structured_query|nexus_structured_outline/],
    ['some-config.yaml', 'yaml_generic', /nexus_structured_query|nexus_structured_outline/],
    ['some-config.toml', 'toml_generic', /nexus_structured_query|nexus_structured_outline/],
  ];

  for (const [filePath, , reasonPattern] of structuredCases) {
    it(`asks for ${filePath}`, () => {
      const d = readOnStructuredRule.evaluate(ev('Read', { file_path: filePath }), ctx);
      expect(d?.decision).toBe('ask');
      expect(d?.rule).toBe('read-on-structured');
      expect(d?.reason).toMatch(reasonPattern);
    });
  }

  const lockfileCases: Array<[string, string]> = [
    ['yarn.lock', 'yarn_lock'],
    ['package-lock.json', 'package_lock'],
    ['pnpm-lock.yaml', 'pnpm_lock'],
    ['Cargo.lock', 'cargo_lock'],
  ];

  for (const [filePath] of lockfileCases) {
    it(`asks for ${filePath} with nexus_lockfile_deps suggestion`, () => {
      const d = readOnStructuredRule.evaluate(ev('Read', { file_path: filePath }), ctx);
      expect(d?.decision).toBe('ask');
      expect(d?.rule).toBe('read-on-structured');
      expect(d?.reason).toMatch(/nexus_lockfile_deps/);
    });
  }

  it('returns null for source files', () => {
    const d = readOnStructuredRule.evaluate(ev('Read', { file_path: 'src/foo.ts' }), ctx);
    expect(d).toBeNull();
  });

  it('returns null for ignored kinds (e.g. README.md)', () => {
    const d = readOnStructuredRule.evaluate(ev('Read', { file_path: 'README.md' }), ctx);
    expect(d).toBeNull();
  });

  it('returns null for non-Read tools', () => {
    const d = readOnStructuredRule.evaluate(ev('Edit', { file_path: 'package.json' }), ctx);
    expect(d).toBeNull();
  });

  it('returns null when file_path is missing', () => {
    const d = readOnStructuredRule.evaluate(ev('Read', {}), ctx);
    expect(d).toBeNull();
  });

  it('returns null when file_path is not a string', () => {
    const d = readOnStructuredRule.evaluate(ev('Read', { file_path: 123 }), ctx);
    expect(d).toBeNull();
  });

  it('normalizes backslash paths (Windows)', () => {
    const d = readOnStructuredRule.evaluate(ev('Read', { file_path: 'src\\..\\package.json' }), ctx);
    // Path is not exact-basename `package.json` (it has `..`), but the basename
    // extraction should still find `package.json` as the final segment.
    expect(d?.decision).toBe('ask');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/policy-rules-read-structured.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the rule**

Create `src/policy/rules/read-on-structured.ts`:

```typescript
import * as path from 'node:path';
import type { PolicyRule } from '../types.js';
import { classifyPath, type FileKind } from '../../workspace/classify.js';

const EMPTY_CONFIG = { languages: {} };

const STRUCTURED_REASON = (kind: string) =>
  `Use nexus_structured_query or nexus_structured_outline instead of Read for ${kind}. ` +
  `These tools return the parsed value by path or a shallow outline — cheaper than reading the whole file.`;

const LOCKFILE_REASON = (kind: string) =>
  `Use nexus_lockfile_deps(file, name?) instead of Read for ${kind}. ` +
  `It returns {name, version} entries directly — no JSON/YAML/TOML walking needed.`;

/**
 * Read on a structured config / lockfile → suggest the appropriate Nexus tool.
 * Returns `decision: 'ask'` so the user gets a permission prompt with the
 * suggestion. Never denies.
 *
 * No DB I/O: classification is purely path-based via A1's classifyPath().
 */
export const readOnStructuredRule: PolicyRule = {
  name: 'read-on-structured',
  evaluate(event) {
    if (event.tool_name !== 'Read') return null;

    const raw = event.tool_input.file_path;
    if (typeof raw !== 'string' || raw.length === 0) return null;

    const normalized = raw.replace(/\\/g, '/');
    const basename = path.posix.basename(normalized);
    if (basename.length === 0) return null;

    let kind: FileKind;
    try {
      kind = classifyPath(normalized, basename, EMPTY_CONFIG);
    } catch {
      return null;
    }

    const reason = reasonFor(kind);
    if (reason === null) return null;

    return { decision: 'ask', rule: 'read-on-structured', reason };
  },
};

function reasonFor(kind: FileKind): string | null {
  switch (kind.kind) {
    case 'package_json':
    case 'tsconfig_json':
    case 'cargo_toml':
    case 'gha_workflow':
    case 'json_generic':
    case 'yaml_generic':
    case 'toml_generic':
      return STRUCTURED_REASON(kind.kind);
    case 'package_lock':
    case 'yarn_lock':
    case 'pnpm_lock':
    case 'cargo_lock':
      return LOCKFILE_REASON(kind.kind);
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/policy-rules-read-structured.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/policy/rules/read-on-structured.ts tests/policy-rules-read-structured.test.ts
git commit -m "feat(policy): read-on-structured rule (ask + suggest structured tool)"
```

---

## Task 5: Implement `readOnSourceRule`

**Files:**
- Create: `src/policy/rules/read-on-source.ts`
- Test: `tests/policy-rules-read-source.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/policy-rules-read-source.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readOnSourceRule } from '../src/policy/rules/read-on-source.js';
import type { PolicyEvent, PolicyContext } from '../src/policy/types.js';

const ctx: PolicyContext = { rootDir: '/tmp', dbPath: '/tmp/.nexus/index.db' };

function ev(tool: string, input: Record<string, unknown>): PolicyEvent {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
}

describe('readOnSourceRule', () => {
  it('allows + adds additional_context for a bare Read on a .ts file', () => {
    const d = readOnSourceRule.evaluate(ev('Read', { file_path: 'src/foo.ts' }), ctx);
    expect(d?.decision).toBe('allow');
    expect(d?.rule).toBe('read-on-source');
    expect(d?.additional_context).toMatch(/nexus_outline/);
    expect(d?.additional_context).toMatch(/nexus_source/);
    expect(d?.additional_context).toMatch(/stale_hint/);
  });

  it('returns null when offset is present', () => {
    const d = readOnSourceRule.evaluate(ev('Read', { file_path: 'src/foo.ts', offset: 0 }), ctx);
    expect(d).toBeNull();
  });

  it('returns null when limit is present', () => {
    const d = readOnSourceRule.evaluate(ev('Read', { file_path: 'src/foo.ts', limit: 100 }), ctx);
    expect(d).toBeNull();
  });

  it('returns null when both offset and limit are present', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'src/foo.ts', offset: 10, limit: 100 }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for node_modules paths', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'node_modules/react/index.ts' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for docs/ paths', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'docs/example.ts' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for .nexus/ paths', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: '.nexus/index.db' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for README.md (ignored kind)', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'README.md' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for package.json (structured kind)', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'package.json' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for non-Read tools', () => {
    const d = readOnSourceRule.evaluate(
      ev('Edit', { file_path: 'src/foo.ts' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null when file_path is missing', () => {
    const d = readOnSourceRule.evaluate(ev('Read', {}), ctx);
    expect(d).toBeNull();
  });

  it('returns null when file_path is not a string', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 123 }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('matches .py, .go, .rs, .java, .cs sources', () => {
    for (const ext of ['py', 'go', 'rs', 'java', 'cs']) {
      const d = readOnSourceRule.evaluate(
        ev('Read', { file_path: `src/x.${ext}` }),
        ctx,
      );
      expect(d?.decision).toBe('allow');
    }
  });

  it('normalizes backslash paths (Windows)', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'src\\foo.ts' }),
      ctx,
    );
    expect(d?.decision).toBe('allow');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/policy-rules-read-source.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the rule**

Create `src/policy/rules/read-on-source.ts`:

```typescript
import * as path from 'node:path';
import type { PolicyRule } from '../types.js';
import { classifyPath } from '../../workspace/classify.js';
import { NON_CODE_PATH } from './common-paths.js';

const EMPTY_CONFIG = { languages: {} };

const CONTEXT =
  'This file is indexed by Nexus. Prefer nexus_outline(file) to see ' +
  'structure + signatures, or nexus_source(symbol, file) for a specific ' +
  "symbol. Fall back to Read if those don't answer the question. " +
  'The policy response includes stale_hint — if true, the index may lag ' +
  'recent edits to this file.';

/**
 * Bare Read on an indexed source file → allow, but inject a nudge via
 * `additional_context` pointing at nexus_outline / nexus_source. Never asks
 * or denies — this rule is advisory only.
 *
 * Skips:
 *   - non-Read events
 *   - paginated reads (offset or limit present, including falsy values)
 *   - excluded paths (node_modules, .git, .nexus, docs/, .env, .claude/)
 *   - non-source kinds (structured configs, lockfiles, README.md, etc.)
 *
 * No DB access — classification is purely path-based. "Is this indexed?" is
 * not checked; stale_hint (computed by the dispatcher) advertises the lag.
 */
export const readOnSourceRule: PolicyRule = {
  name: 'read-on-source',
  evaluate(event) {
    if (event.tool_name !== 'Read') return null;

    const input = event.tool_input;
    if (input.offset !== undefined) return null;
    if (input.limit !== undefined) return null;

    const raw = input.file_path;
    if (typeof raw !== 'string' || raw.length === 0) return null;

    const normalized = raw.replace(/\\/g, '/');
    if (NON_CODE_PATH.test(normalized)) return null;

    const basename = path.posix.basename(normalized);
    if (basename.length === 0) return null;

    let kind;
    try {
      kind = classifyPath(normalized, basename, EMPTY_CONFIG);
    } catch {
      return null;
    }
    if (kind.kind !== 'source') return null;

    return { decision: 'allow', rule: 'read-on-source', additional_context: CONTEXT };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/policy-rules-read-source.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/policy/rules/read-on-source.ts tests/policy-rules-read-source.test.ts
git commit -m "feat(policy): read-on-source rule (allow + additional_context nudge)"
```

---

## Task 6: Register both rules in `DEFAULT_RULES`

**Files:**
- Modify: `src/policy/index.ts`
- Test: `tests/policy-dispatcher.test.ts`

- [ ] **Step 1: Add three-rule integration tests**

First, add a top-level import at the top of `tests/policy-dispatcher.test.ts` (alongside the existing imports):

```typescript
import { DEFAULT_RULES } from '../src/policy/index.js';
```

Then append this block after the existing `describe('dispatchPolicy', …)` block (as a sibling `describe`):

```typescript
describe('dispatchPolicy with DEFAULT_RULES', () => {
  it('Grep event still routes to grep-on-code', () => {
    const resp = dispatchPolicy(ev('Grep', { pattern: 'foo' }), {
      rootDir: tmpDir,
      rules: DEFAULT_RULES,
    });
    expect(resp.decision).toBe('deny');
    expect(resp.rule).toBe('grep-on-code');
  });

  it('Read on package.json routes to read-on-structured with ask', () => {
    const resp = dispatchPolicy(
      ev('Read', { file_path: 'package.json' }),
      { rootDir: tmpDir, rules: DEFAULT_RULES },
    );
    expect(resp.decision).toBe('ask');
    expect(resp.rule).toBe('read-on-structured');
    expect(resp.reason).toMatch(/nexus_structured_query|nexus_structured_outline/);
  });

  it('bare Read on src/foo.ts routes to read-on-source with allow+context', () => {
    const resp = dispatchPolicy(
      ev('Read', { file_path: 'src/foo.ts' }),
      { rootDir: tmpDir, rules: DEFAULT_RULES },
    );
    expect(resp.decision).toBe('allow');
    expect(resp.rule).toBe('read-on-source');
    expect(resp.additional_context).toMatch(/nexus_outline/);
  });

  it('paged Read on src/foo.ts falls through to default allow (no rule)', () => {
    const resp = dispatchPolicy(
      ev('Read', { file_path: 'src/foo.ts', offset: 0 }),
      { rootDir: tmpDir, rules: DEFAULT_RULES },
    );
    expect(resp.decision).toBe('allow');
    expect(resp.rule).toBeUndefined();
    expect(resp.additional_context).toBeUndefined();
  });
});
```

Important: because `DEFAULT_RULES` is imported at the top of the test file, this test block must be added AFTER Task 5's `read-on-source` file exists (as planned — Task 6 follows Tasks 4 and 5). If you're running tasks out of order, you'll hit a module-resolution error until both rule files exist.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/policy-dispatcher.test.ts`
Expected: FAIL on the 3 new `read-on-*` cases — rules not yet in `DEFAULT_RULES`.

- [ ] **Step 3: Register the rules**

Edit `src/policy/index.ts`. Replace the full file with:

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
export { readOnStructuredRule } from './rules/read-on-structured.js';
export { readOnSourceRule } from './rules/read-on-source.js';

import { grepOnCodeRule } from './rules/grep-on-code.js';
import { readOnStructuredRule } from './rules/read-on-structured.js';
import { readOnSourceRule } from './rules/read-on-source.js';
import type { PolicyRule } from './types.js';

/**
 * Default rule set shipped with Nexus. Extend in follow-up plans.
 *
 * Individual rules are accessible via deep imports, but consumers of the
 * public API should treat the concrete rule list as an implementation detail
 * and compose via `DEFAULT_RULES` (or build their own `PolicyRule[]`).
 *
 * Order: Grep checks run first (deny path, short-circuit on match), then the
 * two Read rules. The Read rules are mutually exclusive by FileKind, so the
 * order between them doesn't matter.
 */
export const DEFAULT_RULES: readonly PolicyRule[] = [
  grepOnCodeRule,
  readOnStructuredRule,
  readOnSourceRule,
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/policy-dispatcher.test.ts`
Expected: PASS (all existing + 4 new `with DEFAULT_RULES` cases).

- [ ] **Step 5: Commit**

```bash
git add src/policy/index.ts tests/policy-dispatcher.test.ts
git commit -m "feat(policy): register read-on-structured + read-on-source in DEFAULT_RULES"
```

---

## Task 7: Extend `policy-entry` end-to-end tests

**Files:**
- Modify: `tests/policy-entry.test.ts`

- [ ] **Step 1: Add Read event cases**

Append inside the existing `describe('policy-entry', …)` block in `tests/policy-entry.test.ts`:

```typescript
  it('asks for Read on package.json with structured-tool suggestion', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'package.json' },
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('ask');
    expect(parsed.rule).toBe('read-on-structured');
    expect(parsed.reason).toMatch(/nexus_structured_query|nexus_structured_outline/);
  });

  it('asks for Read on yarn.lock with lockfile suggestion', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'yarn.lock' },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('ask');
    expect(parsed.reason).toMatch(/nexus_lockfile_deps/);
  });

  it('allows bare Read on a source file with additional_context', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/index.ts' },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
    expect(parsed.rule).toBe('read-on-source');
    expect(parsed.additional_context).toMatch(/nexus_outline/);
  });

  it('allows paged Read without additional_context', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/index.ts', offset: 0, limit: 100 },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
    expect(parsed.additional_context).toBeUndefined();
  });
```

Note: the existing `defaults to allow on unmatched tools` test reads `README.md`. That file classifies as `ignored` (not `source`, not structured), so it still returns plain `allow` after these changes. Leave it unchanged.

- [ ] **Step 2: Build and run tests**

Run: `npm run build && npx vitest run tests/policy-entry.test.ts`
Expected: PASS (all existing + 4 new cases).

- [ ] **Step 3: Commit**

```bash
git add tests/policy-entry.test.ts
git commit -m "test(policy-entry): cover Read events (structured + source + paged)"
```

---

## Task 8: Extend `nexus_policy_check` MCP tests

**Files:**
- Modify: `tests/mcp.test.ts`

- [ ] **Step 1: Add Read event cases to the `nexus_policy_check` describe block**

Append inside the existing `describe('nexus_policy_check tool', …)` block in `tests/mcp.test.ts` (after the last existing `it(...)` and before the block's closing `});`):

```typescript
  it('asks for Read on a structured file', async () => {
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'package.json' },
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].decision).toBe('ask');
    expect(payload.results[0].rule).toBe('read-on-structured');
  });

  it('allows bare Read on a source file with additional_context', async () => {
    const result = await callTool('nexus_policy_check', {
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'src/index.ts' },
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].decision).toBe('allow');
    expect(payload.results[0].rule).toBe('read-on-source');
    expect(payload.results[0].additional_context).toMatch(/nexus_outline/);
  });
```

The existing `returns allow for a non-Grep event` test reads `README.md`, which is still a plain-allow case after these changes. Leave it unchanged.

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 3: Commit**

```bash
git add tests/mcp.test.ts
git commit -m "test(mcp): cover Read redirect cases for nexus_policy_check"
```

---

## Task 9: Wire up the `Read` branch in `hooks/nexus-first.sh`

**Files:**
- Modify: `hooks/nexus-first.sh`

No automated test — bash is out of Vitest scope. Manual smoke check below.

- [ ] **Step 1: Add the Read branch and update the header**

Edit `hooks/nexus-first.sh`. Update the top-of-file comment block so the description reflects Read redirection, and update the install-example matcher from `"Grep|Glob|Agent"` to `"Grep|Glob|Agent|Read"`:

Replace this header block (lines 2-30, originally ending just before the `if [ "$NEXUS_FIRST_DISABLED" = "1" ]` line):

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

Then add the `Read` branch immediately before the final `exit 0` at the bottom of the file (after the Agent branch and its closing `fi`):

```bash
# ── Read: delegate to nexus-policy-check ─────────────────────────────
if [ "$TOOL_NAME" = "Read" ]; then
  # Find the policy binary. Prefer a binary on PATH (global install or npx cache),
  # fall back to npx (local node_modules/.bin when run inside the Nexus repo).
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
  REASON=$(echo "$DECISION" | jq -r '.reason // ""')
  CONTEXT=$(echo "$DECISION" | jq -r '.additional_context // ""')

  if [ "$PERMISSION" = "ask" ]; then
    jq -n --arg reason "$REASON" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: $reason
      }
    }'
    exit 0
  fi

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

- [ ] **Step 2: Build and run the manual smoke checks**

Run: `npm run build`
Expected: clean compile.

Pipe a structured-file Read event:
```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"package.json"}}' | bash hooks/nexus-first.sh
```
Expected stdout: JSON with `"permissionDecision": "ask"` and a `permissionDecisionReason` mentioning `nexus_structured_query` or `nexus_structured_outline`.

Pipe a lockfile Read event:
```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"yarn.lock"}}' | bash hooks/nexus-first.sh
```
Expected: `"permissionDecision": "ask"` with reason mentioning `nexus_lockfile_deps`.

Pipe a bare source Read event:
```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"src/index.ts"}}' | bash hooks/nexus-first.sh
```
Expected: `"permissionDecision": "allow"` with non-empty `additionalContext` mentioning `nexus_outline`.

Pipe a paged source Read event:
```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"src/index.ts","offset":0,"limit":100}}' | bash hooks/nexus-first.sh
```
Expected: empty stdout (silent allow; default fallthrough at the end of the Read branch).

Pipe a README Read event:
```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"README.md"}}' | bash hooks/nexus-first.sh
```
Expected: empty stdout (no rule matches; silent allow).

Pipe the existing Grep event to confirm the Grep branch is unaffected:
```bash
echo '{"tool_name":"Grep","tool_input":{"pattern":"foo"}}' | bash hooks/nexus-first.sh
```
Expected: `"permissionDecision": "deny"` with the NEXUS ONLY reason.

- [ ] **Step 3: Commit**

```bash
git add hooks/nexus-first.sh
git commit -m "feat(hooks): Read branch — delegate to nexus-policy-check for ask/additionalContext"
```

---

## Task 10: Docs — CHANGELOG, CLAUDE.md, roadmap

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`
- Modify: `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md`

- [ ] **Step 1: Add `[Unreleased] — A5/C2 read-redirect` section to `CHANGELOG.md`**

Prepend immediately below the current topmost entry:

```markdown
## [Unreleased] — A5/C2 read-redirect (warning-first)

### Added
- **`read-on-structured` policy rule** — `Read` on a structured config file (`package.json`, `tsconfig.json`, `Cargo.toml`, GHA workflow YAML, generic JSON/YAML/TOML) returns `permissionDecision: ask` with a suggestion to use `nexus_structured_query` or `nexus_structured_outline`. Lockfiles (`yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`) suggest `nexus_lockfile_deps`.
- **`read-on-source` policy rule** — `Read` on an indexed source file with neither `offset` nor `limit` returns `permissionDecision: allow` with `additionalContext` nudging toward `nexus_outline` / `nexus_source`. Paging (`offset` or `limit` present) skips the rule.
- **`additional_context?: string` field** on `PolicyDecision` and `PolicyResponse`. Dispatcher forwards it on `allow`/`ask` and drops it on `deny`/`noop`.
- `hooks/nexus-first.sh` now handles `Read` events — install instructions updated to `"matcher": "Grep|Glob|Agent|Read"`.

### Notes
- Never hard-denies `Read`. Worst case is silent allow.
- No DB access on the hot path — rules rely on `classifyPath()` plus existing `stale_hint`.
- `.nexus.json` language overrides are intentionally not loaded on the hot path (resolving config would cost disk I/O per event). Custom extensions won't trigger the source rule until V4 adds a long-lived policy worker.
```

- [ ] **Step 2: Update `CLAUDE.md` under the policy transport section**

Extend the existing policy transport line so it reads:

```markdown
**Policy transport:** `nexus_policy_check` — evaluate a Claude Code hook event against the Nexus policy layer. Dedicated `nexus-policy-check` bin for the PreToolUse hot path (no CLI spin-up, no reindex). Every response carries `stale_hint`. See `src/policy/` for rules.

Shipped rules:
- `grep-on-code` — denies `Grep` on code paths; allows `Grep` on docs/lockfiles/node_modules.
- `read-on-structured` — asks before `Read` on structured configs and lockfiles; suggests `nexus_structured_query`/`nexus_structured_outline` or `nexus_lockfile_deps`.
- `read-on-source` — allows bare `Read` on indexed source files but adds `additionalContext` nudging `nexus_outline`/`nexus_source`.
```

- [ ] **Step 3: Update the V3 roadmap**

In `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md`, change the A5/C2 section header from:

```markdown
#### A5/C2 — read-redirect hook (warning-first)
```

to:

```markdown
#### A5/C2 — read-redirect hook (warning-first) — ✅ shipped (2026-04-24)
```

Leave the body text unchanged — the design didn't deviate from it.

- [ ] **Step 4: Run the full test suite + build one more time**

Run: `npm run build && npm run test`
Expected: clean build; full suite green (pre-existing `.claude/worktrees/*` stale-copy failures, if any, are not introduced by this work).

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md CLAUDE.md "C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md"
git commit -m "docs: A5/C2 read-redirect shipped — rules, hook branch, roadmap"
```

---

## Verification — end of plan

- [ ] `npm run build` — clean.
- [ ] `npm run test` — full suite green.
- [ ] `echo '{"tool_name":"Read","tool_input":{"file_path":"package.json"}}' | node dist/transports/policy-entry.js` → `{"decision":"ask","rule":"read-on-structured","reason":"Use nexus_structured_query …","stale_hint":…}`
- [ ] `echo '{"tool_name":"Read","tool_input":{"file_path":"yarn.lock"}}' | node dist/transports/policy-entry.js` → `{"decision":"ask","reason":"Use nexus_lockfile_deps …",…}`
- [ ] `echo '{"tool_name":"Read","tool_input":{"file_path":"src/index.ts"}}' | node dist/transports/policy-entry.js` → `{"decision":"allow","rule":"read-on-source","additional_context":"This file is indexed …",…}`
- [ ] `echo '{"tool_name":"Read","tool_input":{"file_path":"src/index.ts","offset":0}}' | node dist/transports/policy-entry.js` → `{"decision":"allow","stale_hint":…}` (no rule, no context).
- [ ] `bash hooks/nexus-first.sh` smoke checks from Task 9 step 2 all produce the documented output.
- [ ] Existing Grep deny path still fires (regression check).
- [ ] MCP: `nexus_policy_check` returns `ask` / `allow+additional_context` for the matching Read cases.

## Self-Review Checklist

- **Spec coverage:** Every section of the design is covered. Q1 (hybrid decision) → Tasks 4+5 with different decision shapes. Q2 (two rules) → separate files, separate rule names. Q3 (offset/limit heuristic) → Task 5 Step 1 tests + Step 3 implementation use `!== undefined`. Error-handling invariants → Tasks 4 and 5 include null-return paths for every failure mode listed in the spec.
- **Placeholders:** None.
- **Type consistency:** `readOnStructuredRule` / `readOnSourceRule` names match between implementation, tests, and `DEFAULT_RULES` registration. `additional_context` spelled the same in types, dispatcher, rules, tests, hook. `PolicyDecision`/`PolicyResponse` shape identical across Tasks 2, 3, 4, 5.
- **Compat:** Existing tests that read `README.md` still pass (classifies as `ignored`, no rule fires). Existing Grep tests unaffected by the regex extraction (Task 1 is pure refactor). `src/index.ts` public API unchanged — individual rules were never on the public surface.
- **Scope discipline:** No DB access on the hot path. No new MCP tool. No new bin. No schema bump. No line-count heuristics. No config loading. No telemetry (D5 is V4).
