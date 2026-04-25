# D3 v1 — Self-Review Evidence Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface an informational evidence summary (`tests_run_this_session`, `affected_callers`, `new_unused_exports`, `caller_risk`, `evidence_ok`) when Claude is about to run `git commit`, `git push`, or `gh pr create`. Never blocks. Reuses C1's importer/caller plumbing plus a new PostToolUse rule that records successful test runs.

**Architecture:** Two new `PolicyRule`s (`evidence-summary` for PreToolUse Bash, `test-tracker` for PostToolUse Bash) plus pure helpers in `src/policy/evidence.ts` and a JSON store in `src/policy/session-state.ts`. `PolicyEvent` grows an optional `tool_response` field. `QueryEngineLike` widens to add `unusedExports`. The bash hook gains a Bash branch in `nexus-first.sh` (PreToolUse) and a new `nexus-post.sh` script (PostToolUse).

**Tech Stack:** TypeScript (strict ESM), Node `fs`/`path`/`child_process` (`execFileSync` for git), Vitest, `better-sqlite3` (existing), bash + `jq` (existing hook).

**Spec reference:** [docs/superpowers/specs/2026-04-25-d3-evidence-summary-design.md](../specs/2026-04-25-d3-evidence-summary-design.md). V3 roadmap Tier 1 · D3.

**Spec deviations:** None planned. Document any that arise per task.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/policy/types.ts` | Modify | Add optional `tool_response` to `PolicyEvent`; widen `QueryEngineLike` with `unusedExports` + richer `callers` callsite shape. |
| `src/policy/session-state.ts` | Create | `.nexus/session-state.json` read/write with atomic rename + 256-entry FIFO cap. |
| `src/policy/evidence.ts` | Create | Pure helpers: `parseGitTrigger`, `parseTestCommand`, `TEST_COMMAND_PATTERNS`, types (`AffectedCaller`, `NewUnusedExport`, `EvidenceSummary`), `formatEvidenceSummary`. |
| `src/policy/rules/evidence-summary.ts` | Create | PreToolUse rule. Detects git/gh trigger; computes change set via git; aggregates callers + unused exports; emits `allow + additional_context`. |
| `src/policy/rules/test-tracker.ts` | Create | PostToolUse rule. Records successful test runs to session state. Returns `noop`. |
| `src/policy/index.ts` | Modify | Export + register the two new rules in `DEFAULT_RULES`. |
| `src/transports/policy-entry.ts` | Modify | Forward `tool_response` from raw event JSON into the parsed `PolicyEvent`. |
| `src/transports/mcp.ts` | Modify | `nexus_policy_check` schema accepts optional `tool_response` and `session_id` on the event. |
| `hooks/nexus-first.sh` | Modify | Add Bash branch (mirrors Edit/Write `allow + additionalContext`). Update install matcher to `Grep|Glob|Agent|Read|Edit|Write|Bash`. |
| `hooks/nexus-post.sh` | Create | Tiny PostToolUse dispatcher that pipes the event to `nexus-policy-check` and discards the response. |
| `tests/policy-evidence.test.ts` | Create | DB-free unit tests for `evidence.ts` (parsers, formatter). |
| `tests/policy-session-state.test.ts` | Create | Unit tests for the JSON store (atomic write, FIFO cap, session isolation, corrupt-file recovery). |
| `tests/policy-rules-evidence-summary.test.ts` | Create | Rule tests with stub `QueryEngineLike` + a temp git repo (or injected exec wrapper). |
| `tests/policy-rules-test-tracker.test.ts` | Create | Rule tests for the PostToolUse path. |
| `tests/policy-types.test.ts` | Modify | Compile-check `tool_response` and the wider `QueryEngineLike`. |
| `tests/policy-dispatcher.test.ts` | Modify | Bash event routing for both PreToolUse and PostToolUse. |
| `tests/policy-entry.test.ts` | Modify | Bin E2E for both Bash hook events. |
| `tests/mcp.test.ts` | Modify | `nexus_policy_check` Bash cases (PreToolUse git-commit + PostToolUse npm-test). |
| `CHANGELOG.md` | Modify | New `[Unreleased]` entry. |
| `CLAUDE.md` | Modify | Extend policy-transport section; document `nexus-post.sh` install instructions. |
| `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md` | Modify | Mark D3 v1 shipped; close V3 Tier 1. |

---

## Task 1: Preflight — confirm baseline green

**Files:** None modified. Verification only.

- [ ] **Step 1: Confirm branch + worktree**

Run: `git branch --show-current`
Expected: starts with `claude/` or `feat/d3-` (whatever worktree was opened).

Run: `git status`
Expected: clean working tree (untracked plan/spec docs OK).

- [ ] **Step 2: Confirm build is green**

Run: `npm run build`
Expected: `tsc` exits 0.

- [ ] **Step 3: Confirm tests are green**

Run: `npm test`
Expected: all tests pass. Note the baseline count — later tasks should only add tests, never remove any.

- [ ] **Step 4: Nothing to commit**

No code changes in this task. Do not commit.

---

## Task 2: Types — `tool_response` and wider `QueryEngineLike`

**Files:**
- Modify: `src/policy/types.ts`
- Modify: `tests/policy-types.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/policy-types.test.ts`:

```typescript
  it('PolicyEvent accepts an optional tool_response', () => {
    const event: PolicyEvent = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0, stdout: '', stderr: '' },
      session_id: 's1',
    };
    expect(event.tool_response?.exit_code).toBe(0);
  });

  it('QueryEngineLike exposes unusedExports', () => {
    const engine: QueryEngineLike = {
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [] }),
      callers: () => ({ results: [{ callers: [] }] }),
      unusedExports: () => ({ results: [] }),
    };
    expect(engine.unusedExports().results).toEqual([]);
  });

  it('QueryEngineLike.callers exposes the richer call_sites shape', () => {
    const engine: QueryEngineLike = {
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [] }),
      callers: () => ({
        results: [{
          callers: [{
            caller: { file: 'src/x.ts', line: 10 },
            call_sites: [{ line: 12, col: 4 }],
          }],
        }],
      }),
      unusedExports: () => ({ results: [] }),
    };
    expect(engine.callers('foo').results[0].callers[0].call_sites?.[0].line).toBe(12);
  });
```

Run `npm test -- policy-types`. Expected: failures referencing missing `tool_response` and `unusedExports`.

- [ ] **Step 2: Update types**

Edit `src/policy/types.ts`:

1. Extend `PolicyEvent`:

```typescript
export interface PolicyEvent {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  /**
   * Present on PostToolUse only. Shape varies by tool. For `Bash`,
   * Claude Code populates `{ stdout, stderr, exit_code, ... }`.
   * Untyped because no PreToolUse rule consumes it.
   */
  tool_response?: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
}
```

2. Widen `QueryEngineLike`:

```typescript
export interface QueryEngineLike {
  importers(source: string): {
    results: { file: string }[];
    count: number;
  };
  outline(filePath: string): {
    results: OutlineForImpact[];
  };
  callers(
    name: string,
    opts?: { file?: string; limit?: number },
  ): {
    results: {
      callers: {
        caller?: { file?: string; line?: number };
        call_sites?: { line: number; col?: number }[];
      }[];
    }[];
  };
  unusedExports(opts?: {
    path?: string;
    limit?: number;
    mode?: 'default' | 'runtime_only';
  }): {
    results: { name: string; file: string; kind: string; line: number }[];
  };
}
```

- [ ] **Step 3: Verify**

Run `npm test -- policy-types` — passes.
Run `npm run build` — passes. The real `QueryEngine` satisfies the wider interface structurally (its `unusedExports` already returns `UnusedExportResult` rows; its `CallersResult.callers` already carries `caller` and `call_sites`). No real-engine changes required.

Verify the structural compatibility check at the C1 wiring site stays green:

```typescript
return new QueryEngine(db) as unknown as QueryEngineLike;
```

If the cast still passes through `as unknown` as today, no further change is needed at the call sites.

- [ ] **Step 4: Commit**

```
feat(policy): tool_response on PolicyEvent + widen QueryEngineLike for D3
```

---

## Task 3: Pure helpers — `evidence.ts` parsers + formatter

**Files:**
- Create: `src/policy/evidence.ts`
- Create: `tests/policy-evidence.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/policy-evidence.test.ts` with tests for:

- `parseGitTrigger`:
  - `"git commit -m 'x'"` → `{kind:'commit'}`
  - `"git commit"` → `{kind:'commit'}`
  - `"git commit --amend"` → `{kind:'commit'}`
  - `"  git commit  "` → `{kind:'commit'}` (whitespace tolerant)
  - `"git push"` → `{kind:'push'}`
  - `"git push --force"` → `{kind:'push'}`
  - `"gh pr create --title x"` → `{kind:'pr_create'}`
  - `"git add . && git commit -m 'x'"` → `{kind:'commit'}`
  - `"git status"` → `null`
  - `"echo git commit"` → `null`
  - `"GIT_AUTHOR_NAME=foo git commit"` → `{kind:'commit'}`
  - `""` and `"   "` → `null`
  - First trigger wins: `"git push && gh pr create"` → `{kind:'push'}`.
- `parseTestCommand`:
  - `"npm test"` / `"npm run test"` / `"npm run test:unit"` → matched (canonicalized).
  - `"yarn test"` / `"pnpm test"` / `"pnpm run test"` → matched.
  - `"vitest"` / `"jest"` / `"pytest"` / `"go test"` / `"cargo test"` / `"nexus test"` → matched.
  - `"CI=1 npm test"` → matched (env-var stripping).
  - `"npm test && git push"` → matched on first segment.
  - `"npm install"` / `"echo npm test"` → null.
  - Custom-pattern overload returns null when none of the supplied patterns match, and matches when one does.
- `formatEvidenceSummary`:
  - Empty everything (no changes, no symbols) → short summary mentioning the trigger and `evidence_ok`.
  - All-green case (`tests_run_this_session:true`, `caller_risk:'low'`, no unused) → contains `✅` and `tests_run`.
  - Warning case (`tests_run_this_session:false`) → contains `⚠️` and `tests_run` flagged.
  - High-risk case (`caller_risk:'high'`) → mentions `high`.
  - 30-symbol payload → output ≤ `SUMMARY_MAX_CHARS`; suffix `…+N more callers`.
  - 30-unused payload → output ≤ cap; suffix `…+N more unused`.
  - Sample sites included for the top affected caller (e.g. `src/x.ts:12`).

Run `npm test -- policy-evidence`. Expected: file-not-found / no-export errors.

- [ ] **Step 2: Implement `evidence.ts`**

Create `src/policy/evidence.ts`. Sketch:

```typescript
export type GitTrigger =
  | { kind: 'commit' }
  | { kind: 'push' }
  | { kind: 'pr_create' };

const GIT_TRIGGER_PATTERNS: { kind: GitTrigger['kind']; re: RegExp }[] = [
  { kind: 'commit',    re: /^git\s+commit(\s|$)/ },
  { kind: 'push',      re: /^git\s+push(\s|$)/ },
  { kind: 'pr_create', re: /^gh\s+pr\s+create(\s|$)/ },
];

export const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /^npm\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/,
  /^pnpm\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/,
  /^yarn\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/,
  /^vitest(?:\s|$)/,
  /^jest(?:\s|$)/,
  /^pytest(?:\s|$)/,
  /^go\s+test(?:\s|$)/,
  /^cargo\s+test(?:\s|$)/,
  /^nexus\s+test(?:\s|$)/,
];

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;)\s*/;
// Strip leading `KEY=value` env-var assignments (shell-style; no spaces in value).
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

function normalizeSegment(seg: string): string {
  return seg.trim().replace(ENV_PREFIX, '');
}

export function parseGitTrigger(command: string): GitTrigger | null {
  if (typeof command !== 'string' || command.trim().length === 0) return null;
  for (const raw of command.split(SEGMENT_SPLIT)) {
    const seg = normalizeSegment(raw);
    for (const { kind, re } of GIT_TRIGGER_PATTERNS) {
      if (re.test(seg)) return { kind };
    }
  }
  return null;
}

export function parseTestCommand(
  command: string,
  patterns: readonly RegExp[] = TEST_COMMAND_PATTERNS,
): string | null {
  if (typeof command !== 'string' || command.trim().length === 0) return null;
  for (const raw of command.split(SEGMENT_SPLIT)) {
    const seg = normalizeSegment(raw);
    for (const re of patterns) {
      if (re.test(seg)) return seg;
    }
  }
  return null;
}

export interface AffectedCaller {
  symbol: string;
  file: string;
  caller_count: number;
  sample_sites: { file: string; line: number }[];
}

export interface NewUnusedExport {
  symbol: string;
  file: string;
  kind: string;
}

export interface EvidenceSummary {
  trigger: GitTrigger['kind'];
  tests_run_this_session: boolean;
  affected_callers: AffectedCaller[];
  new_unused_exports: NewUnusedExport[];
  caller_risk: 'low' | 'medium' | 'high';
  evidence_ok: boolean;
  stale_hint: boolean;
}

export const SUMMARY_MAX_CHARS = 1200;
export const MAX_AFFECTED_CALLERS = 10;
export const MAX_UNUSED_EXPORTS = 10;
export const MAX_SAMPLE_SITES = 3;

export function formatEvidenceSummary(s: EvidenceSummary): string {
  // Build sections; truncate per cap; join with newlines.
  // Use ✅ when evidence_ok else ⚠️.
  // Lead: "<icon> Pre-<trigger> evidence (Nexus advisory):"
  // Lines: tests_run, caller_risk, affected list, unused list.
  // ...
}
```

(Implement details to satisfy the failing tests. Keep the function under ~80 lines. No DB calls, no fs.)

- [ ] **Step 3: Verify**

Run `npm test -- policy-evidence` — passes.
Run `npm run build` — passes.

- [ ] **Step 4: Commit**

```
feat(policy): add evidence.ts pure helpers (parseGitTrigger, parseTestCommand, formatEvidenceSummary) (D3)
```

---

## Task 4: Session state — `.nexus/session-state.json` store

**Files:**
- Create: `src/policy/session-state.ts`
- Create: `tests/policy-session-state.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/policy-session-state.test.ts`:

- `appendTestRun` creates `.nexus/session-state.json` (creating `.nexus/` if missing) with one entry.
- Subsequent `appendTestRun` with same `session_id` appends in order.
- `appendTestRun` with new `session_id` rewrites the file fresh (only the new entry survives).
- `hasTestRunThisSession` returns `false` for a session_id that doesn't match the file.
- `readSessionState` returns `null` when the file does not exist.
- `readSessionState` returns `null` when the file is corrupt JSON (file is left untouched, not deleted).
- FIFO cap: 257 sequential `appendTestRun` calls leave 256 entries (oldest dropped).
- 10 parallel `appendTestRun` calls in a temp dir → file ends up valid JSON with at most 10 entries (atomic write — last writer wins is acceptable, but file is always parseable).

Run `npm test -- policy-session-state`. Expected: import errors.

- [ ] **Step 2: Implement `session-state.ts`**

Create `src/policy/session-state.ts`. Outline:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TestRunRecord {
  cmd: string;
  ts_ms: number;
  exit: number;
}

export interface SessionState {
  session_id: string;
  started_at: number;
  tests_run: TestRunRecord[];
}

const FILE_NAME = 'session-state.json';
const MAX_ENTRIES = 256;

function statePath(rootDir: string): string {
  return path.join(rootDir, '.nexus', FILE_NAME);
}

export function readSessionState(rootDir: string, sessionId: string): SessionState | null {
  try {
    const raw = fs.readFileSync(statePath(rootDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (!parsed || typeof parsed.session_id !== 'string') return null;
    if (parsed.session_id !== sessionId) return null;
    return {
      session_id: parsed.session_id,
      started_at: typeof parsed.started_at === 'number' ? parsed.started_at : Date.now(),
      tests_run: Array.isArray(parsed.tests_run) ? parsed.tests_run.filter(isTestRunRecord) : [],
    };
  } catch {
    return null;
  }
}

export function hasTestRunThisSession(rootDir: string, sessionId: string): boolean {
  const s = readSessionState(rootDir, sessionId);
  return !!s && s.tests_run.length > 0;
}

export function appendTestRun(
  rootDir: string,
  sessionId: string,
  record: TestRunRecord,
): void {
  const dir = path.join(rootDir, '.nexus');
  fs.mkdirSync(dir, { recursive: true });

  let state: SessionState | null = null;
  try {
    const raw = fs.readFileSync(statePath(rootDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (parsed && parsed.session_id === sessionId && Array.isArray(parsed.tests_run)) {
      state = {
        session_id: sessionId,
        started_at: typeof parsed.started_at === 'number' ? parsed.started_at : Date.now(),
        tests_run: parsed.tests_run.filter(isTestRunRecord),
      };
    }
  } catch {
    /* fall through to fresh state */
  }

  if (!state) {
    state = { session_id: sessionId, started_at: Date.now(), tests_run: [] };
  }

  state.tests_run.push(record);
  if (state.tests_run.length > MAX_ENTRIES) {
    state.tests_run = state.tests_run.slice(state.tests_run.length - MAX_ENTRIES);
  }

  const real = statePath(rootDir);
  const tmp = `${real}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, real);
}

function isTestRunRecord(v: unknown): v is TestRunRecord {
  return !!v && typeof v === 'object'
    && typeof (v as TestRunRecord).cmd === 'string'
    && typeof (v as TestRunRecord).ts_ms === 'number'
    && typeof (v as TestRunRecord).exit === 'number';
}
```

- [ ] **Step 3: Verify**

Run `npm test -- policy-session-state` — passes.
Run `npm run build` — passes.

- [ ] **Step 4: Commit**

```
feat(policy): session-state.json store with atomic write + FIFO cap (D3)
```

---

## Task 5: Test-tracker rule (PostToolUse)

**Files:**
- Create: `src/policy/rules/test-tracker.ts`
- Create: `tests/policy-rules-test-tracker.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/policy-rules-test-tracker.test.ts`:

- PostToolUse Bash event with `command: 'npm test'`, `tool_response.exit_code: 0`, `session_id: 's1'`, real temp `rootDir` → returns `{decision:'noop', rule:'test-tracker'}`; the file `<rootDir>/.nexus/session-state.json` exists with one entry whose `cmd: 'npm test'`.
- Same event but `exit_code: 1` → returns `null` (or `{decision:'noop'}` with no side-effect — assert no file written).
- Same event but `command: 'npm install'` → returns `null`, no file written.
- PostToolUse with no `tool_response` → `null`.
- PostToolUse with no `session_id` → `null`.
- PreToolUse Bash event (wrong `hook_event_name`) → `null`.
- File-write failure (mock `fs.writeFileSync` to throw) → returns `noop` without throwing.

Use `os.tmpdir()` + a unique subdir per test to isolate.

- [ ] **Step 2: Implement the rule**

Create `src/policy/rules/test-tracker.ts`:

```typescript
import type { PolicyRule } from '../types.js';
import { parseTestCommand } from '../evidence.js';
import { appendTestRun } from '../session-state.js';

function readExitCode(resp: unknown): number | null {
  if (!resp || typeof resp !== 'object') return null;
  const v = (resp as Record<string, unknown>).exit_code;
  return typeof v === 'number' ? v : null;
}

export const testTrackerRule: PolicyRule = {
  name: 'test-tracker',
  evaluate(event, ctx) {
    if (event.hook_event_name !== 'PostToolUse') return null;
    if (event.tool_name !== 'Bash') return null;
    const command = event.tool_input.command;
    if (typeof command !== 'string') return null;
    const exitCode = readExitCode(event.tool_response);
    if (exitCode !== 0) return null;
    const matched = parseTestCommand(command);
    if (!matched) return null;
    const sessionId = event.session_id;
    if (!sessionId) return null;

    try {
      appendTestRun(ctx.rootDir, sessionId, { cmd: matched, ts_ms: Date.now(), exit: 0 });
    } catch {
      /* never throw from a hook */
    }
    return { decision: 'noop', rule: 'test-tracker' };
  },
};
```

- [ ] **Step 3: Verify**

Run `npm test -- policy-rules-test-tracker` — passes.
Run `npm run build` — passes.

- [ ] **Step 4: Commit**

```
feat(policy): add test-tracker rule (PostToolUse Bash) (D3)
```

---

## Task 6: Evidence-summary rule scaffolding (skip cases)

**Files:**
- Create: `src/policy/rules/evidence-summary.ts`
- Create: `tests/policy-rules-evidence-summary.test.ts`

This task implements the rule's no-op skeleton (skip cases only — the happy path lands in Task 7 once helpers are wired). Lets us land the registration glue without dragging in git/exec.

- [ ] **Step 1: Write failing tests for the skip paths**

`tests/policy-rules-evidence-summary.test.ts` (initial):

- PreToolUse Bash, command `git status` → `null`.
- PreToolUse Bash, command `git commit`, but `ctx.queryEngine` undefined → `null`.
- Non-Bash event → `null`.
- PostToolUse Bash event → `null`.
- `tool_input.command` not a string → `null`.

For "git commit + queryEngine undefined", supply a `ctx` with `rootDir: tmp` and no `queryEngine`.

- [ ] **Step 2: Implement the rule skeleton**

Create `src/policy/rules/evidence-summary.ts`:

```typescript
import type { PolicyRule } from '../types.js';
import { parseGitTrigger } from '../evidence.js';

export const evidenceSummaryRule: PolicyRule = {
  name: 'evidence-summary',
  evaluate(event, ctx) {
    if (event.hook_event_name !== 'PreToolUse') return null;
    if (event.tool_name !== 'Bash') return null;
    const command = event.tool_input.command;
    if (typeof command !== 'string') return null;
    const trigger = parseGitTrigger(command);
    if (!trigger) return null;
    if (!ctx.queryEngine) return null;

    // Happy path implemented in Task 7. For now, fall open.
    return null;
  },
};
```

- [ ] **Step 3: Verify**

Run `npm test -- policy-rules-evidence-summary` — passes.

- [ ] **Step 4: Commit**

```
feat(policy): evidence-summary rule scaffolding (skip cases only) (D3)
```

---

## Task 7: Evidence-summary rule — happy path

**Files:**
- Modify: `src/policy/rules/evidence-summary.ts`
- Modify: `tests/policy-rules-evidence-summary.test.ts`

- [ ] **Step 1: Decide on the git wrapper**

The rule needs `git status --porcelain=v1`, `git rev-parse @{u}`, `git symbolic-ref refs/remotes/origin/HEAD`, and `git diff --name-only $(merge-base)...HEAD`. Wrap them in an internal helper file `src/policy/rules/evidence-summary.ts` (no separate file — keep the rule self-contained). All shell calls go through `execFileSync` with `stdio: ['ignore', 'pipe', 'ignore']`, 3000 ms timeout, `env` scrubbed to a minimal allow-list (`PATH`, `HOME`, `USERPROFILE`).

For testability, expose an internal `_collectChangedFiles` helper accepting an optional `runGit` injection. Default `runGit` runs `execFileSync`. Tests substitute a fake.

- [ ] **Step 2: Add happy-path tests**

Append to `tests/policy-rules-evidence-summary.test.ts`. Inject a stub `QueryEngineLike`:

```typescript
const stubEngine: QueryEngineLike = {
  importers: () => ({ results: [], count: 0 }),
  outline: (file) => ({
    results: [{
      file,
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 5 }],
    }],
  }),
  callers: () => ({
    results: [{
      callers: Array.from({ length: 6 }, (_, i) => ({
        caller: { file: `src/c${i}.ts`, line: 10 + i },
        call_sites: [{ line: 12 + i, col: 4 }],
      })),
    }],
  }),
  unusedExports: () => ({ results: [] }),
};
```

Use a stub `runGit` that responds:
- `git status --porcelain=v1` → `" M src/foo.ts\n?? scratch.md\n"`.
- Anything else → empty string.

Cases:
- Commit + dirty `src/foo.ts` indexed → `decision:'allow'`, `additional_context` mentions `foo`, mentions `medium` risk (6 callers), mentions `tests_run_this_session: false`.
- Commit + clean tree (`runGit` returns empty) → `null`.
- Commit + dirty file not indexed (`outline` returns `{results:[]}`) → `null`.
- Push trigger + `runGit` resolves merge-base + diff returns one file → summary set, `trigger:'push'` text.
- `gh pr create` trigger → summary set, `trigger:'pr_create'` text.
- `unusedExports` returns 2 entries → summary lists them, `evidence_ok:false`.
- 30 affected exports (multiple files × 30 exports) → summary lists ≤ 10 with `…+N more callers` suffix.
- Test-run flag: when `appendTestRun` was previously called for the same `session_id` → summary mentions `tests_run_this_session: true`.
- `engine.unusedExports` throws for one file → unused list is `[]`, summary still emitted.
- `engine.callers` throws for one symbol → summary emits 0 caller_count for that one; others still aggregated.
- `runGit` throws → `null` (silent allow).

- [ ] **Step 3: Implement the happy path**

Flesh out `evidence-summary.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import type { PolicyRule, QueryEngineLike } from '../types.js';
import {
  parseGitTrigger,
  type GitTrigger,
  type AffectedCaller,
  type NewUnusedExport,
  type EvidenceSummary,
  formatEvidenceSummary,
  MAX_AFFECTED_CALLERS,
  MAX_UNUSED_EXPORTS,
  MAX_SAMPLE_SITES,
} from '../evidence.js';
import { bucketRisk } from '../impact.js';
import { hasTestRunThisSession } from '../session-state.js';

type RunGit = (args: string[], cwd: string) => string;

const defaultRunGit: RunGit = (args, cwd) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
    env: pickEnv(['PATH', 'HOME', 'USERPROFILE']),
  });

function pickEnv(keys: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export interface EvidenceSummaryDeps {
  runGit?: RunGit;
}

export function _collectChangedFiles(
  rootDir: string,
  trigger: GitTrigger,
  runGit: RunGit,
): string[] {
  try {
    if (trigger.kind === 'commit') {
      const out = runGit(['status', '--porcelain=v1'], rootDir);
      return parseStatusPorcelain(out);
    }
    // push or pr_create
    const upstream = resolveUpstream(rootDir, runGit);
    if (!upstream) return [];
    const base = runGit(['merge-base', upstream, 'HEAD'], rootDir).trim();
    if (!base) return [];
    const diff = runGit(['diff', '--name-only', `${base}..HEAD`], rootDir);
    return diff.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function parseStatusPorcelain(out: string): string[] {
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    if (xy === '??') continue; // untracked: index doesn't know it
    const rest = line.slice(3);
    // Renames: "R  old -> new"
    const arrow = rest.indexOf(' -> ');
    const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    files.add(path.replace(/\\/g, '/'));
  }
  return [...files];
}

function resolveUpstream(rootDir: string, runGit: RunGit): string | null {
  try {
    const u = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], rootDir).trim();
    if (u) return u;
  } catch { /* fall through */ }
  try {
    const head = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], rootDir).trim();
    if (head.startsWith('refs/remotes/')) return head.slice('refs/remotes/'.length);
  } catch { /* fall through */ }
  return 'origin/main';
}

function aggregateAffectedCallers(
  engine: QueryEngineLike,
  files: string[],
): AffectedCaller[] {
  const out: AffectedCaller[] = [];
  for (const file of files) {
    let envelope;
    try { envelope = engine.outline(file); } catch { continue; }
    const outline = envelope.results[0];
    if (!outline) continue;
    const exportedTopLevel = outline.outline.filter(e => outline.exports.includes(e.name));
    for (const entry of exportedTopLevel) {
      let callerCount = 0;
      let sampleSites: { file: string; line: number }[] = [];
      try {
        const env = engine.callers(entry.name, { file, limit: 50 });
        const callers = env.results[0]?.callers ?? [];
        callerCount = callers.length;
        sampleSites = callers
          .slice(0, MAX_SAMPLE_SITES)
          .map(c => {
            const site = c.call_sites?.[0];
            return {
              file: c.caller?.file ?? file,
              line: site?.line ?? c.caller?.line ?? 0,
            };
          });
      } catch { /* keep zeros */ }
      out.push({ symbol: entry.name, file, caller_count: callerCount, sample_sites: sampleSites });
    }
  }
  out.sort((a, b) => b.caller_count - a.caller_count);
  return out;
}

function aggregateNewUnusedExports(
  engine: QueryEngineLike,
  files: string[],
): NewUnusedExport[] {
  const out: NewUnusedExport[] = [];
  for (const file of files) {
    try {
      const env = engine.unusedExports({ path: file, limit: 20, mode: 'default' });
      for (const r of env.results) {
        out.push({ symbol: r.name, file: r.file, kind: r.kind });
      }
    } catch { /* skip file */ }
  }
  out.sort((a, b) => a.file === b.file ? a.symbol.localeCompare(b.symbol) : a.file.localeCompare(b.file));
  return out;
}

export function buildEvidenceRule(deps: EvidenceSummaryDeps = {}): PolicyRule {
  const runGit = deps.runGit ?? defaultRunGit;
  return {
    name: 'evidence-summary',
    evaluate(event, ctx) {
      if (event.hook_event_name !== 'PreToolUse') return null;
      if (event.tool_name !== 'Bash') return null;
      const command = event.tool_input.command;
      if (typeof command !== 'string') return null;
      const trigger = parseGitTrigger(command);
      if (!trigger) return null;
      if (!ctx.queryEngine) return null;

      const changed = _collectChangedFiles(ctx.rootDir, trigger, runGit);
      if (changed.length === 0) return null;

      const affected = aggregateAffectedCallers(ctx.queryEngine, changed);
      if (affected.length === 0) return null;

      const unused = aggregateNewUnusedExports(ctx.queryEngine, changed);
      const sessionId = event.session_id ?? '';
      const testsRun = sessionId
        ? hasTestRunThisSession(ctx.rootDir, sessionId)
        : false;

      const maxCallers = affected.reduce((m, a) => Math.max(m, a.caller_count), 0);
      const callerRisk = bucketRisk(maxCallers);
      const evidenceOk = testsRun && callerRisk !== 'high' && unused.length === 0;

      const summary: EvidenceSummary = {
        trigger: trigger.kind,
        tests_run_this_session: testsRun,
        affected_callers: affected.slice(0, MAX_AFFECTED_CALLERS),
        new_unused_exports: unused.slice(0, MAX_UNUSED_EXPORTS),
        caller_risk: callerRisk,
        evidence_ok: evidenceOk,
        stale_hint: false,
      };

      return {
        decision: 'allow',
        rule: 'evidence-summary',
        additional_context: formatEvidenceSummary(summary),
      };
    },
  };
}

export const evidenceSummaryRule: PolicyRule = buildEvidenceRule();
```

(Tests inject via `buildEvidenceRule({ runGit: stub })`.)

`if (affected.length === 0) return null;` is a deliberate skip: the change set has no exported top-level symbols to summarize, so there's nothing to say. Confirmed by the "dirty file not indexed" test case (outline returns empty → `affected` empty → null).

- [ ] **Step 4: Verify**

Run `npm test -- policy-rules-evidence-summary` — passes.
Run `npm run build` — passes.

- [ ] **Step 5: Commit**

```
feat(policy): evidence-summary rule happy path (PreToolUse Bash) (D3)
```

---

## Task 8: Register rules in `DEFAULT_RULES`

**Files:**
- Modify: `src/policy/index.ts`
- Modify: `tests/policy-dispatcher.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/policy-dispatcher.test.ts`:

- `DEFAULT_RULES` includes `evidence-summary` and `test-tracker` (assert by `name`).
- PostToolUse Bash event with `npm test` + `exit_code:0` + `session_id:'s1'` + a real temp `rootDir` → response is `decision:'allow'`, `stale_hint` defined; `<root>/.nexus/session-state.json` exists with the matching record.
- PreToolUse Bash event for `git commit` + stub engine forwarded via `DispatchOptions.queryEngine` + seeded session state → response is `decision:'allow'`, `rule:'evidence-summary'`, `additional_context` non-empty. (Inject the rule via a test-only `DispatchOptions.rules` override built from `buildEvidenceRule({runGit: stub})` + other `DEFAULT_RULES` minus the default `evidenceSummaryRule`. This avoids exec'ing real git from tests.)

- [ ] **Step 2: Update `DEFAULT_RULES`**

Edit `src/policy/index.ts`:

```typescript
export { evidenceSummaryRule, buildEvidenceRule } from './rules/evidence-summary.js';
export { testTrackerRule } from './rules/test-tracker.js';

import { evidenceSummaryRule } from './rules/evidence-summary.js';
import { testTrackerRule } from './rules/test-tracker.js';
// ... existing imports ...

export const DEFAULT_RULES: readonly PolicyRule[] = [
  grepOnCodeRule,
  readOnStructuredRule,
  readOnSourceRule,
  preeditImpactRule,
  evidenceSummaryRule,
  testTrackerRule,
];
```

- [ ] **Step 3: Verify**

Run `npm test -- policy-dispatcher` — passes.
Run `npm run build` — passes.

- [ ] **Step 4: Commit**

```
feat(policy): register evidence-summary + test-tracker in DEFAULT_RULES (D3)
```

---

## Task 9: Bin entrypoint — forward `tool_response`

**Files:**
- Modify: `src/transports/policy-entry.ts`
- Modify: `tests/policy-entry.test.ts`

- [ ] **Step 1: Add failing E2E tests**

Append to `tests/policy-entry.test.ts`:

- PostToolUse `npm test` event with `exit_code:0` + `session_id:'s1'` against a real temp project — assert stdout `decision:'allow'`, then assert `<tmp>/.nexus/session-state.json` exists with the matching record.
- PreToolUse `git commit` event with no `.nexus/index.db` (rule's `ctx.queryEngine` falls open) — assert silent `allow` (no `additional_context`).
- PreToolUse `git commit` event with a seeded `.nexus/index.db` containing one source file with one importer + one caller in a temp git repo (init + add + commit a baseline so `git status` reports the dirty edit). Assert stdout `decision:'allow'`, `additional_context` mentions the symbol.

The seeded fixture follows the pattern of the existing C1 entry test (`tests/policy-entry.test.ts` already has a tmp-repo + `runIndex` flow you can reuse).

For the fixture: create two source files (`src/foo.ts` exports `foo`; `src/bar.ts` calls `foo`); index; commit baseline; modify `src/foo.ts` (so `git status --porcelain` reports it dirty); then run the bin.

- [ ] **Step 2: Update `policy-entry.ts`**

Edit `parseEvent`:

```typescript
function parseEvent(raw: string): PolicyEvent | null {
  try {
    const obj = JSON.parse(raw) as Partial<PolicyEvent>;
    if (typeof obj.tool_name !== 'string') return null;
    return {
      hook_event_name: typeof obj.hook_event_name === 'string' ? obj.hook_event_name : 'PreToolUse',
      tool_name: obj.tool_name,
      tool_input: (obj.tool_input ?? {}) as Record<string, unknown>,
      ...(obj.tool_response && typeof obj.tool_response === 'object'
        ? { tool_response: obj.tool_response as Record<string, unknown> }
        : {}),
      session_id: typeof obj.session_id === 'string' ? obj.session_id : undefined,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
    };
  } catch {
    return null;
  }
}
```

No other changes — `dispatchPolicy` already forwards `queryEngine`; `DEFAULT_RULES` already includes the new rules.

- [ ] **Step 3: Verify**

Run `npm test -- policy-entry` — passes.
Run `npm run build` — passes.

- [ ] **Step 4: Commit**

```
feat(transports): policy-entry forwards tool_response from event JSON (D3)
```

---

## Task 10: MCP — accept `tool_response` + `session_id` on `nexus_policy_check`

**Files:**
- Modify: `src/transports/mcp.ts`
- Modify: `tests/mcp.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/mcp.test.ts`:

- `nexus_policy_check` schema lists `tool_response` and `session_id` on the event input shape.
- Calling `nexus_policy_check` with a PreToolUse Bash `git commit` event against a seeded fixture returns a result whose `additional_context` is non-empty. (Reuse the seed pattern from Task 9 or the C1 mcp test.)
- Calling `nexus_policy_check` with a PostToolUse Bash `npm test` event with `tool_response: {exit_code: 0}` and `session_id: 's1'` writes the session-state file and returns `decision: 'allow'`.

- [ ] **Step 2: Update the schema + handler**

In `src/transports/mcp.ts`, find the `nexus_policy_check` tool schema and add the optional fields to the `event` object:

```typescript
event: {
  type: 'object',
  properties: {
    hook_event_name: { type: 'string' },
    tool_name: { type: 'string' },
    tool_input: { type: 'object' },
    tool_response: { type: 'object', description: 'PostToolUse only' },
    session_id: { type: 'string' },
    cwd: { type: 'string' },
  },
  required: ['tool_name', 'tool_input'],
},
```

In `executePolicyCheck`, forward `tool_response` and `session_id` into the dispatched event verbatim. They should already flow because the existing handler likely passes the whole event through; verify and adjust if it explicitly whitelists fields.

- [ ] **Step 3: Verify**

Run `npm test -- mcp` — passes.
Run `npm run build` — passes.

- [ ] **Step 4: Commit**

```
feat(mcp): nexus_policy_check accepts tool_response + session_id (D3)
```

---

## Task 11: Bash dispatcher — `nexus-first.sh` Bash branch

**Files:**
- Modify: `hooks/nexus-first.sh`

- [ ] **Step 1: Smoke-test the existing matcher**

Run by piping a JSON event through the script (no test fixture needed — manual verification):

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | bash hooks/nexus-first.sh
```

Expected with the unchanged script: empty stdout (no Bash branch yet).

- [ ] **Step 2: Add the Bash branch**

After the `Edit / Write` block, before the final `exit 0`, add:

```bash
# ── Bash: delegate to nexus-policy-check ─────────────────────────────
if [ "$TOOL_NAME" = "Bash" ]; then
  if command -v nexus-policy-check >/dev/null 2>&1; then
    DECISION=$(echo "$INPUT" | nexus-policy-check)
  else
    DECISION=$(echo "$INPUT" | npx --no-install nexus-policy-check 2>/dev/null)
  fi
  if [ -z "$DECISION" ]; then exit 0; fi

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

Update the header block to mention Bash and update install matcher to `"Grep|Glob|Agent|Read|Edit|Write|Bash"`.

- [ ] **Step 3: Smoke-test**

```sh
# Should be empty (no trigger on `git status`):
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | bash hooks/nexus-first.sh

# In a repo with a dirty indexed file + .nexus/index.db, should emit hookSpecificOutput.allow with additionalContext:
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m wip"},"session_id":"s1"}' \
  | bash hooks/nexus-first.sh
```

- [ ] **Step 4: Commit**

```
feat(hooks): nexus-first.sh Bash branch delegates to nexus-policy-check (D3)
```

---

## Task 12: PostToolUse dispatcher — `nexus-post.sh`

**Files:**
- Create: `hooks/nexus-post.sh`

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
# nexus-post.sh — Claude Code PostToolUse dispatcher for the test-tracker rule.
#
# Records successful test runs to .nexus/session-state.json so the
# evidence-summary rule (PreToolUse on git/gh commands) can answer
# tests_run_this_session.
#
# Disable temporarily:  NEXUS_FIRST_DISABLED=1
#
# Install:
#   1. Copy this file to ~/.claude/hooks/nexus-post.sh and chmod +x
#   2. Add to ~/.claude/settings.json under "hooks":
#        "PostToolUse": [
#          {
#            "matcher": "Bash",
#            "hooks": [
#              { "type": "command",
#                "command": "bash -c 'source ~/.bashrc && bash ~/.claude/hooks/nexus-post.sh'" }
#            ]
#          }
#        ]
#
# Requires `nexus-policy-check` on PATH (or local node_modules/.bin).

if [ "$NEXUS_FIRST_DISABLED" = "1" ]; then
  exit 0
fi

INPUT=$(cat)
if command -v nexus-policy-check >/dev/null 2>&1; then
  echo "$INPUT" | nexus-policy-check >/dev/null 2>&1 || true
else
  echo "$INPUT" | npx --no-install nexus-policy-check >/dev/null 2>&1 || true
fi
exit 0
```

- [ ] **Step 2: Make it executable**

```sh
chmod +x hooks/nexus-post.sh
```

- [ ] **Step 3: Smoke-test**

```sh
echo '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":{"exit_code":0},"session_id":"s1","cwd":"'"$PWD"'"}' \
  | bash hooks/nexus-post.sh

cat .nexus/session-state.json   # → contains the npm test record
```

- [ ] **Step 4: Commit**

```
feat(hooks): add nexus-post.sh PostToolUse dispatcher (D3)
```

---

## Task 13: Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`
- Modify: `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md`

- [ ] **Step 1: CHANGELOG**

Prepend a new `[Unreleased]` block to `CHANGELOG.md`:

```
## [Unreleased] — D3 v1 evidence summary (warning-first)

### Added
- **`evidence-summary` policy rule** — PreToolUse Bash events whose command matches `git commit`, `git push`, or `gh pr create` get an informational `additional_context` summary. Payload includes `tests_run_this_session`, `affected_callers` (top-level exports of the change set with caller counts + ≤3 sample sites each), `new_unused_exports`, `caller_risk` (`low|medium|high` from `bucketRisk`), and `evidence_ok`. Never blocks. Falls open when the DB is unavailable, no changed file is indexed, or git is missing.
- **`test-tracker` policy rule** — PostToolUse Bash events whose command matches a configured allow-list (`npm test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `nexus test`, …) and whose `tool_response.exit_code` is `0` are recorded to `.nexus/session-state.json`, keyed on `session_id`. Cross-session entries are isolated.
- **`hooks/nexus-post.sh`** — PostToolUse dispatcher for Bash. Pipes the event to `nexus-policy-check` and discards stdout. Install matcher: `"Bash"`.
- `hooks/nexus-first.sh` now handles Bash PreToolUse — install matcher updated to `"Grep|Glob|Agent|Read|Edit|Write|Bash"`.
- `PolicyEvent.tool_response?: Record<string, unknown>` — present on PostToolUse only; consumed by `test-tracker`.
- `QueryEngineLike` widens to add `unusedExports` plus richer `callers` callsite shape so D3 can read sample sites.

### Notes
- Never hard-denies. Worst case is silent allow.
- `additional_context` capped at 1200 chars; affected_callers/new_unused_exports each capped at 10 entries with `…+N more` suffixes.
- Test command allow-list is hard-coded in V3 — `.nexus.json` `testCommands` overrides land with the V4 long-lived policy worker.
- Closes V3 Tier 1.
```

- [ ] **Step 2: CLAUDE.md**

Extend the **Policy transport** section's shipped-rules list:

```
- `evidence-summary` — on `Bash` PreToolUse events matching `git commit|push|gh pr create`, emits `allow + additionalContext` summarizing affected callers, unused exports, and whether tests have run this session. Never blocks.
- `test-tracker` — on `Bash` PostToolUse events matching a test allow-list with `exit_code: 0`, records the run to `.nexus/session-state.json` keyed on `session_id`.
```

Add an install note for the new PostToolUse hook (one paragraph after the existing PreToolUse description).

- [ ] **Step 3: Roadmap**

Edit `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md`. Replace the D3 v1 section with a "SHIPPED" header (mirror the C1 ship note), and update the document's status line if it has one (e.g. "V3 Tier 1 closed YYYY-MM-DD").

- [ ] **Step 4: Commit**

```
docs: D3 v1 evidence summary shipped — closes V3 Tier 1
```

---

## Task 14: Final verification

**Files:** None modified.

- [ ] **Step 1: Full build + tests**

```sh
npm run build
npm test
npm run lint
```

All three exit 0. Note the new test count (Task 1's baseline + the 4 new test files).

- [ ] **Step 2: Manual smoke**

In a clean clone, install both hook scripts under `~/.claude/hooks/` and update `~/.claude/settings.json` with both matchers. Verify by:

1. `npm test` → check `.nexus/session-state.json` gets a record.
2. Modify a source file with importers.
3. Run `git commit -m wip` (don't go through). Observe Claude's next turn — the `additionalContext` summary should be visible to the assistant (you can verify by checking the hook stdout via `bash ~/.claude/hooks/nexus-first.sh < event.json`).

- [ ] **Step 3: Latency check**

```sh
node benchmarks/policy-latency.js   # or equivalent existing harness
```

Compare to the C1 baseline. Budget per V3 spec: p50 < 100 ms, p95 < 300 ms. Non-blocking — record the result; flag it in the PR description if it regresses by more than 50%.

- [ ] **Step 4: Open PR**

Push the branch. Open a PR titled `D3 v1: self-review evidence summary (warning-first) — closes V3 Tier 1`. Body links the spec + this plan + the roadmap entry.

---

## Out of Scope (V4 follow-ups)

- `.nexus.json testCommands` regex allow-list — needs the long-lived policy worker so config doesn't load per event.
- Override-rate / dismissal telemetry — V4 D5.
- `git push --force` to `main` denial — V4 `protect-main-branch` rule (if metrics show it matters).
- PR-base resolution via `gh` API — V4 only if the local merge-base is consistently wrong.
- `affected_callers` filter to non-test callers — V4 only if telemetry shows test-only callers cause noise.
