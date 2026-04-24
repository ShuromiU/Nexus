# A5/C2 — Read-Redirect Policy (Warning-First) Design

**Status:** Design complete. Next: implementation plan.
**Spec reference:** V3 roadmap — A5/C2 under "Tier 1 — V3 Specs".
**Depends on (all shipped):** Policy Transport, A1 `classifyPath()`, A2 document cache + size caps, A3 structured MCP tools (including P2 `nexus_lockfile_deps`).
**Unblocks:** C1 pre-edit impact preview, D3 v1 evidence summary.

---

## Goal

When Claude is about to `Read` a file that a Nexus MCP tool could answer more
efficiently, surface that redirect as a policy decision through the existing
`nexus-policy-check` pipeline. Never hard-deny — the rules shape Claude's
tool choice without blocking the user.

Two cases:

1. `Read` on a structured config / lockfile → recommend the appropriate
   structured tool (`nexus_structured_query`, `nexus_structured_outline`,
   `nexus_lockfile_deps`).
2. `Read` on an indexed source file with neither `offset` nor `limit` →
   recommend `nexus_outline` / `nexus_source`.

Case 1 returns `permissionDecision: ask` so the user approves or overrides
(override rate is the core metric). Case 2 returns `permissionDecision: allow`
with `additionalContext` so Claude gets a nudge without interrupting the user.

## Non-Goals

- No hard deny on `Read`. Ever.
- No DB access on the hot path — rules rely on `classifyPath()` plus the
  existing `stale_hint` signal.
- No line-count heuristics. "Full-file read" means literally "no `offset` and
  no `limit`".
- No reindex trigger. The policy transport already bypasses `ensureFresh()`.
- No new MCP tool — reuses `nexus_policy_check`.
- No V4 gate promotion (V4 depends on V3 metrics).
- No Codex-specific special-casing beyond the existing MCP fallback.

## Architecture

Two new `PolicyRule`s registered in the existing `DEFAULT_RULES` array. Both
flow through the existing dispatcher → `nexus-policy-check` bin → MCP
(`nexus_policy_check`) pipeline. No new entrypoints. No schema bumps.

One small policy-layer addition: `PolicyDecision` and `PolicyResponse` gain an
optional `additional_context?: string` field, forwarded by the dispatcher, so
the "allow + nudge" path has a typed channel from rule → transport → hook.

The `Read` branch is added to the existing `hooks/nexus-first.sh` monolithic
dispatcher (consistent with how `Grep`/`Glob`/`Agent` are already organised).
No new bash file.

## Components

### 1. `src/policy/rules/common-paths.ts` (new)

Shared regex for path-based exclusions. Currently duplicated in
`grep-on-code.ts`; extracting lets `read-on-source` reuse the same list.

```ts
export const NON_CODE_PATH = /(node_modules|\.git|\.nexus|\/?docs\/|\.env|\.claude\/)/i;
```

`grep-on-code.ts` is updated to import this rather than redeclare.

### 2. `src/policy/rules/read-on-structured.ts` (new)

- Matches `event.tool_name === 'Read'`.
- Extracts `file_path` from `event.tool_input`. Non-string → return `null`.
- Resolves to an absolute path (relative to `ctx.rootDir` if not absolute).
- Computes the repo-relative POSIX path + basename.
- Calls `classifyPath(rel, basename, { languages: {} })` from
  `src/workspace/classify.ts` (A1 primitive). Config overrides from
  `.nexus.json` are intentionally not loaded on the hot path — resolving
  config would require disk I/O per event. Known limitation: a custom
  extension mapping (e.g. `.astro` → typescript) won't trigger the source
  rule until V4 adds a long-lived policy worker that can cache config.
  Default extension map still applies (covers 99% of cases).
- Maps kind → suggestion:

  | Kind | Suggested tool |
  |---|---|
  | `package_json`, `tsconfig_json`, `cargo_toml`, `gha_workflow`, `json_generic`, `yaml_generic`, `toml_generic` | `nexus_structured_query(file, path)` / `nexus_structured_outline(file)` |
  | `yarn_lock`, `package_lock`, `pnpm_lock`, `cargo_lock` | `nexus_lockfile_deps(file, name?)` |
  | anything else (`source`, `ignored`, unknown) | `null` |

- Returns `{ decision: 'ask', rule: 'read-on-structured', reason: <suggestion text> }`.

**Reason text format** (exact strings, so tests can assert):

- Structured files:
  `"Use nexus_structured_query or nexus_structured_outline instead of Read for <kind>. These tools return the parsed value by path or a shallow outline — cheaper than reading the whole file."`
- Lockfiles:
  `"Use nexus_lockfile_deps(file, name?) instead of Read for <kind>. It returns {name, version} entries directly — no JSON/YAML/TOML walking needed."`

`<kind>` is the tagged-union discriminator (`package_json`, `yarn_lock`, etc.).

### 3. `src/policy/rules/read-on-source.ts` (new)

- Matches `event.tool_name === 'Read'`.
- Returns `null` if `tool_input.offset !== undefined` OR
  `tool_input.limit !== undefined` — presence of either key (including the
  falsy value `0`) means the caller chose to page and should not be redirected.
- Extracts `file_path`; non-string → `null`.
- Resolves to absolute path; derives repo-relative POSIX path + basename.
- Rejects excluded paths via `NON_CODE_PATH`.
- Calls `classifyPath()`; returns `null` unless `kind.kind === 'source'`.
- Returns:

  ```ts
  {
    decision: 'allow',
    rule: 'read-on-source',
    additional_context:
      "This file is indexed by Nexus. Prefer nexus_outline(file) to see " +
      "structure + signatures, or nexus_source(symbol, file) for a specific " +
      "symbol. Fall back to Read if those don't answer the question. " +
      "The policy response includes stale_hint — if true, the index may lag " +
      "recent edits to this file.",
  }
  ```

### 4. `src/policy/types.ts` (modify)

Add optional field to both types:

```ts
export interface PolicyDecision {
  decision: 'allow' | 'ask' | 'deny' | 'noop';
  reason?: string;
  rule?: string;
  additional_context?: string;   // NEW
}

export interface PolicyResponse {
  decision: PolicyDecision['decision'];
  reason?: string;
  rule?: string;
  additional_context?: string;   // NEW
  stale_hint: boolean;
}
```

Semantics: `additional_context` is only meaningful when `decision` is `allow`
or `ask`; the dispatcher ignores it on `deny`/`noop`.

### 5. `src/policy/dispatcher.ts` (modify)

Forward `additional_context` from the rule's decision to the response:

```ts
return {
  decision: decision.decision,
  reason: decision.reason,
  rule: decision.rule,
  ...(decision.additional_context && decision.decision !== 'deny'
    ? { additional_context: decision.additional_context }
    : {}),
  stale_hint: computeStaleHint({ ... }),
};
```

The default-allow fallthrough is unchanged (no `additional_context`).

### 6. `src/policy/index.ts` (modify)

Register both rules in `DEFAULT_RULES`, after `grepOnCodeRule`:

```ts
import { readOnStructuredRule } from './rules/read-on-structured.js';
import { readOnSourceRule } from './rules/read-on-source.js';

export const DEFAULT_RULES: PolicyRule[] = [
  grepOnCodeRule,
  readOnStructuredRule,
  readOnSourceRule,
];
```

Order doesn't affect correctness (the two read rules are mutually exclusive by
kind, and neither matches `Grep`), but placing `grep-on-code` first preserves
backward-compatible short-circuit for existing behavior.

### 7. `hooks/nexus-first.sh` (modify)

Add a `Read` branch before the final `exit 0`:

```bash
# ── Read: delegate to nexus-policy-check ─────────────────────────────
if [ "$TOOL_NAME" = "Read" ]; then
  if command -v nexus-policy-check >/dev/null 2>&1; then
    DECISION=$(echo "$INPUT" | nexus-policy-check)
  else
    DECISION=$(echo "$INPUT" | npx --no-install nexus-policy-check 2>/dev/null)
  fi

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

A future rule that returns `deny` on a `Read` event would be silently
allowed by this branch. V3 explicitly never denies `Read`, so this is
intentional. If/when C1 introduces a deny path for `Edit`/`Write`, its
handler block will mirror the Grep pattern (emit `permissionDecision:"deny"`
with reason).

Header block is updated to document the new Read behavior and to add `Read`
to the matcher in the install instructions (i.e. the example matcher becomes
`"Grep|Glob|Agent|Read"`).

### 8. `src/transports/mcp.ts` (no change)

`executePolicyCheck` already returns the full `PolicyResponse` shape including
optional fields. Because `respond()` serializes the whole envelope, clients
receive `additional_context` automatically.

The compact-mode key map (`src/query/compact.ts`) is untouched — V4 may add a
short key for `additional_context` if payload size matters in practice.

## Data Flow

### PreToolUse primary path

```
Claude Code
  → PreToolUse{ tool_name:"Read", tool_input:{ file_path:"package.json" } }
  → nexus-first.sh  (Read branch)
  → nexus-policy-check (stdin)
  → dispatchPolicy
  → rule iteration: grepOnCode=null, readOnStructured=match
  → {decision:"ask", reason:"Use nexus_structured_query...", rule:"read-on-structured", stale_hint:false}
  → nexus-policy-check (stdout)
  → nexus-first.sh  (emits hookSpecificOutput with permissionDecision:"ask")
  → Claude Code  (shows prompt to user)
```

### Source-file nudge path

```
PreToolUse{ tool_name:"Read", tool_input:{ file_path:"src/foo.ts" } }
  → ... dispatcher ...
  → readOnSource=match
  → {decision:"allow", additional_context:"...", rule:"read-on-source", stale_hint:false}
  → nexus-first.sh emits permissionDecision:"allow" + additionalContext
  → Claude Code injects additionalContext into the next assistant turn
```

### MCP fallback path (Codex / no-hook)

```
Agent → nexus_policy_check({event:{...}})
  → executePolicyCheck → dispatchPolicy → same rules → same response
  → NexusResult<PolicyResponse> via MCP
Agent sees decision + reason + additional_context + stale_hint in one call.
```

### Fall-through example — paged source read

```
Read{file_path:"src/foo.ts", offset:0, limit:100}
  → grepOnCode=null, readOnStructured=null (not structured),
    readOnSource=null (offset present)
  → dispatcher default: {decision:"allow", stale_hint:...}
  → no additional_context, no prompt
```

## Error Handling

- Missing `file_path` → rule returns `null`.
- Non-string `file_path` → rule returns `null`.
- `classifyPath()` throws → caught, rule returns `null`.
- Policy bin crashes / empty stdout → existing `nexus-first.sh` fallback
  (`[ -z "$DECISION" ] && exit 0`) still applies.
- DB missing / stale → handled by existing `stale_hint` computation; rules
  never read the DB.
- `additional_context` present on `deny`/`noop` → dispatcher drops it.
- Unknown future `FileKind` → `read-on-structured` switch's default returns
  `null` (forward-compat).

**Invariant:** no policy failure ever blocks a `Read`. Worst case is silent
allow.

## Testing

### Unit — `tests/policy-rules-read-structured.test.ts` (new)

- Each structured kind produces `ask` with reason mentioning the correct
  suggested tool. Matrix: `package_json`, `tsconfig_json`, `cargo_toml`,
  `gha_workflow`, `package_lock`, `yarn_lock`, `pnpm_lock`, `cargo_lock`,
  `json_generic`, `yaml_generic`, `toml_generic`.
- Lockfile reasons mention `nexus_lockfile_deps`; other kinds mention
  `nexus_structured_query` / `nexus_structured_outline`.
- Non-`Read` tool → `null`.
- Missing `file_path` → `null`.
- Non-string `file_path` → `null`.
- Source-kind file (e.g. `src/foo.ts`) → `null`.

### Unit — `tests/policy-rules-read-source.test.ts` (new)

- `Read{file_path:"src/foo.ts"}` → `allow` + `additional_context` mentions
  `nexus_outline` and `nexus_source`.
- `Read{file_path:"src/foo.ts", offset:0}` → `null`.
- `Read{file_path:"src/foo.ts", limit:100}` → `null`.
- `Read{file_path:"node_modules/react/index.ts"}` → `null`.
- `Read{file_path:"docs/readme.md"}` → `null` (not source-kind).
- `Read{file_path:"package.json"}` → `null` (structured-kind, not source).
- Non-`Read` tool → `null`.

### Unit — `tests/policy-types.test.ts` (extend)

- Assert `additional_context?: string` compiles on both `PolicyDecision` and
  `PolicyResponse`. Type-only smoke test following the existing pattern.

### Integration — `tests/policy-dispatcher.test.ts` (extend)

- With all three rules registered:
  - `Grep{...}` → still routes to `grepOnCode`.
  - `Read{file_path:"package.json"}` → `decision:"ask"`, `rule:"read-on-structured"`.
  - `Read{file_path:"src/foo.ts"}` → `decision:"allow"`, `rule:"read-on-source"`,
    `additional_context` truthy.
  - `Read{file_path:"src/foo.ts", offset:0}` → default `allow`, no
    `additional_context`, no `rule`.

### End-to-end — `tests/policy-entry.test.ts` (extend)

- Spawn compiled `dist/transports/policy-entry.js` with `Read(package.json)`
  JSON; assert stdout parses with `decision:"ask"` and `reason` contains
  `nexus_structured_query`.
- Spawn with `Read(src/x.ts)`; assert `decision:"allow"` and
  `additional_context` contains `nexus_outline`.

### MCP — `tests/mcp.test.ts` (extend)

- Call `nexus_policy_check` with `event: {tool_name:"Read", tool_input:{file_path:"package.json"}}`;
  assert `payload.results[0].decision === "ask"`.
- Call with `Read` on a source file; assert `decision === "allow"` and
  `additional_context` present.

### Manual smoke (documented in plan)

- `echo '{"tool_name":"Read","tool_input":{"file_path":"package.json"}}' | bash hooks/nexus-first.sh`
  → stdout JSON with `permissionDecision:"ask"`.
- `echo '{"tool_name":"Read","tool_input":{"file_path":"src/index.ts"}}' | bash hooks/nexus-first.sh`
  → stdout JSON with `permissionDecision:"allow"` and non-empty
  `additionalContext`.

## File Impact

| File | Action |
|---|---|
| `src/policy/rules/common-paths.ts` | Create |
| `src/policy/rules/read-on-structured.ts` | Create |
| `src/policy/rules/read-on-source.ts` | Create |
| `src/policy/rules/grep-on-code.ts` | Modify — import from `common-paths.ts` |
| `src/policy/types.ts` | Modify — add `additional_context?` |
| `src/policy/dispatcher.ts` | Modify — forward `additional_context` |
| `src/policy/index.ts` | Modify — register both rules in `DEFAULT_RULES`; re-export |
| `src/index.ts` | Modify — re-export new rules (symmetric with `grepOnCodeRule`) |
| `hooks/nexus-first.sh` | Modify — add `Read` branch, update header |
| `tests/policy-rules-read-structured.test.ts` | Create |
| `tests/policy-rules-read-source.test.ts` | Create |
| `tests/policy-rules-grep.test.ts` | Modify — verify still-passing after regex extraction |
| `tests/policy-types.test.ts` | Modify — assert new optional field |
| `tests/policy-dispatcher.test.ts` | Modify — three-rule integration |
| `tests/policy-entry.test.ts` | Modify — add Read cases |
| `tests/mcp.test.ts` | Modify — add Read cases for `nexus_policy_check` |
| `CHANGELOG.md` | Modify — new `[Unreleased]` section |
| `CLAUDE.md` | Modify — document the new rules under the policy transport section |
| V3 roadmap (`C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md`) | Modify — mark A5/C2 shipped |

## Metrics (V3 gate inputs)

Per the roadmap metrics gate, this spec contributes:

- **Override rate** — `ask` denials overridden by user; surfaced via hook
  logs. Out-of-scope for this spec's implementation; tracked by downstream
  telemetry when D5 ships.
- **Added latency** — inherits from the existing policy-latency benchmark.
  No new benchmark needed.
- **FP rate** — proxied by override rate plus observed cases of users
  reading structured files for reasons the rule shouldn't have redirected
  (e.g., reading `package.json` to copy a raw dependency name). Logged
  qualitatively during V3 dogfooding.

This spec intentionally ships no new instrumentation; D5 is the telemetry
spec and it is a V4 candidate.

## Compatibility

- **Claude Code:** primary target. `permissionDecision: ask` and
  `additionalContext` are both supported.
- **Codex:** partial hook support. The MCP `nexus_policy_check` tool is the
  fallback — agents on Codex call it explicitly as documented in CLAUDE.md.
- **macOS / Linux:** unchanged.
- **Windows / Git Bash:** unchanged (same bash dispatcher, same bin).

## Open Questions (deferred to implementation or later)

- Whether `read-on-source` should eventually DB-gate on "file is actually
  indexed" (vs. trusting `classifyPath()` + `stale_hint`). Decision for V3:
  no DB access. Revisit if override rate on freshly-created source files
  exceeds 10%.
- Whether `additional_context` deserves a compact-mode key. Decision: no,
  until payload-size telemetry says it matters.
- Whether to add a rule-disable mechanism (`NEXUS_POLICY_DISABLED_RULES=read-on-source`).
  Decision: deferred to D5 telemetry work.
