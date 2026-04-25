# D5 v1 — Telemetry — Design

**Status:** Approved 2026-04-25
**Tier:** V4 (post-V3 metrics gate)
**Predecessors:** B1 (ref_kind), A1–A5 (classify/structured), C1 (preedit-impact),
A5-C2 (read-redirect), D3 (evidence-summary). All shipped.
**Closes:** "D5 telemetry — `.nexus/telemetry.db`, gated on retention/opt-out
design" — V3 roadmap (`sourcegraph-closest-analog-sharded-seahorse.md:255`).

---

## Goal

Record per-policy-event signals so V4 can evaluate the metrics gate (FP rate,
latency, override rate, "turn it off" signal — V3 roadmap §"Metrics Gate"). V3
ships warnings; V4 promotes any warning to a hard-block only when override-rate
< 10% and false-positive-rate < 5%. Without telemetry there is no data to
evaluate; without that data, no warning is promoted.

D5 v1 covers four of the five metrics-gate signals:

- **Latency per event** — already measured in `dispatchPolicy`, just persisted.
- **Decision counts** by rule × decision kind.
- **Override rate** — for `ask` decisions, did the user proceed anyway?
- **Opt-out signal** — record the enabled→disabled transition itself.

Out of scope (separate specs):

- **False-positive rate** — needs an explicit dismiss UX. No mechanism exists.
- **Token savings** — needs counterfactual model + `pack`-side instrumentation.

## Non-Goals

- No MCP tool. CLI is sufficient for the periodic, human-driven V3→V4 gate
  review. If V4's D1/D2/D4 work needs programmatic access, a thin MCP wrapper
  over the same store is ~30 lines of follow-up.
- No remote upload, no network I/O of any kind. All data stays in
  `.nexus/telemetry.db`.
- No FP detection. Future work.
- No token-savings estimator. Future work.
- No real-time aggregation views. Append-only events; aggregates computed at
  read-time. If query latency becomes an issue (it won't — telemetry reads are
  not on the hot path), add views later.

## Architecture

```
nexus-policy-check (PreToolUse / PostToolUse)
  └─ dispatchPolicy() → { decision, rule, reason?, additional_context? }
       └─ recordEvent({rule, decision, latency_us, ...})  ← NEW (best-effort)
            └─ src/policy/telemetry.ts  ← NEW
                 ├─ lazy-init .nexus/telemetry.db (separate from index.db)
                 ├─ pruneIfDue() once per process
                 └─ INSERT into events
```

**Telemetry DB is separate from the index DB.** Reasoning:

- **Different lifecycle.** Index DB is rebuilt on `SCHEMA_VERSION` /
  `EXTRACTOR_VERSION` bumps (schema.ts:8-9). Telemetry data must survive every
  rebuild — that's the whole point of cross-session retention.
- **Different retention.** Index reflects current source state. Telemetry is
  historical, time-bounded.
- **Different access pattern.** Index is read-heavy on the hot path. Telemetry
  is write-heavy on the hot path; reads are infrequent (CLI only).
- **Failure isolation.** A corrupt telemetry.db should never compromise
  indexing or query behavior, and vice versa.

## Components

### `src/policy/telemetry.ts` (NEW)

Single file, pure node + better-sqlite3. ~250 lines.

```typescript
export interface TelemetryEvent {
  ts_ms: number;
  session_id: string | null;
  hook_event: 'PreToolUse' | 'PostToolUse' | 'opt_out' | 'opt_in';
  tool_name: string | null;
  rule: string | null;
  decision: 'allow' | 'ask' | 'deny' | 'noop' | null;
  latency_us: number | null;
  input_hash: string | null;       // 16-char SHA256 prefix
  file_path: string | null;
  payload_json: string | null;     // reserved; null in v1
}

export function openTelemetryDb(rootDir: string): Database.Database | null;
export function recordEvent(db: Database.Database | null, ev: TelemetryEvent): void;
export function pruneIfDue(db: Database.Database, now?: number): { pruned: number };
export function recordOptOutTransition(rootDir: string, currentlyEnabled: boolean): void;
export function closeTelemetryDb(db: Database.Database): void;
```

Behavioral contract:

- `openTelemetryDb` is **lazy and safe**. Returns `null` if telemetry is
  disabled, the `.nexus` directory cannot be created, or the file cannot be
  opened. Never throws.
- `recordEvent(null, ev)` is a no-op. Lets callers stay simple: no `if (db)`
  guards at every call site.
- `recordEvent` swallows all DB errors. Telemetry must never block policy.
- `pruneIfDue` is idempotent and gated on `meta.last_prune_ts`: returns
  `{ pruned: 0 }` if last prune was less than 24h ago.
- `recordOptOutTransition` opens the DB just long enough to read
  `meta.last_enabled_state`, write a transition row if needed, and update
  `last_enabled_state`. Closes the DB before returning.

### `src/policy/telemetry-config.ts` (NEW)

```typescript
export function isTelemetryEnabled(rootDir: string): boolean;
```

Resolution order (env trumps config):

1. `process.env.NEXUS_TELEMETRY` set to `'0'` or `'false'` → disabled.
2. `process.env.NEXUS_TELEMETRY` set to `'1'` or `'true'` → enabled (overrides config opt-out).
3. `.nexus.json` has `{ "telemetry": false }` → disabled.
4. Default → enabled.

This matches the V3 design line (line 53 of roadmap): "explicit 'turn it off'
signal" — the env var is the explicit override, the config flag is the
discoverable opt-out, and we always default to on so the metrics gate has data.

### `src/policy/dispatcher.ts` (MODIFIED)

Add per-rule timing and `recordEvent` call. Existing `dispatchPolicy(event,
ctx)` signature unchanged from C1. New behavior:

```typescript
export function dispatchPolicy(event: PolicyEvent, ctx: PolicyContext): PolicyDecision {
  const db = ctx.telemetryDb ?? null;
  for (const rule of DEFAULT_RULES) {
    const t0 = process.hrtime.bigint();
    let result: PolicyDecision | null = null;
    try {
      result = rule.evaluate(event, ctx);
    } catch {
      result = null;
    }
    const latency_us = Number((process.hrtime.bigint() - t0) / 1000n);
    if (result !== null) {
      recordEvent(db, {
        ts_ms: Date.now(),
        session_id: event.session_id ?? null,
        hook_event: event.hook_event_name,
        tool_name: event.tool_name,
        rule: rule.name,
        decision: result.decision,
        latency_us,
        input_hash: ctx.inputHash ?? null,
        file_path: extractFilePath(event),
        payload_json: null,
      });
      return result;
    }
    // Rules that returned null don't get a row in v1 (would inflate writes ~5x).
  }
  // No rule fired across the entire evaluation: record one noop row keyed on
  // (session_id, input_hash) so the override-rate join can detect the action.
  recordEvent(db, {
    ts_ms: Date.now(),
    session_id: event.session_id ?? null,
    hook_event: event.hook_event_name,
    tool_name: event.tool_name,
    rule: null,
    decision: 'noop',
    latency_us: 0,
    input_hash: ctx.inputHash ?? null,
    file_path: extractFilePath(event),
    payload_json: null,
  });
  return { decision: 'noop', rule: null };
}
```

**Why we record `noop` rows.** Override correlation joins PreToolUse `ask`
rows to *any* PostToolUse row with matching `(session_id, input_hash)`. If a
PostToolUse event has no firing rule (common — no rule cares about
PostToolUse on Read), we still need that row in the table for the join to
detect "the action proceeded." Without it, override rate would always read 0%.

### `src/transports/policy-entry.ts` (MODIFIED)

Two new responsibilities at process start:

```typescript
const enabled = isTelemetryEnabled(rootDir);
recordOptOutTransition(rootDir, enabled);   // detects flip vs last run
const telemetryDb = enabled ? openTelemetryDb(rootDir) : null;
if (telemetryDb) pruneIfDue(telemetryDb);

const inputHash = computeInputHash(event.tool_input);
ctx.telemetryDb = telemetryDb;
ctx.inputHash = inputHash;

const decision = dispatchPolicy(event, ctx);
// ... existing response handling ...

if (telemetryDb) closeTelemetryDb(telemetryDb);
```

`computeInputHash`: `crypto.createHash('sha256').update(canonicalJson(event.tool_input)).digest('hex').slice(0, 16)`. Canonical JSON = keys sorted recursively. Stable across runs.

### `src/transports/cli.ts` (MODIFIED)

New subcommand `telemetry` with three actions:

```
nexus telemetry stats [--since=30d|7d|1d] [--json]
  → digest: events count, decisions-by-rule table, p50/p95/p99 latency,
    override rate per rule, opt-out events count.

nexus telemetry export [--since=30d] [--format=ndjson|csv]
  → raw rows to stdout.

nexus telemetry purge [--yes]
  → drops .nexus/telemetry.db. Independent of opt-out (which keeps the file
    so the next opt-in transition can be detected).
```

Default `--since` is 30d. `--json` makes stats machine-readable for V4
gate-evaluation scripts.

### `src/config.ts` (MODIFIED)

Add a `telemetry?: boolean` field to the `.nexus.json` schema. Reused by
`telemetry-config.ts`.

## Data Flow

### Happy path: Edit on indexed source

```
1. PreToolUse Edit({file_path:"src/foo.ts", old_string:..., new_string:...})
2. policy-entry: input_hash = sha256("{file_path:...,new_string:...,old_string:...}")[:16]
3. recordOptOutTransition: no flip
4. openTelemetryDb: lazy create .nexus/telemetry.db with schema; meta row inserted
5. pruneIfDue: first run, sets last_prune_ts, no-op since DB is empty
6. dispatchPolicy: preedit-impact fires → { decision:'allow', additional_context:'...' }
7. recordEvent: INSERT { hook_event:'PreToolUse', rule:'preedit-impact',
   decision:'allow', latency_us:847, input_hash:'a3f9...', ...}
8. Response written. Process exits. DB closes.
```

### Override path

```
1. PreToolUse Read({file_path:"package.json"})
2. read-on-structured fires → { decision:'ask', reason:'use nexus_lockfile_deps...' }
3. recordEvent: INSERT { hook_event:'PreToolUse', rule:'read-on-structured',
   decision:'ask', input_hash:'b1e2...' }
4. Claude Code prompts user. User clicks "approve".
5. Tool executes. PostToolUse Read({file_path:"package.json"}) emitted.
6. policy-entry receives PostToolUse: input_hash = same b1e2...
7. dispatchPolicy: no rule fires for Read PostToolUse. Record noop row.
   INSERT { hook_event:'PostToolUse', rule:NULL, decision:'noop', input_hash:'b1e2...' }
8. Later: `nexus telemetry stats` runs the override join SQL,
   sees pre.decision='ask' matched to a post row → counts as overridden.
```

### Opt-out flip

```
1. User edits .nexus.json to add `"telemetry": false`.
2. Next PreToolUse:
   - isTelemetryEnabled → false
   - recordOptOutTransition: opens DB, reads meta.last_enabled_state='1',
     writes opt_out row, updates last_enabled_state='0', closes DB.
3. openTelemetryDb returns null (because not enabled).
4. dispatchPolicy: telemetry calls are no-ops.
5. Subsequent runs: recordOptOutTransition opens DB, sees last_enabled_state='0',
   no transition, closes immediately.
```

The transition logic deliberately writes the opt-out row even though the
overall enabled state is now false. The "off signal" itself is what V3
committed to recording.

### Re-enable

When the user re-enables (env var unset or config flag flipped back):

- `recordOptOutTransition` sees `last_enabled_state='0'` and current `enabled=true`.
- Writes an `opt_in` row with `ts_ms=now`.
- Updates `last_enabled_state='1'`.

## Schema (`.nexus/telemetry.db`)

```sql
CREATE TABLE meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys: schema_version (int), last_prune_ts (ms), last_enabled_state (0/1)

CREATE TABLE events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  session_id TEXT,
  hook_event TEXT NOT NULL,        -- PreToolUse | PostToolUse | opt_out | opt_in
  tool_name TEXT,
  rule TEXT,                       -- NULL for opt_* and for noop rows
  decision TEXT,                   -- allow | ask | deny | noop; NULL for opt_*
  latency_us INTEGER,              -- microseconds; NULL for opt_*
  input_hash TEXT,                 -- 16 hex chars; NULL for opt_*
  file_path TEXT,
  payload_json TEXT                -- reserved; v1 always NULL
);

CREATE INDEX idx_events_session_hash ON events(session_id, input_hash)
  WHERE session_id IS NOT NULL AND input_hash IS NOT NULL;
CREATE INDEX idx_events_ts ON events(ts_ms);
CREATE INDEX idx_events_rule_decision ON events(rule, decision);
```

`schema_version=1`. PRAGMA settings: WAL, foreign_keys=OFF (no FKs in v1),
synchronous=NORMAL.

### Stat queries

**Decision counts:**
```sql
SELECT rule, decision, COUNT(*) AS n
FROM events
WHERE hook_event='PreToolUse' AND ts_ms > :since AND rule IS NOT NULL
GROUP BY rule, decision
ORDER BY rule, decision;
```

**Latency p50 / p95 / p99 per rule:**
SQLite has no built-in percentile aggregate. We `SELECT latency_us FROM events
WHERE rule=? AND ts_ms > :since ORDER BY latency_us` and compute percentiles
in JS by index. With the 100k row cap and per-rule filtering, the worst-case
per-rule fetch is well under 100k rows — fast enough for an interactive CLI.

**Override rate:**
```sql
SELECT pre.rule,
       COUNT(*) AS asks,
       SUM(CASE WHEN post.id IS NOT NULL THEN 1 ELSE 0 END) AS overridden
FROM events pre
LEFT JOIN events post
  ON post.session_id = pre.session_id
 AND post.input_hash = pre.input_hash
 AND post.hook_event = 'PostToolUse'
 AND post.ts_ms BETWEEN pre.ts_ms AND pre.ts_ms + 300000   -- 5-min window
WHERE pre.hook_event='PreToolUse' AND pre.decision='ask'
  AND pre.ts_ms > :since
GROUP BY pre.rule;
```

5-minute window cap avoids matching a PreToolUse `ask` to an unrelated
PostToolUse hours later in the same session that happens to share an
input_hash (extremely unlikely given the hash, but cheap insurance).

**Opt-out counts:**
```sql
SELECT hook_event, COUNT(*) FROM events
WHERE hook_event IN ('opt_out','opt_in') AND ts_ms > :since
GROUP BY hook_event;
```

## Retention

Two bounds, both enforced on each prune:

- **Time:** drop rows older than 30 days (`ts_ms < now - 30*86400000`).
- **Count:** keep newest 100k rows (`id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 100000)`).

`pruneIfDue` runs at most once per 24 hours, gated by `meta.last_prune_ts`:

```sql
SELECT value FROM meta WHERE key='last_prune_ts';   -- '0' if missing
-- if (now - last_prune_ts) < 24*3600*1000: return {pruned:0}
DELETE FROM events WHERE ts_ms < :cutoff_30d;
DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 100000);
UPDATE meta SET value=:now WHERE key='last_prune_ts';
```

Approximate disk ceiling: 100k rows × ~150 bytes ≈ 15 MB.

## Error Handling

| Failure mode | Behavior |
|---|---|
| Cannot create `.nexus/` dir | `openTelemetryDb` returns null, all recordEvent calls no-op |
| `telemetry.db` corrupt at open | rename to `telemetry.db.corrupt-<ts>`, recreate empty, log nothing (silent) |
| INSERT fails (lock contention, disk full) | swallowed in `recordEvent` try/catch |
| Schema version mismatch | rename + recreate (same as corrupt path) |
| `pruneIfDue` SQL error | swallowed; next run will retry |
| `recordOptOutTransition` fails | swallowed; transition not logged this run |
| `nexus telemetry stats` on missing DB | "Telemetry: not yet recorded" message, exit 0 |
| `nexus telemetry purge` on missing DB | "Already empty", exit 0 |

`recordEvent` wraps every DB operation in `try/catch` internally. Combined
with the dispatcher's per-rule `try/catch` (which already exists), a thrown
exception from telemetry cannot escape into the policy response.

## Testing

In-memory SQLite via `:memory:` for store tests; temp dirs for entry/CLI tests.

### `tests/policy-telemetry-store.test.ts` (~10 cases)

- `openTelemetryDb` creates schema on first call.
- Subsequent opens reuse existing DB (idempotent).
- `recordEvent(null, …)` is a no-op (no throw).
- `recordEvent` inserts a row matching the input shape.
- `recordEvent` swallows DB errors (close DB, then call → no throw).
- `pruneIfDue`: first run sets `last_prune_ts`, subsequent runs within 24h
  return `{pruned:0}`.
- `pruneIfDue`: rows older than 30d are removed.
- `pruneIfDue`: rows beyond 100k are removed by id-DESC ordering.
- Corruption recovery: write garbage to `telemetry.db`, `openTelemetryDb`
  renames + recreates empty.
- Schema version mismatch triggers same recovery path.

### `tests/policy-telemetry-optout.test.ts` (~8 cases)

- env=`0` overrides config=true → disabled.
- env=`1` overrides config=false → enabled.
- env unset, config=`{telemetry:false}` → disabled.
- env unset, no config → enabled (default).
- env unset, malformed config → enabled (config errors fall through).
- transition enabled→disabled writes `opt_out` row.
- transition disabled→enabled writes `opt_in` row.
- no transition: no row written.

### `tests/policy-telemetry-dispatcher.test.ts` (~6 cases)

- Each fired rule writes one event row with correct `latency_us`.
- A non-firing rule does NOT write a row (for that rule).
- `noop` row is written when no rule fires (so override join works).
- Rule that throws → caught, no event row, dispatcher continues.
- `recordEvent` failure does not abort dispatch.
- `latency_us` is non-zero and bounded reasonably (sanity: ≥0, ≤10s).

### `tests/policy-telemetry-entry.test.ts` (~5 cases)

- `computeInputHash` is deterministic for equivalent JSON.
- Different field order in `tool_input` → same hash (canonical sort).
- `pruneIfDue` called once per process invocation.
- `recordOptOutTransition` called before `openTelemetryDb`.
- DB closed at end of process (no leaked handles in test).

### `tests/policy-telemetry-cli.test.ts` (~6 cases)

- `nexus telemetry stats` on empty DB prints "no events".
- `nexus telemetry stats --json` is valid JSON with expected keys.
- `nexus telemetry stats --since=7d` filters correctly.
- `nexus telemetry export --format=ndjson` emits one row per line.
- `nexus telemetry export --format=csv` emits header + rows.
- `nexus telemetry purge --yes` deletes the DB; subsequent `stats` shows empty.

### `tests/policy-telemetry-integration.test.ts` (~5 cases)

- Pre `ask` + matching Post within window → override counted.
- Pre `ask` without Post → not overridden.
- Pre `ask` + Post outside 5-min window → not overridden.
- Pre `ask` from session A, Post with same hash from session B → not overridden.
- Multiple `ask`s in session, all matched → override rate = 100%.

Total: ~40 new test cases across 6 files. Existing test count after D3 = 770;
target post-D5 ≈ 810.

## File Impact

NEW source (2):
- `src/policy/telemetry.ts` (~250 lines)
- `src/policy/telemetry-config.ts` (~40 lines)

NEW tests (6):
- `tests/policy-telemetry-store.test.ts`
- `tests/policy-telemetry-optout.test.ts`
- `tests/policy-telemetry-dispatcher.test.ts`
- `tests/policy-telemetry-entry.test.ts`
- `tests/policy-telemetry-cli.test.ts`
- `tests/policy-telemetry-integration.test.ts`

NEW docs (1):
- `docs/superpowers/specs/2026-04-25-d5-telemetry-design.md` (this doc)

MODIFIED:
- `src/policy/types.ts` — add `telemetryDb?` and `inputHash?` to `PolicyContext`
- `src/policy/dispatcher.ts` — timer + recordEvent + noop-row emission
- `src/policy/index.ts` — export new modules
- `src/transports/policy-entry.ts` — open/prune/transition/hash/close at boundaries
- `src/transports/cli.ts` — `telemetry` subcommand with stats/export/purge
- `src/config.ts` — read optional `telemetry: boolean` field
- `CHANGELOG.md` — D5 v1 entry
- `CLAUDE.md` — note telemetry on/off + CLI surface
- `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md` —
  mark D5 v1 SHIPPED

## Compatibility

- **No schema migration on existing repos.** Telemetry is its own DB; first
  policy event creates it. Repos with no `.nexus/` dir get one created
  alongside the existing index DB path.
- **No behavior change with telemetry disabled.** `openTelemetryDb` returns
  null, dispatcher's `recordEvent(null, …)` is a no-op, policy decisions
  unchanged.
- **Dispatcher signature unchanged.** Existing tests of `dispatchPolicy`
  continue to pass.
- **C1, A5-C2, D3 rule outputs unchanged.** D5 is purely observational.
- **Hot path latency budget.** Telemetry adds one prepared-statement INSERT
  per fired rule. Better-sqlite3 INSERTs are ~10-20µs. Worst case: PreToolUse
  Bash event firing evidence-summary (one rule) = +20µs. Well under V3
  latency target (p95 < 150ms).

## Metrics

V4 will read these signals to evaluate the metrics gate:

```json
{
  "rules": {
    "preedit-impact":     { "events": N, "asks": 0,  "overrides": 0,  "p95_us": ... },
    "evidence-summary":   { "events": N, "asks": 0,  "overrides": 0,  "p95_us": ... },
    "read-on-structured": { "events": N, "asks": M,  "overrides": K,  "p95_us": ...,
                            "override_rate": K/M },
    "grep-on-code":       { "events": N, "asks": 0,  "denies": M,  "p95_us": ... },
    "read-on-source":     { "events": N, "p95_us": ... }
  },
  "opt_outs": { "transitions": N },
  "since": "30d"
}
```

A rule promotes to "deny" in V4 only when:
- `override_rate < 10%` (currently set to ask, never proceeded against)
- `events ≥ 100` (sample size)
- No spike in `opt_outs` correlating with the rule's introduction

The `read-on-structured` rule is the only V3 rule that emits `ask` today, so
it's the only candidate for V4 promotion. Other rules (`grep-on-code` already
denies; `preedit-impact` / `evidence-summary` / `read-on-source` always allow)
have different evaluation criteria — coverage and FP signals — that v1
telemetry doesn't yet capture.

## Open Questions

None blocking implementation. For the record:

- **Should `payload_json` be filled in v1?** No. It's reserved for future
  per-rule context (e.g., D3's affected-caller list, C1's risk bucket) that
  V4 might want to mine. Storing it costs disk; v1 keeps the column NULL
  to avoid premature commitment to a payload schema.
- **Should we record non-firing rule evaluations?** No in v1. Inflates event
  count by ~5x (one row per rule per event). Coverage analysis ("which rule
  saw which event") is interesting but not required by the metrics gate.
- **Multi-process write concurrency.** Two `nexus-policy-check` processes
  could write simultaneously. WAL handles this; if not, swallow-on-error
  means one process's row may be dropped. Acceptable for v1 — telemetry is
  best-effort.
