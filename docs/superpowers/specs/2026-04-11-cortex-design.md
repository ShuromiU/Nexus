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
- **Layered retrieval:** 150-200 token header always loaded; richer detail pulled on demand
- **Independent from Nexus:** Separate SQLite database, separate MCP server, no code dependency

## Architecture

### Data Capture

Two input streams feed the cognitive state:

**1. Automatic (hooks, zero token cost):**

Claude Code hooks fire after tool calls, logging structured events to SQLite. The AI never sees this happening.

```
After Read  → cortex log read --file <path>
After Edit  → cortex log edit --file <path>
After Write → cortex log write --file <path>
After Bash  → cortex log cmd --exit <code> --summary <cmd>
After Agent → cortex log agent --desc <description>
Session Start → cortex inject-header
```

Events are lightweight structured records: `{timestamp, type, target, metadata}`. Fast fire-and-forget INSERTs.

**2. Explicit (AI-authored notes, small token cost):**

The AI records meaningful interpretations via MCP tools — insights, decisions, user intent, blockers. Not every action, only what matters. ~30-50 tokens per note, 5-15 notes per session.

Examples:
- `cortex_note("insight", "auth.ts validates JWT but never checks token revocation")`
- `cortex_note("decision", "chose JWT over sessions — stateless fits microservice arch", alternatives: ["sessions", "OAuth"])`
- `cortex_note("intent", "user wants to refactor auth without breaking the API contract")`
- `cortex_note("blocker", "can't test auth without mocking the token service")`

### Storage

SQLite per project root (same pattern as Nexus).

```sql
sessions      — {id, started_at, ended_at, task_summary, status}
events        — {id, session_id, timestamp, type, target, metadata}
notes         — {id, session_id, timestamp, kind, subject, content, alternatives}
state         — {id, session_id, layer, content, created_at}
token_ledger  — {id, session_id, type, direction, tokens, timestamp}
```

- `events`: High-volume, low-value individually. Pruned after consolidation.
- `notes`: Low-volume, high-value. Persist until superseded.
- `state`: Consolidated snapshots — the actual "memory" served back.
- `token_ledger`: Tracks tokens spent by Cortex vs tokens saved (prevented re-reads, briefings).

### Consolidation

Three levels, mirroring human memory:

**Level 1 — Within a session (rule-based, zero token cost):**

Pure algorithmic compression. Runs automatically when event count exceeds a threshold (~50 events).
- Dedup: 5 reads of auth.ts → `{file: "auth.ts", reads: 5, lines_touched: [1-50, 80-120]}`
- Merge: sequential edits to the same file → single edit range
- Collapse: test→fail→fix→test→pass → `{file: "auth.ts", test_cycle: "fixed after 1 iteration"}`

**Level 2 — Previous session summary (AI-assisted, one-time cost):**

Triggered at the START of the next session, not at session end. This is critical — sessions usually end with Ctrl+C, so consolidation cannot depend on graceful shutdown.

Flow:
1. New session starts, startup hook fires
2. Cortex checks SQLite: previous session has unconsolidated events/notes
3. Rule-based compression runs immediately (Level 1)
4. When the AI first calls `cortex_state`, it reads the compressed events + notes and produces a ~200-400 token session summary
5. Summary is written back to the `state` table. Raw events can be pruned.

The AI was going to spend those tokens understanding prior work anyway. Cortex just saves the result so it never has to be done again. Net token cost: effectively zero.

If the AI never calls `cortex_state` in a session (e.g., a quick one-off question), the unconsolidated data simply carries forward to the next session that does call it. Nothing is lost — it just waits.

**Level 3 — Cross-session (rule-based + selective AI):**

When sessions accumulate (>5), older session summaries merge. Rule-based grouping by topic/files, with AI resolution only when ambiguous. The project-level state trends toward a ceiling of ~300-500 tokens, not infinity.

**Decay principle:**
- Raw events: pruned after consolidation
- Session summaries older than ~5 sessions: merged into project state
- Notes marked as superseded: dropped
- Total stored state has a ceiling, not a growth curve

### Retrieval

**Layer 1 — Always-loaded header (~150-200 tokens):**

Injected at session start via hook. The AI starts every conversation already knowing the basics:

```
Cortex: auth-refactor | 3 sessions | ~12k tokens saved
Last: refactored JWT validation, decided against sessions (stateless),
user wants API contract preserved.
Open: token revocation not handled yet.
Files: auth.ts (deep), middleware.ts (read once).
```

No tool call needed. It's just there, like Nexus's index status.

**Layer 2 — On-demand detail via MCP tools:**

Called only when the header isn't enough.

### MCP Tools

Four tools, minimal surface to keep schema token cost low:

| Tool | Purpose | Typical response |
|---|---|---|
| `cortex_state` | Full cognitive state, organized by topic | 300-500 tokens |
| `cortex_note(kind, content, alternatives?)` | Record insight/decision/intent/blocker | Confirmation, ~10 tokens |
| `cortex_recall(topic)` | Search past context by keyword/topic/file | 100-200 tokens |
| `cortex_brief(topic, for?)` | Scoped briefing for subagents | 50-80 tokens |

### CLI Commands

```
cortex log <type> [--file <path>] [--summary <text>]  — Hook event capture
cortex inject-header                                   — Startup hook: inject state header
cortex status                                          — Health and connection check
cortex stats                                           — Token savings dashboard
cortex consolidate                                     — Manual consolidation trigger
cortex serve                                           — Start MCP server
```

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

Net savings are typically positive: Cortex prevents redundant file reads (~3,000-4,000 tokens each) and eliminates re-derivation of context across sessions and subagents.

### Token Savings Dashboard (`cortex stats`)

```
Cortex — auth-refactor
─────────────────────────────────
Sessions:    7 (over 4 days)
Notes:       34 insights, 12 decisions

Tokens spent:     4,280  (notes: 1,800 | consolidation: 1,400 | queries: 1,080)
Tokens saved:    ~38,500  (prevented re-reads: 31,000 | subagent briefs: 7,500)
Net savings:     ~34,220  (89% efficiency)
─────────────────────────────────
```

The startup header also includes a one-line savings summary at zero extra cost.

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

## Hook Configuration

```json
{
  "hooks": {
    "afterRead":  [{ "command": "cortex log read --file $FILE" }],
    "afterEdit":  [{ "command": "cortex log edit --file $FILE" }],
    "afterWrite": [{ "command": "cortex log write --file $FILE" }],
    "afterBash":  [{ "command": "cortex log cmd --summary $CMD" }],
    "sessionStart": [{ "command": "cortex inject-header" }]
  }
}
```

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
