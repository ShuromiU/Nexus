# Cortex — Working Memory for AI Agents

**Date:** 2026-04-11
**Status:** Approved
**Companion to:** Nexus (codebase index)

## Problem

AI coding agents lose context constantly:
- **Between conversations:** Total amnesia. User re-explains tasks, decisions, and intent.
- **Within long conversations:** Older messages compress/drop. Decisions made early are forgotten.
- **Across parallel agents:** Subagents start cold. Duplicate work, miss parent context.

The existing memory system is too coarse for working state. Nexus covers code structure but not cognitive state. Nothing tracks what the AI is doing, why, what it learned, or what the user wants — the working memory that a human developer holds naturally.

## Solution

Cortex is a standalone MCP tool that gives AI agents persistent working memory. It maintains a living, compressed cognitive state per project — what was done, what was learned, what the user intends, what decisions were made and why.

### Design Principles

- **Token-efficient:** Total overhead ~1,400 tokens/session, likely net-negative (saves more than it costs)
- **Automatic capture:** Hooks log events outside the context window at zero token cost
- **Compresses, doesn't grow:** State refines over time like human memory — details fade, understanding persists
- **Focus-aware:** Header and recall bias toward the current line of work, not the entire project history
- **Freshness-aware:** Stale decisions and resolved blockers are excluded or marked, never silently surfaced as current truth
- **Safe by default:** Command logging redacts secrets; only safe commands stored verbatim
- **Layered retrieval:** 150-200 token header always loaded; richer detail pulled on demand
- **Independent from Nexus:** Separate SQLite database, separate MCP server, no code dependency

## Architecture

### Data Capture

Two input streams feed the cognitive state:

**1. Automatic (hooks, zero token cost):**

Claude Code hooks fire after tool calls, logging structured events to SQLite. The AI never sees this happening.

```
After Read  → cortex log read --file <path> --lines <start>-<end>
After Edit  → cortex log edit --file <path> --lines <start>-<end>
After Write → cortex log write --file <path>
After Bash  → cortex log cmd --exit <code> --category <type> --files-touched <paths>
After Agent → cortex log agent --desc <description>
Session Start → cortex inject-header
```

Events are structured records with enough metadata to support meaningful compression:

```
{timestamp, type, target, metadata}

metadata fields by type:
  read/edit:  {line_start, line_end, file_path}
  cmd:        {exit_code, category, files_touched, safe_summary}
  agent:      {description, parent_session_id}
```

Fast fire-and-forget INSERTs.

**Command safety:** Commands are classified and redacted before storage. Exit codes, categories (test/build/git/install), and touched files are always stored. Raw command text is only stored for allowlisted safe categories (git, npm scripts, build tools). Token-like patterns (`sk-*`, `Bearer *`, `--password`, etc.) are stripped from all stored text.

**2. Explicit (AI-authored notes, small token cost):**

The AI records meaningful interpretations via MCP tools — insights, decisions, user intent, blockers. Not every action, only what matters. ~30-50 tokens per note, 5-15 notes per session.

Examples:
- `cortex_note("insight", "auth.ts validates JWT but never checks token revocation")` — subject optional
- `cortex_note("decision", "chose JWT over sessions — stateless fits microservice arch", subject: "auth-strategy", alternatives: ["sessions", "OAuth"])` — subject required
- `cortex_note("intent", "user wants to refactor auth without breaking the API contract", subject: "auth-refactor")` — subject required
- `cortex_note("blocker", "can't test auth without mocking the token service", subject: "auth-testing")` — subject required
- `cortex_note("focus", "switching to CI pipeline fix", subject: "ci-fix")` — updates session focus

### Storage

SQLite per project root (same pattern as Nexus).

```sql
sessions      — {id (uuid), parent_session_id?, started_at, ended_at, focus, agent_type, status}
events        — {id (uuid), session_id, timestamp, type, target, metadata_json}
notes         — {id (uuid), session_id, timestamp, kind, subject, content, alternatives, status, conflict}
state         — {id (uuid), session_id?, layer, content, created_at}
token_ledger  — {id (uuid), session_id, type, direction, tokens, timestamp}
```

- `sessions`: Each session has a `focus` label and optional `parent_session_id` for subagent sessions. `agent_type` distinguishes primary vs subagent. See "Focus Assignment" below for how focus is set.
- `events`: High-volume, low-value individually. `metadata_json` stores structured fields (line ranges, exit codes, categories). Pruned after consolidation.
- `notes`: Low-volume, high-value. `subject` is **required** for `decision`, `intent`, and `blocker` kinds (the kinds that participate in auto-supersession); optional for `insight`. `status` field: `active` (default), `superseded` (replaced by a newer decision/intent on the same subject), or `resolved` (for blockers). Writing a new decision or intent auto-supersedes the previous active note with the same subject. Subject values are normalized (lowercased, trimmed) before matching.
- `state`: Consolidated snapshots — the actual "memory" served back. `session_id` is nullable: session-level summaries reference a session; the project-level merged state (Level 3) has `session_id = NULL` and `layer = 'project'`.
- `token_ledger`: Tracks tokens spent by Cortex vs estimated tokens saved (heuristic, not precise).

### Focus Assignment

Focus tracks what the AI is currently working on within a project. It determines which context the header and recall surface by default.

**How focus is set:**
1. **AI-set (primary):** The AI calls `cortex_note("intent", ...)` early in a session. The first intent note's subject becomes the session focus if none is set yet.
2. **Explicit override:** `cortex_note("focus", "auth refactor")` — a dedicated note kind that updates the current session's focus directly. Useful when the AI recognizes a task shift mid-session.
3. **Inherited:** Subagent sessions inherit the parent's focus unless overridden.
4. **Fallback:** If no focus is set by the end of a session, consolidation infers one from the most-touched files and note subjects (rule-based, best-effort).

**How focus affects retrieval:**
- The header prioritizes the most recent session's focus. If the current session has no focus yet, it uses the previous session's focus.
- `cortex_recall` biases results toward the current focus but does not exclude other topics. Off-focus results are ranked lower, not hidden.
- A quick one-off session (no notes written, no focus set) does not displace the prior session's focus in the header. The header falls back to the last session that had a meaningful focus.

### Consolidation

Three levels, mirroring human memory:

**Level 1 — Within a session (rule-based, zero token cost):**

Pure algorithmic compression. Runs automatically when event count exceeds a threshold (~50 events). Compression quality depends on available metadata — it degrades gracefully when hook variables are missing.

**Full metadata available:**
- Dedup: 5 reads of auth.ts → `{file: "auth.ts", reads: 5, lines_touched: [1-50, 80-120]}`
- Merge: sequential edits to the same file → single edit range (from `line_start`/`line_end` metadata)
- Collapse: test(exit 1)→edit→test(exit 0) → `{file: "auth.ts", test_cycle: "fixed after 1 iteration"}` (from `exit_code` + `category` metadata)

**Degraded mode (missing `$LINES`, `$EXIT_CODE`, etc.):**
- Dedup still works: 5 reads of auth.ts → `{file: "auth.ts", reads: 5}` (no line ranges)
- Merge still works: sequential edits → count only (no line ranges)
- Collapse unavailable without exit codes — commands stored as individual events
- The system logs which metadata fields are consistently missing so the user can diagnose hook configuration issues

**Level 2 — Previous session summary (AI-assisted, one-time cost):**

Triggered at the START of the next session, not at session end. This is critical — sessions usually end with Ctrl+C, so consolidation cannot depend on graceful shutdown.

Flow:
1. New session starts, startup hook fires
2. Cortex checks SQLite: previous session(s) have unconsolidated events/notes
3. Rule-based compression runs immediately (Level 1) — this is fast enough to complete during the startup hook
4. The startup header is built from this rule-compressed data. If no AI-consolidated state exists yet, the header is marked provisional but still useful (it shows files touched, focus, active notes)
5. When the AI first calls `cortex_state`, it reads the compressed events + notes and produces a ~200-400 token session summary
6. Summary is written back to the `state` table. Raw events can be pruned. Future headers use the full consolidated state.

The AI was going to spend those tokens understanding prior work anyway. Cortex just saves the result so it never has to be done again. Net token cost: effectively zero.

If the AI never calls `cortex_state` in a session (e.g., a quick one-off question), the unconsolidated data simply carries forward to the next session that does call it. Nothing is lost — it just waits.

**Subagent session handling:** Subagents write to child sessions (linked via `parent_session_id`). During consolidation of the parent session, subagent notes marked as `active` are promoted into the parent state. Exact duplicate notes (same kind + subject + content) are deduplicated. Conflicting notes (same kind + subject, different content) are **not** auto-resolved — both are kept as `active` with a `conflict: true` flag, and surfaced together in `cortex_state` so the AI can resolve them explicitly.

**Level 3 — Cross-session (rule-based + selective AI):**

When sessions accumulate (>5), older session summaries merge into a project-level state row (`state` table with `session_id = NULL`, `layer = 'project'`). Rule-based grouping by focus/topic/files, with AI resolution only when ambiguous. The project-level state trends toward a ceiling of ~300-500 tokens, not infinity. Only one project-level state row exists at a time — each Level 3 consolidation replaces the previous one.

**Decay and freshness:**
- Raw events: pruned after consolidation
- Session summaries older than ~5 sessions: merged into project state
- Notes with `status: superseded`: excluded from recall and header, pruned during cross-session merge
- Notes with `status: resolved`: shown as resolved in recall (for context), excluded from header
- Total stored state has a ceiling, not a growth curve
- All retrieval surfaces rank by recency: active recent items first, then active older items, then resolved/superseded (only if explicitly requested)

### Retrieval

**Layer 1 — Always-loaded header (~150-200 tokens):**

Injected at session start via hook. The AI starts every conversation already knowing the basics. The header is built from the most recent focus — not the entire project history.

When a full consolidated state exists:
```
Cortex: auth-refactor | 3 sessions | ~12k tokens saved
Last: refactored JWT validation, decided against sessions (stateless),
user wants API contract preserved.
Open: token revocation not handled yet.
Files: auth.ts (deep), middleware.ts (read once).
```

When only rule-compressed data is available (previous session not yet AI-consolidated):
```
Cortex [provisional]: auth-refactor | prior session unconsolidated
Touched: auth.ts (5 reads, 3 edits), middleware.ts (1 read)
Commands: 4 test runs (3 fail → 1 pass), 2 git commits
Active notes: 6 (2 decisions, 1 intent, 1 blocker, 2 insights)
→ Call cortex_state for full briefing
```

No tool call needed for the header. It's just there, like Nexus's index status.

**Environment note:** Header injection relies on Claude Code's startup hook capability (proven by Nexus in production). For non-Claude-Code environments, a `cortex_state("header")` call serves as a fallback.

**Layer 2 — On-demand detail via MCP tools:**

Called only when the header isn't enough.

### MCP Tools

Four tools, minimal surface to keep schema token cost low:

| Tool | Purpose | Typical response |
|---|---|---|
| `cortex_state` | Full cognitive state, organized by topic | 300-500 tokens |
| `cortex_note(kind, content, subject, alternatives?)` | Record insight/decision/intent/blocker/focus. `subject` required for decision, intent, blocker, focus; optional for insight. Normalized before matching. New decisions/intents auto-supersede prior active notes with same subject. | Confirmation, ~10 tokens |
| `cortex_recall(topic)` | Search past context. Searches typed notes first (indexed by kind/subject/status), then consolidated state blobs. Excludes superseded items by default. | 100-200 tokens |
| `cortex_brief(topic, for?)` | Scoped briefing for subagents | 50-80 tokens |

### CLI Commands

```
cortex log read --file <path> [--lines <start>-<end>]    — Log file read event
cortex log edit --file <path> [--lines <start>-<end>]    — Log file edit event
cortex log write --file <path>                           — Log file write event
cortex log cmd [--exit <code>] [--cmd <text>]            — Log command event (redacts before storage)
cortex log agent --desc <text>                           — Log subagent spawn event
cortex inject-header                                     — Startup hook: build and print state header
cortex status                                            — Health and connection check
cortex stats                                             — Token savings dashboard
cortex consolidate                                       — Manual consolidation trigger
cortex serve                                             — Start MCP server
```

The `log` subcommands are the canonical ingestion interface. All flags are optional except where noted — missing metadata results in degraded-mode compression (see Level 1 consolidation). The `log cmd` handler derives `category` and `files_touched` internally from the command text, after redaction.

### Token Budget

| Activity | Tokens | Frequency | Session total |
|---|---|---|---|
| Startup header | 150-200 | Once | ~200 |
| Hook event logging | 0 | Every tool call | 0 |
| AI notes | 30-50 each | 5-15 per session | ~300 |
| Previous session consolidation | 300-500 | Once at first cortex_state | ~400 |
| On-demand recalls | 100-200 each | 0-3 per session | ~300 |
| Subagent briefs | 50-80 each | 0-5 per session | ~200 |

**Worst case total: ~1,400 tokens/session.** Less than reading a single 200-line file.

Net savings are typically positive: Cortex prevents redundant file reads (~3,000-4,000 tokens each) and eliminates re-derivation of context across sessions and subagents. Savings figures are heuristic estimates based on prevented tool calls and briefing sizes — not precise measurements.

### Token Savings Dashboard (`cortex stats`)

```
Cortex — auth-refactor
─────────────────────────────────
Sessions:    7 (over 4 days)
Notes:       34 insights, 12 decisions (28 active, 6 superseded)

Tokens spent:     4,280  (notes: 1,800 | consolidation: 1,400 | queries: 1,080)
Tokens saved:   ~38,500  (estimated: prevented re-reads: ~31,000 | subagent briefs: ~7,500)
Net savings:    ~34,220  (estimated ~89% efficiency)

Direct metrics:  42 recalls served, avg 145 tokens | 8 briefs generated | 91% recall hit rate
─────────────────────────────────
```

The startup header also includes a one-line savings summary at zero extra cost. Direct metrics (recalls served, hit rate, note volume) are precise; token savings are heuristic estimates.

## Project Structure

```
cortex/
  src/
    db/
      schema.ts        — SQLite tables, migrations, WAL mode
      store.ts         — All DB operations, prepared statements
    capture/
      hooks.ts         — Hook command handlers (log events)
      consolidate.ts   — Rule-based compression + AI-summary trigger
    query/
      state.ts         — Build cognitive state from consolidated data
      recall.ts        — Topic-based search across notes + state
      brief.ts         — Scoped briefings for subagents
    transports/
      cli.ts           — CLI commands (log, stats, consolidate, serve)
      mcp.ts           — MCP server (cortex_state, cortex_note, cortex_recall, cortex_brief)
    index.ts           — Public API
  tests/
```

**Tech stack:** TypeScript, SQLite (better-sqlite3), MCP SDK — identical to Nexus.

### SQLite Concurrency

Multiple writers can hit the database concurrently: hooks from tool calls, MCP server reads, parallel subagents.

- WAL mode enabled (same as Nexus)
- `busy_timeout` set to 5000ms — hooks and queries wait rather than fail
- Hook writes are minimal single-row INSERTs in implicit transactions — no locking contention
- Consolidation uses short explicit transactions for batch operations
- Each event gets a UUID primary key. No dedup at write time — dedup happens during Level 1 consolidation (by type + target + timestamp window), not at INSERT
- Hook failures are non-blocking: if a hook can't write (locked DB, crash), the event is lost but the AI's workflow is unaffected. Working memory degrades gracefully, never blocks.

## Hook Configuration

```json
{
  "hooks": {
    "afterRead":  [{ "command": "cortex log read --file $FILE --lines $LINES" }],
    "afterEdit":  [{ "command": "cortex log edit --file $FILE --lines $LINES" }],
    "afterWrite": [{ "command": "cortex log write --file $FILE" }],
    "afterBash":  [{ "command": "cortex log cmd --exit $EXIT_CODE --cmd $CMD" }],
    "sessionStart": [{ "command": "cortex inject-header" }]
  }
}
```

Note: Hook variable availability (`$FILE`, `$LINES`, `$EXIT_CODE`, `$CMD`) depends on the Claude Code hook contract. The CLI's `log cmd` handler is responsible for classifying commands, extracting touched files, and redacting secrets before storage.

## Relationship with Nexus

- Independent SQLite databases, independent MCP servers, no code dependency
- Cortex can reference Nexus symbols in notes but doesn't import Nexus code
- Both register as MCP servers — the AI sees both tool sets
- A project can use one without the other
- Nexus = "what does this code look like?" / Cortex = "what am I doing with this code and why?"

## Not In Scope

- Multi-user / team shared state
- Cloud sync — local SQLite only
- Real-time streaming — hooks are fire-and-forget
- Integration with Claude's built-in memory system (different purpose: long-term preferences vs working memory)
- Web UI or graphical dashboard (CLI stats only)
