# C1 — Pre-Edit Impact Preview (Warning-First) Design

**Status:** Design complete. Next: implementation plan.
**Spec reference:** V3 roadmap — C1 under "Tier 1 — V3 Specs".
**Depends on (all shipped):** Policy Transport, A1 `classifyPath()`, A2 document cache, A5/C2 read-redirect (established rule pattern + hook dispatch).
**Unblocks:** D3 v1 evidence summary (can reuse importer/caller aggregation).

---

## Goal

When Claude is about to `Edit` or `Write` a file that exports symbols other
code imports, surface a short impact summary via `permissionDecision: allow`
+ `additionalContext`. Never blocks. The payload contains the symbol name,
exporter status, importer count, caller count (bucketed as `low|medium|high`),
and `stale_hint`.

Two trigger cases:

1. `Edit` where the edit's enclosing range maps to a **top-level exported
   symbol** in an **indexed source file** with **≥1 known importer**.
2. `Write` on an **existing** indexed source file with **≥1 known importer**
   (treat every top-level export as affected; summarize by top-N callers
   and max risk bucket).

## Non-Goals

- No hard deny. Ever.
- No trigger on new-file Writes (no importers yet by definition).
- No trigger on non-source edits (structured configs are covered by A5/C2).
- No trigger on private helpers or nested symbols (narrow by design).
- No re-export-chain traversal for symbol resolution (V4 — B2 relation edges).
- No rename-specific logic (V4 — B6 rename safety composes B1 + scope).
- No override-rate telemetry in this spec (V4 — D5).
- No new MCP tool. Reuses `nexus_policy_check`.

## Architecture

One new `PolicyRule` (`preedit-impact`) registered in the existing
`DEFAULT_RULES`. Unlike the A5/C2 rules, it needs DB access for `importers`,
`outline`, and `callers`. The policy layer therefore grows a small
abstraction:

- `PolicyContext` gains an optional `queryEngine?: QueryEngineLike` field.
- `QueryEngineLike` is a minimal interface exposing only the methods this
  rule uses. Lets us stub the engine for unit tests without a real DB.
- `src/transports/policy-entry.ts` opens a readonly DB + constructs a
  `QueryEngine` at bin startup. If construction fails (DB missing, corrupt,
  locked), `queryEngine` stays `undefined` and rules that need it fall open.
- `src/transports/mcp.ts` `executePolicyCheck` passes the already-existing
  server-side QueryEngine through the same channel. `ensureFresh()` is still
  bypassed per the `nexus_policy_check` contract — the engine operates on
  whatever is currently indexed, and `stale_hint` advertises the lag.

Pure logic (symbol lookup, risk bucketing, summary string formatting)
lives in `src/policy/impact.ts` so it's unit-testable without any DB or
filesystem.

The bash dispatcher (`hooks/nexus-first.sh`) gains `Edit` and `Write`
branches that mirror the existing Read branch — pipe stdin to
`nexus-policy-check`, parse `.decision` + `.additional_context`, emit
`hookSpecificOutput` with `permissionDecision: "allow"` + `additionalContext`
when set, silent allow otherwise. Matcher updates to
`"Grep|Glob|Agent|Read|Edit|Write"`.

## Components

### 1. `src/policy/types.ts` (modify)

Add `QueryEngineLike` interface and extend `PolicyContext`:

```ts
export interface QueryEngineLike {
  importers(source: string): {
    results: { file: string }[];
    count: number;
  };
  outline(filePath: string): {
    results: OutlineForImpact[];
  };
  /**
   * Returns one result per distinct caller. The rule uses `count`
   * (total distinct callers) for bucketing, not the per-caller
   * `caller_count` field inside each result (which is #call-sites).
   */
  callers(name: string, opts?: { file?: string; limit?: number }): {
    results: unknown[];
    count: number;
  };
}

export interface OutlineForImpact {
  file: string;
  exports: string[];
  outline: OutlineEntryForImpact[];
}

export interface OutlineEntryForImpact {
  name: string;
  kind: string;
  line: number;
  end_line: number;
  children?: OutlineEntryForImpact[];
}

export interface PolicyContext {
  rootDir: string;
  dbPath: string;
  queryEngine?: QueryEngineLike;   // NEW
}
```

Only methods the rule uses are declared. Adding a method to the real
`QueryEngine` does not force a type update here — we intentionally narrow
the surface.

### 2. `src/policy/impact.ts` (create)

Pure, DB-free helpers:

```ts
export interface SymbolMatch {
  name: string;
  topLevel: boolean;
  exported: boolean;
  line: number;
  end_line: number;
}

export type RiskBucket = 'low' | 'medium' | 'high';

export function findSymbolAtEdit(
  fileContent: string,
  oldString: string,
  outline: OutlineForImpact,
): SymbolMatch | null;

export function bucketRisk(callerCount: number): RiskBucket;

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
  risk: RiskBucket;     // max over affectedSymbols
}

export function summarizeEditImpact(impact: EditImpact): string;
export function summarizeWriteImpact(impact: WriteImpact): string;
```

**`findSymbolAtEdit` algorithm:**
1. `index = fileContent.indexOf(oldString)`. If `-1` → `null`.
2. `line = fileContent.slice(0, index).split('\n').length` (1-based).
3. Walk `outline.outline` top-level entries. Pick the entry whose
   `[line, end_line]` contains the edit line. If none, `null`.
4. `exported = outline.exports.includes(entry.name)`.
5. `topLevel = true` if the entry is at the top level (it is, since we
   walk only the top-level array). Nested entries are not considered.
   A nested match falling inside a top-level entry still reports the
   top-level entry, with `topLevel: true`. This is by design — we warn
   about the export surface, not the inner helper.
6. Return `{ name, topLevel, exported, line, end_line }`.

**`bucketRisk` thresholds:**
- `0 ≤ n ≤ 2` → `low`
- `3 ≤ n ≤ 10` → `medium`
- `n ≥ 11` → `high`

**Summary format (Edit):**
```
⚠️ Editing exported symbol `<name>` in `<file>` (risk: <bucket>).
<importerCount> file(s) import this module<importerExamples>;
<callerCount> caller(s) found<callerBreakdown>.
Run nexus_callers('<name>') for the full list.
```

- `<importerExamples>`: empty if 0, `: <list of up to 3>, +N more` if >3.
- `<callerBreakdown>`: empty for Edit (single-symbol case).
- Total length hard-capped at 600 chars.

**Summary format (Write):**
```
⚠️ Rewriting <file> replaces <N> exported symbol(s) (max risk: <bucket>).
Top by callers: <symbolName (N callers)>, ... (up to 3).
<importerCount> importer(s). Run nexus_callers for any symbol to see
full call sites.
```

### 3. `src/policy/rules/preedit-impact.ts` (create)

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PolicyRule } from '../types.js';
import { classifyPath } from '../../workspace/classify.js';
import {
  findSymbolAtEdit,
  bucketRisk,
  summarizeEditImpact,
  summarizeWriteImpact,
  type EditImpact,
  type WriteImpact,
} from '../impact.js';

const EMPTY_CONFIG = { languages: {} };
const MAX_FILE_BYTES = 2 * 1024 * 1024;   // 2 MB cap on hot-path reads

export const preeditImpactRule: PolicyRule = {
  name: 'preedit-impact',
  evaluate(event, ctx) {
    if (event.tool_name !== 'Edit' && event.tool_name !== 'Write') return null;
    if (!ctx.queryEngine) return null;

    const raw = event.tool_input.file_path;
    if (typeof raw !== 'string' || raw.length === 0) return null;

    const { relPath } = relativize(raw, ctx.rootDir);
    const basename = path.posix.basename(relPath);
    let kind;
    try {
      kind = classifyPath(relPath, basename, EMPTY_CONFIG);
    } catch {
      return null;
    }
    if (kind.kind !== 'source') return null;

    if (event.tool_name === 'Edit') {
      return evaluateEdit(event, ctx, relPath, raw);
    }
    return evaluateWrite(event, ctx, relPath, raw);
  },
};
```

Two helper functions below the rule definition. `relativize` reuses the
idiom established in A5/C2 (`path.posix.isAbsolute` → `resolve` → `relative`
with `..` fallback).

**`evaluateEdit`:**
1. Read `tool_input.old_string` — non-string → `null`.
2. Read file via `fs.statSync` + `fs.readFileSync` (UTF-8, capped at
   `MAX_FILE_BYTES`). Over-cap or ENOENT/EACCES → `null`.
3. `ctx.queryEngine.importers(relPath)` — `count === 0` → `null`.
4. `ctx.queryEngine.outline(relPath)` — missing or throws → `null`.
5. `findSymbolAtEdit(content, old_string, outline.results[0])`. If
   `null` OR `!exported` OR `!topLevel` → `null`.
6. `ctx.queryEngine.callers(match.name, { file: relPath, limit: 50 })`
   — `callerCount = result.count`. Partial failure (throws) → `callerCount = 0`.
7. Build `EditImpact`. Return `{ decision: 'allow', rule: 'preedit-impact',
   additional_context: summarizeEditImpact(impact) }`.

**`evaluateWrite`:**
1. `fs.statSync(absPath)` — ENOENT → `null` (new file).
2. `ctx.queryEngine.importers(relPath)` — `count === 0` → `null`.
3. `ctx.queryEngine.outline(relPath)` — missing or throws → `null`.
4. Filter `outline.outline` top-level entries to those in `outline.exports`.
   If list is empty → `null`.
5. For each exported top-level name, call `callers(name, {file})` and
   read `result.count` for the caller count. Aggregate.
6. Build `WriteImpact`. Return `{ decision: 'allow', rule: 'preedit-impact',
   additional_context: summarizeWriteImpact(impact) }`.

### 4. `src/policy/dispatcher.ts` (modify)

Extend `DispatchOptions`:

```ts
export interface DispatchOptions {
  rootDir: string;
  rules: readonly PolicyRule[];
  queryEngine?: QueryEngineLike;
}
```

Forward to `ctx`:

```ts
const ctx: PolicyContext = {
  rootDir: opts.rootDir,
  dbPath: path.join(opts.rootDir, '.nexus', 'index.db'),
  ...(opts.queryEngine ? { queryEngine: opts.queryEngine } : {}),
};
```

No other behavior changes. The default-allow fallthrough is unchanged.

### 5. `src/policy/index.ts` (modify)

Export `preeditImpactRule`. Append to `DEFAULT_RULES`:

```ts
export const DEFAULT_RULES: readonly PolicyRule[] = [
  grepOnCodeRule,
  readOnStructuredRule,
  readOnSourceRule,
  preeditImpactRule,
];
```

### 6. `src/transports/policy-entry.ts` (modify)

After resolving `rootDir`, attempt to open a readonly DB + construct a
`QueryEngine`. On any error, log nothing and continue without an engine:

```ts
let queryEngine: QueryEngineLike | undefined;
try {
  const dbPath = path.join(rootDir, '.nexus', 'index.db');
  if (fs.existsSync(dbPath)) {
    const db = openDatabase(dbPath, { readonly: true });
    queryEngine = new QueryEngine(db);
  }
} catch {
  queryEngine = undefined;
}

const response = dispatchPolicy(event, {
  rootDir,
  rules: DEFAULT_RULES,
  ...(queryEngine ? { queryEngine } : {}),
});
```

Process exits after writing stdout — no need to close the DB; OS cleans up.

### 7. `src/transports/mcp.ts` (modify)

`executePolicyCheck` already has the server-side QueryEngine available via
`getEngine()`. Pass it through:

```ts
function executePolicyCheck(args: Record<string, unknown>): NexusResult<unknown> {
  // ... existing validation ...
  const response = dispatchPolicy(typedEvent, {
    rootDir,
    rules: DEFAULT_RULES,
    queryEngine: getEngine(),    // NEW
  });
  // ... existing wrapping ...
}
```

`ensureFresh()` is still bypassed upstream for `nexus_policy_check` —
unchanged contract.

### 8. `hooks/nexus-first.sh` (modify)

Add `Edit` and `Write` branches. Both are identical in shape to the
existing Read branch's `allow + additionalContext` path (neither emits
`ask`; neither emits `deny`):

```bash
# ── Edit / Write: delegate to nexus-policy-check ─────────────────────
if [ "$TOOL_NAME" = "Edit" ] || [ "$TOOL_NAME" = "Write" ]; then
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

Header block updates: describe the Edit/Write redirect, update the install
matcher to `"Grep|Glob|Agent|Read|Edit|Write"`.

## Data Flow

### Edit path — happy case

```
PreToolUse{Edit, file_path:/repo/src/bar.ts, old_string:"export function foo…"}
  → nexus-first.sh Edit branch
  → nexus-policy-check (bin constructs QueryEngine on startup)
  → preeditImpactRule:
      classifyPath → source(ts) ✓
      fs.readFileSync(file) ✓
      queryEngine.importers('src/bar.ts') → 2 ✓
      queryEngine.outline('src/bar.ts') → entries
      findSymbolAtEdit → { name:'foo', topLevel:true, exported:true }
      queryEngine.callers('foo', {file:'src/bar.ts'}) → 6
      bucketRisk(6) → 'medium'
      summarizeEditImpact → "⚠️ Editing exported symbol `foo` …"
  → PolicyResponse{allow, rule:'preedit-impact', additional_context:<summary>}
  → nexus-first.sh emits hookSpecificOutput{allow, additionalContext:<summary>}
  → Claude Code injects into next assistant turn
```

### Edit path — skip cases (all return `null`)

- `ctx.queryEngine` missing (DB unavailable).
- Not a source kind.
- File unreadable or over 2 MB cap.
- `importers.count === 0`.
- `old_string` not found in file.
- Matched line not in any top-level symbol range.
- Symbol private (not in `outline.exports`).

### Write path — happy case

```
PreToolUse{Write, file_path:/repo/src/bar.ts, content:…}
  → preeditImpactRule:
      classifyPath → source ✓
      fs.statSync exists ✓ (new file → null)
      importers → 2 ✓
      outline → top-level exports [foo, bar, baz]
      for each export: callers() → [6, 2, 14]
      bucketRisk(max) = bucketRisk(14) = 'high'
      summarizeWriteImpact → "⚠️ Rewriting src/bar.ts replaces 3 exported symbols (max risk: high). Top: `baz` (14 callers), …"
  → allow + additional_context
```

### MCP fallback path

`nexus_policy_check({event})` → `executePolicyCheck` passes server-side
`QueryEngine` via `DispatchOptions` → same rule evaluates → response
carries the full structured `additional_context` + `stale_hint`.

## Error Handling

- `ctx.queryEngine` missing → `null` (silent allow).
- `file_path` missing or non-string → `null`.
- File unreadable (ENOENT, EACCES, over cap) → `null`.
- `old_string` absent from file → `null`.
- `old_string` has multiple occurrences → match the first one (Edit tool
  would reject non-unique upstream; we're defensive).
- `findSymbolAtEdit` returns `null` → `null`.
- Matched symbol not exported or not top-level → `null`.
- `queryEngine.importers/outline` throws → `null` for the call, rule skips.
- `queryEngine.callers` throws for one symbol (Write path) → treat as 0
  callers for that symbol; still emit summary.
- `additional_context` string capped at 600 chars. Over → truncate with
  `+N more` suffix on lists.

**Invariant:** no failure ever blocks `Edit` or `Write`. Worst case is
silent allow.

## Testing

### Unit — `tests/policy-impact.test.ts` (new, DB-free)

- `findSymbolAtEdit` happy path (edit inside a top-level exported function).
- `old_string` absent → `null`.
- Multiple occurrences → first match.
- Edit line outside any top-level entry → `null`.
- Match inside nested function — returns outer top-level entry (policy choice).
- Non-exported match (name not in `outline.exports`) → `{ exported: false }`.
- `bucketRisk` boundaries: 0, 2, 3, 10, 11, 50.
- `summarizeEditImpact`: mentions symbol, file, bucket, importer count,
  caller count, `nexus_callers` hint. Length ≤ 600.
- `summarizeEditImpact`: >3 importers → `+N more` suffix.
- `summarizeWriteImpact`: multi-symbol listing, max-bucket risk.

### Unit — `tests/policy-rules-preedit-impact.test.ts` (new)

Uses a hand-rolled `QueryEngineLike` stub (no real DB) plus `fs` temp files.

- Edit on indexed source + exported top-level symbol + importers + callers
  → `allow` + summary mentions symbol + `nexus_outline` or `nexus_callers`.
- Edit on file with 0 importers → `null`.
- Edit on private helper → `null`.
- Edit on nested symbol → `null` (nested match rejected).
- Edit with `old_string` absent → `null`.
- Edit on `package.json` (structured kind) → `null`.
- Edit when `ctx.queryEngine` undefined → `null`.
- Edit on file over 2 MB cap → `null`.
- Write on new file (not on disk) → `null`.
- Write on existing indexed source with importers + multi-export
  → `allow` + summary lists top symbols.
- Write on existing file with 0 importers → `null`.
- Non-Edit/non-Write tool → `null`.

### Integration — `tests/policy-dispatcher.test.ts` (extend)

- `DispatchOptions.queryEngine` forwarded into `ctx` (verified via a stub
  rule that captures `ctx`).
- `DEFAULT_RULES` + stub engine: Edit on an exported indexed symbol routes
  to `preedit-impact`.

### Unit — `tests/policy-types.test.ts` (extend)

- `PolicyContext.queryEngine?: QueryEngineLike` compiles.
- `QueryEngineLike` shape compiles with the expected method signatures.

### End-to-end — `tests/policy-entry.test.ts` (extend)

- With a real `.nexus/index.db` seeded with a tiny fixture (one source file
  + one importer + one caller): spawn bin, pipe Edit event, assert stdout
  `decision: 'allow'` + `additional_context` populated.
- Without `.nexus/index.db`: Edit event → silent `allow` (rule falls open).

### MCP — `tests/mcp.test.ts` (extend)

- `nexus_policy_check` with an Edit event against a seeded fixture returns
  `results[0].decision === 'allow'` + `additional_context` non-empty.

### Manual smoke — plan verification

Pipe through `bash hooks/nexus-first.sh`:
- Edit on indexed source with importers → `permissionDecision: "allow"` +
  `additionalContext` with summary.
- Edit on file with no importers → empty stdout.
- Write on non-existent file → empty stdout.

## File Impact

| File | Action |
|---|---|
| `src/policy/types.ts` | Modify — add `QueryEngineLike`, `OutlineForImpact`, extend `PolicyContext`. |
| `src/policy/impact.ts` | Create — pure helpers. |
| `src/policy/rules/preedit-impact.ts` | Create — the rule. |
| `src/policy/dispatcher.ts` | Modify — forward `queryEngine` through `ctx`. |
| `src/policy/index.ts` | Modify — export + register in `DEFAULT_RULES`. |
| `src/transports/policy-entry.ts` | Modify — construct readonly QueryEngine at startup. |
| `src/transports/mcp.ts` | Modify — pass `getEngine()` to `dispatchPolicy`. |
| `hooks/nexus-first.sh` | Modify — add Edit and Write branches. |
| `tests/policy-impact.test.ts` | Create — pure-helper tests. |
| `tests/policy-rules-preedit-impact.test.ts` | Create — rule tests with stub engine. |
| `tests/policy-dispatcher.test.ts` | Modify — `queryEngine` forwarding + DEFAULT_RULES integration. |
| `tests/policy-types.test.ts` | Modify — compile-check new interfaces. |
| `tests/policy-entry.test.ts` | Modify — real-DB E2E Edit case + no-DB fall-open. |
| `tests/mcp.test.ts` | Modify — Edit case for `nexus_policy_check`. |
| `CHANGELOG.md` | Modify — new `[Unreleased]` entry. |
| `CLAUDE.md` | Modify — extend policy transport section with the new rule. |
| `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md` | Modify — mark C1 shipped. |

## Metrics (V3 gate inputs)

- **Override rate** — not directly measurable in this spec because the rule
  emits `allow` (not `ask`). Future D5 telemetry can count `additional_context`
  injections and correlate with subsequent agent behavior.
- **Added latency** — new file read + 2-3 SQL queries per flagged Edit.
  Inherits the existing policy-latency benchmark; non-blocking CI gate.
- **FP rate** — proxied by qualitative dogfooding during V3. If summaries
  trigger on low-value edits (e.g., renaming a top-level const with 1 caller),
  revisit the bucket thresholds.

## Compatibility

- **Claude Code:** primary target. `permissionDecision: allow` +
  `additionalContext` supported.
- **Codex:** hook support partial. Fallback is the MCP `nexus_policy_check`
  tool; agents can poll it explicitly before Edit/Write.
- **macOS / Linux / Windows (Git Bash):** unchanged bash dispatcher + bin.

## Open Questions (deferred)

- Whether to auto-expand the rule to `MultiEdit` when that tool ships.
  Decision: defer until MultiEdit is in use; the current rule logic
  composes naturally over multiple `old_string`s.
- Whether to include `ref_kinds` filtering when counting callers (B1
  integration). Decision: out of scope for V3 — V3 ships default caller
  semantics.
- Whether to cache file reads in the A2 document cache. Decision: no —
  the A2 cache is keyed on `(path, mtime, size)` and designed for parsed
  documents. Raw source reads for this rule are rare and cheap enough to
  skip the cache. Revisit only if latency telemetry demands it.
