# D3 v1 — Self-Review Evidence Summary (Warning-First) Design

**Status:** Design draft. Next: implementation plan.
**Spec reference:** V3 roadmap — D3 under "Tier 1 — V3 Specs".
**Depends on (all shipped):** Policy Transport, A1 `classifyPath()`, B1 `ref_kind` (drives `unusedExports` semantics), C1 pre-edit impact (reuses importer/caller aggregation + `bucketRisk`).
**Closes:** V3 Tier 1.

---

## Goal

When Claude is about to run `git commit`, `git push`, or `gh pr create`, surface
an *informational* evidence summary so the assistant can decide whether to add
tests, audit an unused export, or hold off. Never blocks. The payload is
shipped to the next assistant turn via `permissionDecision: allow` +
`additionalContext`, the same channel A5/C2 and C1 already use.

The summary is built from three primitives that already exist:

1. **`tests_run_this_session`** — booleanized signal from a PostToolUse-fed
   session log (`.nexus/session-state.json`).
2. **`affected_callers`** — for each indexed source file in the upcoming
   change set, top-level exported symbols + their caller counts (reuses
   `outline()` + `callers()` exactly as C1 does).
3. **`new_unused_exports`** — exports in the change set with no importers
   and no occurrences outside their own file (delegates to
   `unusedExports({path, mode:'default'})`, scoped to each changed file).

Plus three derived fields:

- **`caller_risk`** — `low | medium | high` from `bucketRisk(max callerCount)`.
- **`evidence_ok`** — `tests_run_this_session && caller_risk !== 'high' && new_unused_exports.length === 0`. V3 heuristic; the field is advisory.
- **`stale_hint`** — existing plumbing.

## Non-Goals

- **No hard deny.** Ever. D3 v1 is informational; gating waits on V4 metrics.
- **No new MCP tool.** Reuses `nexus_policy_check`; the `evidence-summary`
  rule branches on `tool_name === 'Bash'` + command-line regex.
- **No staged-vs-unstaged distinction in the payload.** The rule treats all
  dirty tracked files the same way Claude is about to commit them via the
  upcoming `git commit -a` or pre-staged add+commit pair.
- **No PR-diff fetching.** `gh pr create` is treated like `git push`: diff is
  branch HEAD vs `origin/<default-branch>` merge-base.
- **No telemetry persistence beyond session state.** V4 D5 owns long-term
  metrics; D3 v1 only owns the session log it depends on.
- **No re-export-chain traversal.** Reuses `unusedExports`'s existing default
  semantics; index-style re-exports may show as unused (already documented
  in CLAUDE.md).
- **No rule against `commit --amend`, `commit --fixup`, `git push --force`,**
  etc. The trigger is simple prefix-style command parsing; nuance can land in
  V4 if metrics show it matters.
- **No reindex.** Inherits `nexus_policy_check`'s no-`ensureFresh()` contract
  via `stale_hint`.

## Architecture

Two new `PolicyRule`s plus a tiny session-state utility:

- **`evidence-summary`** (PreToolUse on `Bash`) — the main user-facing rule.
  Detects git/gh commands; computes the change set from git; aggregates
  callers + unused-exports via the existing `QueryEngineLike`; emits
  `allow + additional_context` with the summary.
- **`test-tracker`** (PostToolUse on `Bash`) — records successful test
  runs in `.nexus/session-state.json`. Returns `noop` (the dispatcher already
  treats `noop` as a non-vote); the rule has no user-visible effect.
- **`src/policy/session-state.ts`** — pure read/write helpers around the JSON
  store, used by `test-tracker` (write) and `evidence-summary` (read).
- **`src/policy/evidence.ts`** — pure helpers (DB-free): bash-command parser
  (`parseGitTrigger`, `parseTestCommand`), summary formatter, types.

The bash dispatcher gains:

- A `Bash` branch in the existing `hooks/nexus-first.sh` (PreToolUse).
- A new `hooks/nexus-post.sh` script for PostToolUse on `Bash`. The two
  scripts share zero state and run independently.

`PolicyEvent` grows an optional `tool_response?: Record<string, unknown>`
field — required by PostToolUse rules to read the exit code. PreToolUse
rules ignore it.

`PolicyContext` does not change. The new rule reuses the existing
`queryEngine` plumbing C1 added.

## Components

### 1. `src/policy/types.ts` (modify)

Add `tool_response` to `PolicyEvent`:

```ts
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

No other type changes.

### 2. `src/policy/session-state.ts` (create)

Pure helpers around `.nexus/session-state.json`. No external deps; reads and
writes the file synchronously with atomic-rename for write durability.

```ts
export interface TestRunRecord {
  cmd: string;        // exact command string that matched
  ts_ms: number;      // Date.now() at hook fire
  exit: number;       // 0 only — non-zero never recorded, but kept for forward-compat
}

export interface SessionState {
  session_id: string;
  started_at: number;     // Date.now() at first write
  tests_run: TestRunRecord[];
}

export function readSessionState(rootDir: string, sessionId: string): SessionState | null;
export function appendTestRun(rootDir: string, sessionId: string, record: TestRunRecord): void;
export function hasTestRunThisSession(rootDir: string, sessionId: string): boolean;
```

Write path uses `fs.writeFileSync(tmp); fs.renameSync(tmp, real)` to avoid
partial reads. File capped at 256 entries — older entries dropped FIFO. If the
file is corrupt JSON, `readSessionState` returns `null` (treated as "no
tests run").

Cross-session isolation is by file. If `state.session_id !== sessionId`, the
file is overwritten on the next append (fresh session). The file path is
`${rootDir}/.nexus/session-state.json`. The `.nexus/` directory is created
on demand if missing — same convention as the rest of the store.

### 3. `src/policy/evidence.ts` (create)

Pure helpers + types — DB-free, no fs except inside `parseGitTrigger`'s
fallback. Mirrors the shape of `src/policy/impact.ts`.

```ts
export type GitTrigger =
  | { kind: 'commit' }
  | { kind: 'push' }
  | { kind: 'pr_create' };

/**
 * Parse a Bash command string for the first git/gh trigger we care about.
 * Splits on `&&`, `||`, `;`; checks each segment. Whitespace-tolerant.
 * Returns null if no trigger is present.
 *
 * Match patterns (case-sensitive — git commands are):
 *   commit:    /^\s*git\s+commit(\s|$)/
 *   push:      /^\s*git\s+push(\s|$)/
 *   pr_create: /^\s*gh\s+pr\s+create(\s|$)/
 *
 * `git commit --amend` and `git push --force` match. The rule does not
 * special-case them in V3.
 */
export function parseGitTrigger(command: string): GitTrigger | null;

/**
 * Parse a Bash command for a test invocation against the configured
 * allow-list. Returns the matching command segment (canonicalized — leading
 * env vars and prefixes stripped) or null.
 *
 * Default allow-list: see TEST_COMMAND_PATTERNS below.
 */
export function parseTestCommand(
  command: string,
  patterns?: readonly RegExp[],
): string | null;

export const TEST_COMMAND_PATTERNS: readonly RegExp[];

export interface AffectedCaller {
  symbol: string;
  file: string;
  caller_count: number;
  sample_sites: { file: string; line: number }[]; // ≤3
}

export interface NewUnusedExport {
  symbol: string;
  file: string;
  kind: string;
}

export interface EvidenceSummary {
  trigger: GitTrigger['kind'];
  tests_run_this_session: boolean;
  affected_callers: AffectedCaller[];      // ≤10, sorted by caller_count desc
  new_unused_exports: NewUnusedExport[];   // ≤10
  caller_risk: 'low' | 'medium' | 'high';
  evidence_ok: boolean;
  stale_hint: boolean;                     // also surfaced via PolicyResponse.stale_hint
}

export const SUMMARY_MAX_CHARS = 1200;     // larger than C1's 600 — multi-symbol payload
export const MAX_AFFECTED_CALLERS = 10;
export const MAX_UNUSED_EXPORTS = 10;
export const MAX_SAMPLE_SITES = 3;

/**
 * Format an EvidenceSummary as the additionalContext string. Wraps lines
 * for readability, trims to SUMMARY_MAX_CHARS with `…+N more` suffix.
 */
export function formatEvidenceSummary(s: EvidenceSummary): string;
```

### `TEST_COMMAND_PATTERNS` default list

Each regex matches a *segment* of a `&&`-split command. They run after
leading env-var assignments are stripped (e.g. `CI=1 npm test` → `npm test`):

```
/^npm\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/
/^pnpm\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/
/^yarn\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/
/^vitest(?:\s|$)/
/^jest(?:\s|$)/
/^pytest(?:\s|$)/
/^go\s+test(?:\s|$)/
/^cargo\s+test(?:\s|$)/
/^nexus\s+test(?:\s|$)/
```

User overrides via `.nexus.json` `testCommands: string[]` are NOT loaded on
the hot path in V3 — same rationale as A5/C2's source-rule deferral. V4
long-lived policy worker may load them. Until then, the default list ships.

### 4. `src/policy/rules/evidence-summary.ts` (create)

The PreToolUse rule.

```ts
export const evidenceSummaryRule: PolicyRule = {
  name: 'evidence-summary',
  evaluate(event, ctx) {
    if (event.hook_event_name !== 'PreToolUse') return null;
    if (event.tool_name !== 'Bash') return null;

    const command = event.tool_input.command;
    if (typeof command !== 'string' || command.length === 0) return null;

    const trigger = parseGitTrigger(command);
    if (!trigger) return null;

    if (!ctx.queryEngine) return null;

    // 1. Collect changed files (git source of truth, not the index).
    const changed = collectChangedFiles(ctx.rootDir, trigger.kind);
    if (changed.length === 0) return null;

    // 2. Filter to indexed source files only.
    const sources = filterIndexedSources(changed, ctx.queryEngine);

    // 3. Aggregate affected callers (top-level exports per file).
    const affected = aggregateAffectedCallers(ctx.queryEngine, sources);

    // 4. Aggregate new_unused_exports.
    const unused = aggregateNewUnusedExports(ctx.queryEngine, sources);

    // 5. Read session state.
    const sessionId = event.session_id ?? '';
    const testsRun = sessionId
      ? hasTestRunThisSession(ctx.rootDir, sessionId)
      : false;

    // 6. Risk + evidence_ok.
    const maxCallers = affected.reduce((m, a) => Math.max(m, a.caller_count), 0);
    const callerRisk = bucketRisk(maxCallers);  // C1 helper
    const evidenceOk = testsRun && callerRisk !== 'high' && unused.length === 0;

    const summary: EvidenceSummary = {
      trigger: trigger.kind,
      tests_run_this_session: testsRun,
      affected_callers: affected.slice(0, MAX_AFFECTED_CALLERS),
      new_unused_exports: unused.slice(0, MAX_UNUSED_EXPORTS),
      caller_risk: callerRisk,
      evidence_ok: evidenceOk,
      stale_hint: false, // set by dispatcher
    };

    return {
      decision: 'allow',
      rule: 'evidence-summary',
      additional_context: formatEvidenceSummary(summary),
    };
  },
};
```

#### `collectChangedFiles(rootDir, trigger)` — internal

- For `commit`: dirty tracked files (staged + unstaged), via
  `git status --porcelain=v1`. Untracked files ignored — the index doesn't
  know them anyway.
- For `push` and `pr_create`: `git diff --name-only $(git merge-base HEAD <upstream>)..HEAD`.
  `<upstream>` = `git rev-parse --abbrev-ref --symbolic-full-name @{u}` if set,
  else `origin/$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')`,
  else `origin/main`, else `main`. Any failure short-circuits to empty (rule
  returns `null` → silent allow).

All shell calls go through `execFileSync` with stdio piped, env scrubbed,
3000ms timeout. Failure → return empty list (silent allow).

#### `filterIndexedSources(changed, engine)` — internal

For each changed POSIX path, call `engine.outline(file)`. Drop entries whose
`results[0]` is missing (file not indexed) or whose underlying file kind
isn't a source. The outline result already encodes `language` indirectly via
file metadata — we treat any non-empty outline as an indexed source. Returns
`{ file, outline }[]`.

#### `aggregateAffectedCallers(engine, sources)` — internal

For each `{ file, outline }`:
- Iterate top-level outline entries whose `name` ∈ `outline.exports`.
- For each, call `engine.callers(name, { file, limit: 50 })`.
- Build `AffectedCaller` with `caller_count = results[0]?.callers?.length ?? 0`
  and up to `MAX_SAMPLE_SITES` sample sites (caller file + first call_site
  line, taken in the order the engine returned them).

Aggregate flat across files. Sort descending by `caller_count`. The `≤10`
cap is applied at format time; the helper returns the full list so the
ranker / future telemetry can see everything.

Errors per-call → treat as 0 callers for that symbol; never throw.

#### `aggregateNewUnusedExports(engine, sources)` — internal

For each source, call `engine.unusedExports({ path: file, limit: 20, mode: 'default' })`.
Concatenate. Map each result row to `{ symbol, file, kind }`. Sort by file
then name for deterministic output. Failures per-call → empty list for that
file.

V3 default mode (NOT runtime-only) — matches the V3 roadmap explicitly:
> "default mode — see B1 semantics".

`QueryEngineLike` does NOT yet expose `unusedExports`. C1 added only the
three methods it needed; D3 widens the surface. See §6.

### 5. `src/policy/types.ts` `QueryEngineLike` widening (modify)

Add the methods this rule needs:

```ts
export interface QueryEngineLike {
  // existing C1 methods unchanged ...
  importers(source: string): { results: { file: string }[]; count: number };
  outline(filePath: string): { results: OutlineForImpact[] };
  callers(name: string, opts?: { file?: string; limit?: number }): {
    results: {
      callers: {
        caller?: { file?: string; line?: number };
        call_sites?: { line: number; col?: number }[];
      }[];
    }[];
  };

  // NEW for D3:
  unusedExports(opts?: {
    path?: string;
    limit?: number;
    mode?: 'default' | 'runtime_only';
  }): {
    results: { name: string; file: string; kind: string; line: number }[];
  };
}
```

The `callers` widening matches the real `CallerResult` shape
(`caller: SymbolResult`, `call_sites: CallerCallSite[]`). D3 reads the
sample site as `entry.call_sites?.[0]` and falls back to
`entry.caller?.file/line` for the file context. C1's existing usage of
`.callers.length` still satisfies the wider interface — no behavior change.

The real `QueryEngine.unusedExports` returns `UnusedExportResult` rows
(`{ file, name, kind, line }`), which structurally satisfies the wider
`QueryEngineLike`. The summary formatter maps `name → symbol` for the
output payload.

### 6. `src/policy/rules/test-tracker.ts` (create)

The PostToolUse rule. Returns `noop` after writing the side-effect.

```ts
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
      appendTestRun(ctx.rootDir, sessionId, {
        cmd: matched,
        ts_ms: Date.now(),
        exit: 0,
      });
    } catch {
      // never throw from a hook
    }
    return { decision: 'noop', rule: 'test-tracker' };
  },
};

function readExitCode(resp: unknown): number | null {
  if (!resp || typeof resp !== 'object') return null;
  const v = (resp as Record<string, unknown>).exit_code;
  return typeof v === 'number' ? v : null;
}
```

Returning `noop` is intentional: the dispatcher's loop continues to the next
rule (none other matches a PostToolUse Bash event) and finally returns
`{ decision: 'allow', stale_hint }`. The hook script doesn't need to inspect
the response — `nexus-post.sh` exits 0 unconditionally.

### 7. `src/policy/dispatcher.ts` (modify)

No change. The dispatcher already iterates rules and treats `noop` as
non-deciding. `extractTouchedPath` returns `undefined` for Bash events
(no `file_path` key); `stale_hint` falls back to global mtime — fine.

### 8. `src/policy/index.ts` (modify)

Append the two new rules to `DEFAULT_RULES`:

```ts
export const DEFAULT_RULES: readonly PolicyRule[] = [
  grepOnCodeRule,
  readOnStructuredRule,
  readOnSourceRule,
  preeditImpactRule,
  evidenceSummaryRule,
  testTrackerRule,
];
```

Order rationale: existing rules are tool-name disjoint with the new ones
(`Grep`/`Read`/`Edit`/`Write` vs. `Bash`). The two `Bash` rules are also
disjoint by `hook_event_name`. So insertion order is purely cosmetic.

### 9. `src/transports/policy-entry.ts` (modify)

`tool_response` is parsed off the raw event JSON in `parseEvent`:

```ts
const obj = JSON.parse(raw) as Partial<PolicyEvent>;
// ...
return {
  hook_event_name: ...,
  tool_name: ...,
  tool_input: ...,
  ...(obj.tool_response && typeof obj.tool_response === 'object'
    ? { tool_response: obj.tool_response as Record<string, unknown> }
    : {}),
  session_id: ...,
  cwd: ...,
};
```

`tryOpenEngine` is unchanged — `evidence-summary` reuses the existing
read-only engine. Test tracker doesn't need the engine.

### 10. `src/transports/mcp.ts` (modify)

`executePolicyCheck` already forwards the server-side `QueryEngine` (added
in C1). `nexus_policy_check` schema gains an optional `tool_response` and
`session_id` field on the event-input shape. No new tool. Existing callers
unaffected.

### 11. `hooks/nexus-first.sh` (modify)

Add a `Bash` branch mirroring the existing `Edit`/`Write` branch — `allow +
additionalContext` only.

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

Header block: describe the Bash branch, update install matcher to
`"Grep|Glob|Agent|Read|Edit|Write|Bash"`.

### 12. `hooks/nexus-post.sh` (create)

Tiny PostToolUse dispatcher. Pipes the event to `nexus-policy-check` and
discards the response — the test-tracker rule's side-effect is the entire
point.

```bash
#!/usr/bin/env bash
# nexus-post.sh — PostToolUse dispatcher for the test-tracker rule.
#
# Records successful test runs to .nexus/session-state.json so the
# evidence-summary rule (PreToolUse on git/gh commands) can answer
# tests_run_this_session: bool.
#
# Install (settings.json under "hooks"):
#   "PostToolUse": [
#     { "matcher": "Bash",
#       "hooks": [
#         { "type": "command",
#           "command": "bash -c 'source ~/.bashrc && bash ~/.claude/hooks/nexus-post.sh'" }
#       ]
#     }
#   ]

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

The script never emits stdout — PostToolUse hooks don't influence the
assistant's next turn. Failure is always silent.

## Data Flow

### PreToolUse — happy case (commit)

```
PreToolUse{Bash, command:"git commit -m 'feat: foo'"}
  → nexus-first.sh Bash branch
  → nexus-policy-check
  → evidenceSummaryRule:
      parseGitTrigger("git commit -m '...'") → {kind:'commit'}
      collectChangedFiles(root, 'commit'):
        git status --porcelain → ["M src/foo.ts", "?? scratch.md"]
        → ["src/foo.ts"]            (filter to tracked)
      filterIndexedSources(["src/foo.ts"], engine):
        outline("src/foo.ts") → {exports:['foo','helper'], outline:[...]}
      aggregateAffectedCallers:
        for 'foo' (exported, top-level): callers → 6 callers
        for 'helper' (not exported): skip
      aggregateNewUnusedExports:
        unusedExports({path:'src/foo.ts'}) → []
      hasTestRunThisSession(root, sessionId) → true
      bucketRisk(6) → 'medium'
      evidence_ok = true && 'medium' !== 'high' && 0===0 = true
      formatEvidenceSummary(...) →
        "✅ Commit evidence: tests_run, 1 affected export (foo, 6 callers, medium risk), no new unused exports."
  → PolicyResponse{allow, rule:'evidence-summary', additional_context:<summary>, stale_hint:false}
  → nexus-first.sh emits hookSpecificOutput{allow, additionalContext:<summary>}
  → Claude Code injects into next assistant turn
```

### PreToolUse — skip cases (all return `null`)

- Command not git/gh: `parseGitTrigger` returns `null`.
- Not a commit/push/pr_create flavour we recognise.
- `ctx.queryEngine` undefined (DB missing).
- `collectChangedFiles` returns empty (clean tree, or git unavailable).
- No changed file is indexed — nothing to summarize.

When the rule returns `null`, the dispatcher continues; no other rule
matches a Bash PreToolUse, so the response is silent allow.

### PostToolUse — happy case

```
PostToolUse{Bash, command:"npm test", tool_response:{exit_code:0,...}}
  → nexus-post.sh
  → nexus-policy-check
  → testTrackerRule:
      parseTestCommand("npm test") → "npm test"
      exit_code === 0 ✓
      appendTestRun(root, sessionId, {cmd:"npm test", ts_ms:..., exit:0})
        → reads or creates .nexus/session-state.json
        → if state.session_id !== sessionId: rewrite fresh
        → else: append, FIFO-cap to 256 entries
        → write to state.tmp + rename
      return {decision:'noop', rule:'test-tracker'}
  → dispatchPolicy continues; no other Bash rule decides
  → returns {decision:'allow', stale_hint, rule:undefined}
  → nexus-post.sh discards stdout
```

### PostToolUse — skip cases

- Command not in test allow-list.
- `tool_response.exit_code !== 0`.
- No `session_id` on the event.
- File-write failure (silent).

### MCP fallback

`nexus_policy_check({event})` → `executePolicyCheck` → `dispatchPolicy` with
the server-side QueryEngine. PreToolUse evidence-summary works identically.
PostToolUse test-tracker also works (the rule's side-effect updates the same
`.nexus/session-state.json`); whether the MCP caller benefits depends on
whether they pass `tool_response` + `session_id`.

## Error Handling

- **Git unavailable / not a repo / detached HEAD with no upstream / merge-base
  fails:** `collectChangedFiles` returns empty → rule skips. Silent allow.
- **`git status` reports a renamed file (`R old -> new`):** treat the new
  path as the changed one; existing `git status --porcelain=v1` parser
  handles this.
- **`outline` throws on a path:** treat that file as not-indexed; continue.
- **`callers` throws for one symbol:** treat as 0 callers; continue.
- **`unusedExports` throws for one file:** treat as empty; continue.
- **Session-state file missing or unparseable:** `hasTestRunThisSession`
  returns `false`; `appendTestRun` overwrites with a fresh `SessionState`.
- **Session-state file is from a different session_id:** treated as no
  prior runs; the next `appendTestRun` rewrites the file fresh.
- **Concurrent PostToolUse calls:** atomic-rename write; last writer wins.
  Acceptable — the field is "did *any* test run", not a precise count.
- **`additional_context` over `SUMMARY_MAX_CHARS`:** truncated with
  `…+N more callers` / `…+N more unused` suffixes per section.
- **Engine missing:** `evidence-summary` returns `null` (silent allow).
- **`session_id` missing on the event:** rule still emits the summary but
  with `tests_run_this_session: false`. PostToolUse rule skips
  (no session means no session-keyed file).

**Invariant:** no failure ever blocks `Bash`. Worst case is silent allow.

## Testing

### Unit — `tests/policy-evidence.test.ts` (new, DB-free)

`parseGitTrigger`:
- `"git commit -m 'x'"` → `{kind:'commit'}`.
- `"git commit"` → `{kind:'commit'}`.
- `"git commit --amend"` → `{kind:'commit'}` (V3 doesn't special-case).
- `"git push"` and `"git push --force"` → `{kind:'push'}`.
- `"gh pr create --title x"` → `{kind:'pr_create'}`.
- `"git add . && git commit -m 'x'"` → `{kind:'commit'}` (segment match).
- `"git status"` → `null`.
- `"echo git commit"` → `null` (segment must start with `git`).
- `"GIT_AUTHOR_NAME=foo git commit"` → `{kind:'commit'}` (env-var prefix
  stripping).
- `""` and whitespace-only → `null`.

`parseTestCommand`:
- `"npm test"` / `"npm run test"` / `"npm run test:unit"` → matched.
- `"yarn test"` / `"pnpm test"` / `"pnpm run test"` → matched.
- `"vitest"` / `"jest"` / `"pytest"` / `"go test"` / `"cargo test"` /
  `"nexus test"` → matched.
- `"CI=1 npm test"` → matched (env-var stripping).
- `"npm test && git push"` → matched on first segment.
- `"npm install"` / `"echo npm test"` → null.
- Custom-pattern overload returns null when none match.

`bucketRisk` reuse — covered by C1 tests; D3 only adds an integration test
that asserts the threshold against a fixture max-caller value.

`formatEvidenceSummary`:
- All-green case: includes `✅`, `tests_run`, `0 affected`, no unused.
- Warning case (`evidence_ok=false`): includes `⚠️`, lists symbols, lists
  unused.
- High-risk case: includes `caller_risk: high`, top symbol in lead.
- Length cap: synthetic 30-symbol payload truncated with `…+N more`.

### Unit — `tests/policy-session-state.test.ts` (new)

- `appendTestRun` creates `.nexus/session-state.json` atomically.
- `appendTestRun` with same `session_id` appends.
- `appendTestRun` with new `session_id` rewrites fresh.
- `hasTestRunThisSession` matches only the current session_id.
- `readSessionState` returns `null` on missing file.
- `readSessionState` returns `null` on corrupt JSON.
- FIFO cap at 256 entries.
- Concurrent writes: 10 `appendTestRun`s in parallel → final state has
  10 entries, no torn writes (uses temp directory).

### Unit — `tests/policy-rules-evidence-summary.test.ts` (new)

Stubs `QueryEngineLike` plus a fake `git` binary on PATH (or simply mocks
the helper's exec wrapper via dependency injection).

- Commit on dirty repo with one indexed source + 1 importer + 6 callers
  → `allow`, summary mentions symbol + `medium` + `tests_run_this_session:false`.
- Commit when `parseGitTrigger` returns `null` (e.g. `git status`) → `null`.
- Commit with no changed files → `null`.
- Commit with changed files but none indexed → `null`.
- Push with merge-base resolving correctly → trigger `push`, summary set.
- `gh pr create` → trigger `pr_create`.
- `ctx.queryEngine` undefined → `null`.
- `engine.unusedExports` throws → unused list is `[]`, summary still emitted.
- Test-run flag: with session-state seeded → `tests_run_this_session:true`.
- Cap: 30 affected exports → summary lists top 10 + `…+N more callers`.

### Unit — `tests/policy-rules-test-tracker.test.ts` (new)

- `npm test` PostToolUse with `exit_code:0` + `session_id:'sX'` → record written.
- `npm test` with `exit_code:1` → no write.
- Non-test command → no write.
- Missing `tool_response` → no write.
- Missing `session_id` → no write.
- File write failure (mocked) → no throw.
- PreToolUse event (wrong hook_event_name) → no write.

### Integration — `tests/policy-dispatcher.test.ts` (extend)

- PostToolUse Bash event flows through `dispatchPolicy` and lands at
  `testTrackerRule`. Final response is `allow` with `stale_hint`.
- PreToolUse Bash event with a git command + stub engine + seeded session
  → `decision:'allow'`, `additional_context` non-empty, `rule:'evidence-summary'`.

### End-to-end — `tests/policy-entry.test.ts` (extend)

- Spawn the bin with a PreToolUse `git commit` event against a temp repo
  with `.nexus/index.db` seeded — assert stdout `decision:'allow'`,
  `additional_context` mentions a known symbol.
- Spawn with PostToolUse `npm test` event + `exit_code:0` → assert the
  session-state.json file was written with the matching session_id.
- Spawn without DB on a `git commit` event → silent `allow`, no
  `additional_context`.

### MCP — `tests/mcp.test.ts` (extend)

- `nexus_policy_check` with a PreToolUse Bash git-commit event against a
  seeded fixture returns `additional_context` non-empty.
- `nexus_policy_check` with a PostToolUse Bash npm-test event writes the
  session-state file (or, more cleanly: assert the test-tracker rule's
  side-effect via a dedicated test that reads the file after the call).

### Manual smoke

```sh
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit -m wip"},"session_id":"s1"}' \
  | bash hooks/nexus-first.sh
```

Expected: `hookSpecificOutput.permissionDecision = allow`, `additionalContext`
populated.

```sh
echo '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":{"exit_code":0},"session_id":"s1"}' \
  | bash hooks/nexus-post.sh
```

Expected: silent (empty stdout). `cat .nexus/session-state.json` shows the
record.

## File Impact

| File | Action |
|---|---|
| `src/policy/types.ts` | Modify — add `tool_response` to `PolicyEvent`; widen `QueryEngineLike` with `unusedExports`. |
| `src/policy/session-state.ts` | Create — JSON store helpers + atomic write. |
| `src/policy/evidence.ts` | Create — pure helpers, regex constants, summary formatter. |
| `src/policy/rules/evidence-summary.ts` | Create — PreToolUse Bash rule. |
| `src/policy/rules/test-tracker.ts` | Create — PostToolUse Bash rule. |
| `src/policy/index.ts` | Modify — export + register the two rules. |
| `src/transports/policy-entry.ts` | Modify — parse `tool_response` from event JSON. |
| `src/transports/mcp.ts` | Modify — schema accepts `tool_response` + `session_id`. |
| `hooks/nexus-first.sh` | Modify — add Bash branch; update matcher. |
| `hooks/nexus-post.sh` | Create — PostToolUse dispatcher. |
| `package.json` | No change (`nexus-policy-check` bin already shipped). |
| `tests/policy-evidence.test.ts` | Create. |
| `tests/policy-session-state.test.ts` | Create. |
| `tests/policy-rules-evidence-summary.test.ts` | Create. |
| `tests/policy-rules-test-tracker.test.ts` | Create. |
| `tests/policy-dispatcher.test.ts` | Modify — Bash event routing. |
| `tests/policy-entry.test.ts` | Modify — bin E2E for both events. |
| `tests/mcp.test.ts` | Modify — `nexus_policy_check` Bash cases. |
| `CHANGELOG.md` | Modify — new `[Unreleased]` entry. |
| `CLAUDE.md` | Modify — extend policy-transport section; document `nexus-post.sh` install. |
| `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md` | Modify — mark D3 v1 shipped, close V3 Tier 1. |

## Metrics (V3 gate inputs)

- **Override rate** — not directly measurable here; `evidence-summary` emits
  `allow`, not `ask`. V4 D5 telemetry will track downstream behavior
  (e.g., did the agent run tests after a `tests_run:false` summary?).
- **FP rate** — proxied by qualitative dogfooding. Watch for: false unused
  exports (re-export chains; mitigated by `path` scoping), missing test
  runs (custom test commands not on the allow-list), spurious commits with
  `evidence_ok:false` on no-op refactors.
- **Added latency** — adds one `git status`/`git diff` (~5-30 ms typical) and
  N×(`outline` + `callers` + `unusedExports`) calls per changed indexed
  file. Bench under the existing `benchmarks/policy-latency.json` harness.
  Budget: p50 < 100 ms, p95 < 300 ms on a small repo. Non-blocking CI gate
  (same policy as A5/C2 and C1).

## Compatibility

- **Claude Code:** primary target. PreToolUse `additionalContext` and
  PostToolUse hooks both supported.
- **Codex:** PreToolUse hook support partial (per V3 compatibility matrix).
  PostToolUse not supported. Fallback: agents call `nexus_policy_check`
  explicitly — but `tests_run_this_session` will always be `false` in that
  path because PostToolUse never fires. Document the gap.
- **macOS / Linux / Windows (Git Bash):** unchanged dispatcher pattern;
  `git`/`gh` need to be on PATH (fail-open if not).

## Open Questions (deferred)

- **Should `gh pr create` look at the actual PR base, not local HEAD?**
  Decision: V3 uses local HEAD vs. upstream merge-base. Accurate enough; PR
  base resolution costs an `gh` API call.
- **Should `affected_callers` include test files in the count?** Currently
  yes — `callers` doesn't filter by file kind. V4 may add a `test=false`
  flag if telemetry shows test-only callers cause noise.
- **Should we expose a `nexus_evidence` MCP tool?** Decision: no in V3.
  Reuse `nexus_policy_check` so the rule is the source of truth and can
  evolve in lockstep with the hook payload.
- **Should `test-tracker` cap by file *size*, not just entry count?**
  256 entries × ~120 bytes ≈ 30 KB. Cap by entry count is fine.
- **Should we deny `git push --force` to `main`?** Out of scope. V4 may
  add a `protect-main-branch` rule; D3 v1 is informational only.
- **Should `commit --amend` skip the rule?** No — amend still affects
  callers. The summary applies. V4 may add nuance.
