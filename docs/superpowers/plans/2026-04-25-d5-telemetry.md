# D5 v1 Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-policy-event signals (latency, decisions, override correlation, opt-out transitions) to `.nexus/telemetry.db`, enabling V4's metrics gate.

**Architecture:** Append-only SQLite events table separate from index DB. Lazy open + 30d/100k retention pruned at startup (24h gate). Opt-out via `NEXUS_TELEMETRY=0` env var or `.nexus.json {telemetry:false}`. CLI surface: `nexus telemetry stats|export|purge`.

**Tech Stack:** TypeScript strict, better-sqlite3, vitest, commander.

**Spec:** `docs/superpowers/specs/2026-04-25-d5-telemetry-design.md`

---

## File Structure

NEW source files:
- `src/policy/telemetry.ts` — store: open/recordEvent/pruneIfDue/recordOptOutTransition/closeTelemetryDb (~250 lines)
- `src/policy/telemetry-config.ts` — `isTelemetryEnabled` (env precedence + config) + `computeInputHash` (~60 lines)

NEW test files (one per concern):
- `tests/policy-telemetry-store.test.ts`
- `tests/policy-telemetry-optout.test.ts`
- `tests/policy-telemetry-hash.test.ts`
- `tests/policy-telemetry-dispatcher.test.ts`
- `tests/policy-telemetry-entry.test.ts`
- `tests/policy-telemetry-cli.test.ts`
- `tests/policy-telemetry-integration.test.ts`

MODIFIED:
- `src/policy/types.ts` — `PolicyContext.telemetryDb?` and `PolicyContext.inputHash?`
- `src/policy/dispatcher.ts` — `DispatchOptions.telemetryDb? + inputHash?`; per-rule timing + recordEvent; noop row on pass-through; per-rule try/catch
- `src/policy/index.ts` — re-export new modules
- `src/transports/policy-entry.ts` — open/prune/transition/hash/close at boundaries
- `src/transports/cli.ts` — new `telemetry` subcommand
- `src/config.ts` — optional `telemetry: boolean` field
- `CHANGELOG.md`, `CLAUDE.md`
- `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md` — mark D5 v1 SHIPPED

---

## Task Layout

15 tasks. Each ends with build + test + commit. Tasks 2-9 are TDD (test first, code second). Tasks 10-13 are user-visible surfaces.

---

### Task 1: Verify clean baseline

**Files:** None (read-only).

- [ ] **Step 1: Confirm clean tree on the worktree branch**

```
git status --short
```
Expected: empty output (only the spec commit on the branch).

- [ ] **Step 2: Build clean**

```
npm run build
```
Expected: exit 0, no diagnostics.

- [ ] **Step 3: Tests pass**

```
npm run test
```
Expected: `30 passed (30) | 770 passed (770)`.

If any fails, stop and fix before proceeding — D5 introduces nothing yet.

---

### Task 2: Telemetry store — open + close + schema

**Files:**
- Create: `src/policy/telemetry.ts`
- Test: `tests/policy-telemetry-store.test.ts`

- [ ] **Step 1: Write failing tests for `openTelemetryDb` + `closeTelemetryDb`**

```typescript
// tests/policy-telemetry-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openTelemetryDb,
  closeTelemetryDb,
  recordEvent,
  pruneIfDue,
  TELEMETRY_SCHEMA_VERSION,
} from '../src/policy/telemetry.js';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-telemetry-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('openTelemetryDb', () => {
  it('creates .nexus/telemetry.db with schema on first open', () => {
    const db = openTelemetryDb(tmpRoot);
    expect(db).not.toBeNull();
    expect(fs.existsSync(path.join(tmpRoot, '.nexus', 'telemetry.db'))).toBe(true);
    const meta = db!.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    expect(meta?.value).toBe(String(TELEMETRY_SCHEMA_VERSION));
    closeTelemetryDb(db!);
  });

  it('reuses existing DB on subsequent opens', () => {
    const a = openTelemetryDb(tmpRoot);
    a!.prepare('INSERT INTO events (ts_ms, hook_event) VALUES (?, ?)').run(1, 'PreToolUse');
    closeTelemetryDb(a!);

    const b = openTelemetryDb(tmpRoot);
    const row = b!.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(row.n).toBe(1);
    closeTelemetryDb(b!);
  });

  it('returns null when .nexus dir cannot be created (parent is a file)', () => {
    const fakeRoot = path.join(tmpRoot, 'not-a-dir');
    fs.writeFileSync(fakeRoot, 'sentinel');
    const db = openTelemetryDb(fakeRoot);
    expect(db).toBeNull();
  });

  it('recovers from corrupt DB by renaming + recreating', () => {
    fs.mkdirSync(path.join(tmpRoot, '.nexus'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.nexus', 'telemetry.db'), 'not-a-sqlite-db');

    const db = openTelemetryDb(tmpRoot);
    expect(db).not.toBeNull();
    const row = db!.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(row.n).toBe(0);

    const corrupted = fs.readdirSync(path.join(tmpRoot, '.nexus'))
      .filter(f => f.startsWith('telemetry.db.corrupt-'));
    expect(corrupted.length).toBe(1);
    closeTelemetryDb(db!);
  });

  it('recovers when schema_version differs', () => {
    fs.mkdirSync(path.join(tmpRoot, '.nexus'), { recursive: true });
    const Database = (await import('better-sqlite3')).default;
    const db1 = new Database(path.join(tmpRoot, '.nexus', 'telemetry.db'));
    db1.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','999');");
    db1.close();

    const db = openTelemetryDb(tmpRoot);
    expect(db).not.toBeNull();
    const meta = db!.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as { value: string };
    expect(meta.value).toBe(String(TELEMETRY_SCHEMA_VERSION));
    closeTelemetryDb(db!);
  });
});
```

Note: the last test uses top-level `await` inside a `describe`. Replace with sync import via require or inline `(async () => {})()` if vitest complains. Concrete fix: change the test body to await the import and mark the test function `async`:

```typescript
  it('recovers when schema_version differs', async () => {
    // ... same body, with `await import('better-sqlite3')` ...
  });
```

- [ ] **Step 2: Run test and verify failure**

```
npm run test -- tests/policy-telemetry-store.test.ts
```
Expected: FAIL with "Cannot find module '../src/policy/telemetry.js'".

- [ ] **Step 3: Implement `src/policy/telemetry.ts` (open/close + schema)**

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

export const TELEMETRY_SCHEMA_VERSION = 1;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  session_id TEXT,
  hook_event TEXT NOT NULL,
  tool_name TEXT,
  rule TEXT,
  decision TEXT,
  latency_us INTEGER,
  input_hash TEXT,
  file_path TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session_hash
  ON events(session_id, input_hash)
  WHERE session_id IS NOT NULL AND input_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_ms);
CREATE INDEX IF NOT EXISTS idx_events_rule_decision ON events(rule, decision);
`;

export interface TelemetryEvent {
  ts_ms: number;
  session_id: string | null;
  hook_event: 'PreToolUse' | 'PostToolUse' | 'opt_out' | 'opt_in';
  tool_name: string | null;
  rule: string | null;
  decision: 'allow' | 'ask' | 'deny' | 'noop' | null;
  latency_us: number | null;
  input_hash: string | null;
  file_path: string | null;
  payload_json: string | null;
}

export function openTelemetryDb(rootDir: string): Database.Database | null {
  const nexusDir = path.join(rootDir, '.nexus');
  try {
    fs.mkdirSync(nexusDir, { recursive: true });
  } catch {
    return null;
  }
  const dbPath = path.join(nexusDir, 'telemetry.db');

  const tryOpen = (): Database.Database | null => {
    try {
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.exec(SCHEMA_DDL);
      const row = db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as { value: string } | undefined;
      if (!row) {
        db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(TELEMETRY_SCHEMA_VERSION));
      } else if (row.value !== String(TELEMETRY_SCHEMA_VERSION)) {
        db.close();
        return null; // signal recreate
      }
      return db;
    } catch {
      return null;
    }
  };

  let db = tryOpen();
  if (db) return db;

  // Quarantine + retry once
  try {
    if (fs.existsSync(dbPath)) {
      const stamp = Date.now();
      fs.renameSync(dbPath, `${dbPath}.corrupt-${stamp}`);
    }
  } catch {
    return null;
  }
  db = tryOpen();
  return db;
}

export function closeTelemetryDb(db: Database.Database): void {
  try { db.close(); } catch { /* swallow */ }
}

export function recordEvent(_db: Database.Database | null, _ev: TelemetryEvent): void {
  // implemented in Task 3
}

export function pruneIfDue(_db: Database.Database, _now?: number): { pruned: number } {
  // implemented in Task 4
  return { pruned: 0 };
}
```

- [ ] **Step 4: Run test and verify passes**

```
npm run test -- tests/policy-telemetry-store.test.ts
```
Expected: 5 tests PASS in `openTelemetryDb` group.

- [ ] **Step 5: Build clean**

```
npm run build
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/policy/telemetry.ts tests/policy-telemetry-store.test.ts
git commit -m "feat(policy): telemetry store skeleton — open/close/schema (D5)

Lazy create .nexus/telemetry.db with WAL + synchronous=NORMAL. Schema:
events + meta tables, three indexes. Schema-version mismatch and corrupt
files trigger quarantine-and-recreate. Returns null on dir-create failure.
recordEvent/pruneIfDue stubbed for next tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `recordEvent` — INSERT + null-safe + swallow

**Files:**
- Modify: `src/policy/telemetry.ts`
- Modify: `tests/policy-telemetry-store.test.ts` (extend)

- [ ] **Step 1: Append failing tests**

```typescript
// add inside the same file
describe('recordEvent', () => {
  it('is a no-op when db is null', () => {
    expect(() => recordEvent(null, {
      ts_ms: 1, session_id: 's', hook_event: 'PreToolUse',
      tool_name: 'Read', rule: 'r', decision: 'allow', latency_us: 100,
      input_hash: 'a'.repeat(16), file_path: 'f.ts', payload_json: null,
    })).not.toThrow();
  });

  it('inserts a row matching the input', () => {
    const db = openTelemetryDb(tmpRoot)!;
    recordEvent(db, {
      ts_ms: 12345, session_id: 'sess1', hook_event: 'PreToolUse',
      tool_name: 'Edit', rule: 'preedit-impact', decision: 'allow',
      latency_us: 850, input_hash: '1234567890abcdef',
      file_path: 'src/foo.ts', payload_json: null,
    });
    const row = db.prepare('SELECT * FROM events').get() as Record<string, unknown>;
    expect(row.ts_ms).toBe(12345);
    expect(row.session_id).toBe('sess1');
    expect(row.hook_event).toBe('PreToolUse');
    expect(row.tool_name).toBe('Edit');
    expect(row.rule).toBe('preedit-impact');
    expect(row.decision).toBe('allow');
    expect(row.latency_us).toBe(850);
    expect(row.input_hash).toBe('1234567890abcdef');
    expect(row.file_path).toBe('src/foo.ts');
    expect(row.payload_json).toBeNull();
    closeTelemetryDb(db);
  });

  it('swallows errors when DB is closed mid-record', () => {
    const db = openTelemetryDb(tmpRoot)!;
    closeTelemetryDb(db);
    expect(() => recordEvent(db, {
      ts_ms: 1, session_id: null, hook_event: 'PreToolUse',
      tool_name: 'Read', rule: null, decision: 'noop', latency_us: 0,
      input_hash: null, file_path: null, payload_json: null,
    })).not.toThrow();
  });

  it('accepts NULL session_id, rule, decision, and latency_us', () => {
    const db = openTelemetryDb(tmpRoot)!;
    recordEvent(db, {
      ts_ms: 1, session_id: null, hook_event: 'opt_out',
      tool_name: null, rule: null, decision: null, latency_us: null,
      input_hash: null, file_path: null, payload_json: null,
    });
    const row = db.prepare('SELECT * FROM events').get() as Record<string, unknown>;
    expect(row.hook_event).toBe('opt_out');
    expect(row.session_id).toBeNull();
    expect(row.rule).toBeNull();
    expect(row.latency_us).toBeNull();
    closeTelemetryDb(db);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```
npm run test -- tests/policy-telemetry-store.test.ts -t "recordEvent"
```
Expected: 4 FAIL ("expected 1 to be 12345" etc — stub returns nothing).

- [ ] **Step 3: Implement `recordEvent`**

Replace the stub in `src/policy/telemetry.ts`:

```typescript
const INSERT_SQL = `
INSERT INTO events
  (ts_ms, session_id, hook_event, tool_name, rule, decision,
   latency_us, input_hash, file_path, payload_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function recordEvent(db: Database.Database | null, ev: TelemetryEvent): void {
  if (!db) return;
  try {
    db.prepare(INSERT_SQL).run(
      ev.ts_ms,
      ev.session_id,
      ev.hook_event,
      ev.tool_name,
      ev.rule,
      ev.decision,
      ev.latency_us,
      ev.input_hash,
      ev.file_path,
      ev.payload_json,
    );
  } catch {
    /* swallow — telemetry must never block policy */
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

```
npm run test -- tests/policy-telemetry-store.test.ts
```
Expected: 9 PASS (5 from Task 2 + 4 new).

- [ ] **Step 5: Build clean**

```
npm run build
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/policy/telemetry.ts tests/policy-telemetry-store.test.ts
git commit -m "feat(policy): telemetry recordEvent — null-safe insert (D5)

Single prepared INSERT; swallow-on-error to keep policy hot path
exception-free. NULL columns supported for opt_* rows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `pruneIfDue` — 24h gate, 30d time, 100k count

**Files:**
- Modify: `src/policy/telemetry.ts`
- Modify: `tests/policy-telemetry-store.test.ts` (extend)

- [ ] **Step 1: Append failing tests**

```typescript
describe('pruneIfDue', () => {
  it('first call sets last_prune_ts and prunes nothing on empty DB', () => {
    const db = openTelemetryDb(tmpRoot)!;
    const r = pruneIfDue(db, 1000);
    expect(r.pruned).toBe(0);
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get('last_prune_ts') as { value: string };
    expect(row.value).toBe('1000');
    closeTelemetryDb(db);
  });

  it('within 24h gate returns {pruned:0} without touching events', () => {
    const db = openTelemetryDb(tmpRoot)!;
    pruneIfDue(db, 1000);
    // insert a 100-day-old row that would normally be pruned
    const old = 1000 - 100 * 86400000;
    recordEvent(db, {
      ts_ms: old, session_id: null, hook_event: 'PreToolUse',
      tool_name: 'Read', rule: null, decision: 'noop', latency_us: 0,
      input_hash: null, file_path: null, payload_json: null,
    });
    const r = pruneIfDue(db, 1000 + 1000); // < 24h later
    expect(r.pruned).toBe(0);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    expect(n).toBe(1);
    closeTelemetryDb(db);
  });

  it('removes rows older than 30 days', () => {
    const db = openTelemetryDb(tmpRoot)!;
    const now = 1_000_000_000_000;
    const old = now - 31 * 86400000;
    const fresh = now - 1 * 86400000;
    for (const ts of [old, fresh]) {
      recordEvent(db, {
        ts_ms: ts, session_id: null, hook_event: 'PreToolUse',
        tool_name: 'Read', rule: null, decision: 'noop', latency_us: 0,
        input_hash: null, file_path: null, payload_json: null,
      });
    }
    const r = pruneIfDue(db, now);
    expect(r.pruned).toBe(1);
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    expect(remaining).toBe(1);
    closeTelemetryDb(db);
  });

  it('caps row count at 100_000 (id-DESC ordered)', () => {
    const db = openTelemetryDb(tmpRoot)!;
    const now = 1_000_000_000_000;
    const insert = db.prepare(`INSERT INTO events (ts_ms, hook_event) VALUES (?, ?)`);
    db.exec('BEGIN');
    for (let i = 0; i < 100_010; i++) {
      insert.run(now, 'PreToolUse');
    }
    db.exec('COMMIT');
    const r = pruneIfDue(db, now);
    expect(r.pruned).toBeGreaterThanOrEqual(10);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    expect(n).toBe(100_000);
    closeTelemetryDb(db);
  });

  it('subsequent pruneIfDue beyond 24h gate runs again', () => {
    const db = openTelemetryDb(tmpRoot)!;
    pruneIfDue(db, 1000);
    pruneIfDue(db, 1000 + 25 * 3600 * 1000); // > 24h
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get('last_prune_ts') as { value: string };
    expect(Number(row.value)).toBe(1000 + 25 * 3600 * 1000);
    closeTelemetryDb(db);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```
npm run test -- tests/policy-telemetry-store.test.ts -t "pruneIfDue"
```
Expected: 5 FAIL.

- [ ] **Step 3: Implement `pruneIfDue`**

Replace the stub:

```typescript
const RETENTION_DAYS = 30;
const RETENTION_ROW_CAP = 100_000;
const PRUNE_INTERVAL_MS = 24 * 3600 * 1000;

export function pruneIfDue(db: Database.Database, now: number = Date.now()): { pruned: number } {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get('last_prune_ts') as { value: string } | undefined;
    const last = row ? Number(row.value) : 0;
    if (now - last < PRUNE_INTERVAL_MS && last !== 0) {
      return { pruned: 0 };
    }

    const cutoff = now - RETENTION_DAYS * 86400000;
    const timeRes = db.prepare('DELETE FROM events WHERE ts_ms < ?').run(cutoff);
    const countRes = db.prepare(
      'DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)'
    ).run(RETENTION_ROW_CAP);

    const upsertSql = `
      INSERT INTO meta(key, value) VALUES('last_prune_ts', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `;
    db.prepare(upsertSql).run(String(now));

    return { pruned: Number(timeRes.changes) + Number(countRes.changes) };
  } catch {
    return { pruned: 0 };
  }
}
```

- [ ] **Step 4: Run tests**

```
npm run test -- tests/policy-telemetry-store.test.ts
```
Expected: 14 PASS.

Note: the 100k-row test inserts 100_010 rows in a transaction; expect ~3-5 sec. If it stalls, raise vitest's per-test timeout via `it('...', { timeout: 15000 }, async () => {...})`.

- [ ] **Step 5: Build clean**

```
npm run build
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/policy/telemetry.ts tests/policy-telemetry-store.test.ts
git commit -m "feat(policy): telemetry pruneIfDue — 24h gate, 30d/100k cap (D5)

Idempotent within a 24h window via meta.last_prune_ts. Drops events older
than 30 days, then trims to newest 100,000 rows by id-DESC. All operations
swallowed on error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `recordOptOutTransition` — flip detection

**Files:**
- Modify: `src/policy/telemetry.ts`
- Create: `tests/policy-telemetry-optout.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/policy-telemetry-optout.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import {
  recordOptOutTransition,
  openTelemetryDb,
  closeTelemetryDb,
} from '../src/policy/telemetry.js';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-optout-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readEvents(): { hook_event: string }[] {
  const db = new Database(path.join(tmpRoot, '.nexus', 'telemetry.db'), { readonly: true });
  const rows = db.prepare("SELECT hook_event FROM events ORDER BY id").all() as { hook_event: string }[];
  db.close();
  return rows;
}
function readEnabledState(): string | null {
  const db = new Database(path.join(tmpRoot, '.nexus', 'telemetry.db'), { readonly: true });
  const row = db.prepare("SELECT value FROM meta WHERE key='last_enabled_state'").get() as { value: string } | undefined;
  db.close();
  return row?.value ?? null;
}

describe('recordOptOutTransition', () => {
  it('on first run with enabled=true, stores last_enabled_state=1, no events', () => {
    recordOptOutTransition(tmpRoot, true);
    expect(readEnabledState()).toBe('1');
    expect(readEvents()).toEqual([]);
  });

  it('writes opt_out event when transitioning enabled→disabled', () => {
    recordOptOutTransition(tmpRoot, true);
    recordOptOutTransition(tmpRoot, false);
    expect(readEvents().map(e => e.hook_event)).toEqual(['opt_out']);
    expect(readEnabledState()).toBe('0');
  });

  it('writes opt_in event when transitioning disabled→enabled', () => {
    recordOptOutTransition(tmpRoot, false);
    recordOptOutTransition(tmpRoot, true);
    expect(readEvents().map(e => e.hook_event)).toEqual(['opt_in']);
    expect(readEnabledState()).toBe('1');
  });

  it('writes nothing when state is unchanged across calls', () => {
    recordOptOutTransition(tmpRoot, true);
    recordOptOutTransition(tmpRoot, true);
    recordOptOutTransition(tmpRoot, true);
    expect(readEvents()).toEqual([]);
  });

  it('survives missing telemetry.db (no-op, no throw)', () => {
    expect(() => recordOptOutTransition(tmpRoot, false)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```
npm run test -- tests/policy-telemetry-optout.test.ts
```
Expected: 5 FAIL ("recordOptOutTransition is not a function").

- [ ] **Step 3: Implement in `src/policy/telemetry.ts`**

Append:

```typescript
export function recordOptOutTransition(rootDir: string, currentlyEnabled: boolean): void {
  const db = openTelemetryDb(rootDir);
  if (!db) return;
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get('last_enabled_state') as { value: string } | undefined;
    const last = row?.value ?? null;
    const now = currentlyEnabled ? '1' : '0';

    if (last === null) {
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('last_enabled_state', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(now);
      // No transition event on first observation.
    } else if (last !== now) {
      const hookEvent = currentlyEnabled ? 'opt_in' : 'opt_out';
      recordEvent(db, {
        ts_ms: Date.now(),
        session_id: null,
        hook_event: hookEvent,
        tool_name: null,
        rule: null,
        decision: null,
        latency_us: null,
        input_hash: null,
        file_path: null,
        payload_json: null,
      });
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('last_enabled_state', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(now);
    }
  } catch {
    /* swallow */
  } finally {
    closeTelemetryDb(db);
  }
}
```

- [ ] **Step 4: Run tests**

```
npm run test -- tests/policy-telemetry-optout.test.ts
```
Expected: 5 PASS.

- [ ] **Step 5: Build + full test sweep**

```
npm run build && npm run test
```
Expected: exit 0; 770 + 14 store + 5 optout = 789 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/policy/telemetry.ts tests/policy-telemetry-optout.test.ts
git commit -m "feat(policy): telemetry recordOptOutTransition (D5)

On first observation, stores last_enabled_state without an event. On
transition (1→0 or 0→1), writes an opt_out/opt_in event row and updates
meta. DB is opened just long enough to read+write+close. Missing DB is
silently tolerated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `isTelemetryEnabled` + config field — env precedence

**Files:**
- Create: `src/policy/telemetry-config.ts`
- Modify: `src/config.ts`
- Create: `tests/policy-telemetry-optout.test.ts` (extend with new `describe`)

- [ ] **Step 1: Append failing tests to `tests/policy-telemetry-optout.test.ts`**

```typescript
import { isTelemetryEnabled } from '../src/policy/telemetry-config.js';

describe('isTelemetryEnabled', () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.NEXUS_TELEMETRY;
    delete process.env.NEXUS_TELEMETRY;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.NEXUS_TELEMETRY;
    else process.env.NEXUS_TELEMETRY = savedEnv;
  });

  function writeConfig(value: unknown): void {
    fs.writeFileSync(path.join(tmpRoot, '.nexus.json'), JSON.stringify({ telemetry: value }));
  }

  it('default is enabled (no env, no config)', () => {
    expect(isTelemetryEnabled(tmpRoot)).toBe(true);
  });

  it('config telemetry:false disables', () => {
    writeConfig(false);
    expect(isTelemetryEnabled(tmpRoot)).toBe(false);
  });

  it('config telemetry:true enables (explicit)', () => {
    writeConfig(true);
    expect(isTelemetryEnabled(tmpRoot)).toBe(true);
  });

  it('env=0 overrides config=true', () => {
    writeConfig(true);
    process.env.NEXUS_TELEMETRY = '0';
    expect(isTelemetryEnabled(tmpRoot)).toBe(false);
  });

  it('env=1 overrides config=false', () => {
    writeConfig(false);
    process.env.NEXUS_TELEMETRY = '1';
    expect(isTelemetryEnabled(tmpRoot)).toBe(true);
  });

  it('env=false (string) treated as disabled', () => {
    process.env.NEXUS_TELEMETRY = 'false';
    expect(isTelemetryEnabled(tmpRoot)).toBe(false);
  });

  it('env=true (string) treated as enabled', () => {
    writeConfig(false);
    process.env.NEXUS_TELEMETRY = 'true';
    expect(isTelemetryEnabled(tmpRoot)).toBe(true);
  });

  it('malformed config falls back to enabled', () => {
    fs.writeFileSync(path.join(tmpRoot, '.nexus.json'), '{not-json');
    expect(isTelemetryEnabled(tmpRoot)).toBe(true);
  });

  it('unknown env value (e.g. "yes") falls through to config/default', () => {
    process.env.NEXUS_TELEMETRY = 'yes';
    expect(isTelemetryEnabled(tmpRoot)).toBe(true);
    writeConfig(false);
    expect(isTelemetryEnabled(tmpRoot)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```
npm run test -- tests/policy-telemetry-optout.test.ts -t "isTelemetryEnabled"
```
Expected: 9 FAIL ("Cannot find module").

- [ ] **Step 3: Add `telemetry?: boolean` to `NexusConfig`**

Edit `src/config.ts`:

```typescript
export interface NexusConfig {
  root: string;
  exclude: string[];
  include: string[];
  languages: Record<string, { extensions: string[] }>;
  maxFileSize: number;
  minifiedLineLength: number;
  telemetry?: boolean;
}

const DEFAULT_CONFIG: NexusConfig = {
  root: '.',
  exclude: [],
  include: [],
  languages: {},
  maxFileSize: 1_048_576,
  minifiedLineLength: 500,
};
```

And in `loadConfig`, add the field to the returned object:

```typescript
return {
  root: parsed.root ?? DEFAULT_CONFIG.root,
  exclude: parsed.exclude ?? DEFAULT_CONFIG.exclude,
  include: parsed.include ?? DEFAULT_CONFIG.include,
  languages: parsed.languages ?? DEFAULT_CONFIG.languages,
  maxFileSize: parsed.maxFileSize ?? DEFAULT_CONFIG.maxFileSize,
  minifiedLineLength: parsed.minifiedLineLength ?? DEFAULT_CONFIG.minifiedLineLength,
  ...(typeof parsed.telemetry === 'boolean' ? { telemetry: parsed.telemetry } : {}),
};
```

- [ ] **Step 4: Create `src/policy/telemetry-config.ts`**

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';

const ENV_VAR = 'NEXUS_TELEMETRY';

/**
 * Resolve telemetry on/off. Env trumps config; defaults to enabled.
 *
 * Precedence:
 *   1. NEXUS_TELEMETRY=0|false → disabled
 *   2. NEXUS_TELEMETRY=1|true  → enabled (overrides config)
 *   3. .nexus.json telemetry:false → disabled
 *   4. .nexus.json telemetry:true  → enabled
 *   5. Default → enabled
 *
 * Unknown env values (e.g. "yes") fall through to config/default.
 * Malformed config falls through to default (enabled).
 */
export function isTelemetryEnabled(rootDir: string): boolean {
  const env = process.env[ENV_VAR];
  if (env === '0' || env === 'false') return false;
  if (env === '1' || env === 'true') return true;

  try {
    const raw = fs.readFileSync(path.join(rootDir, '.nexus.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { telemetry?: unknown };
    if (typeof parsed.telemetry === 'boolean') return parsed.telemetry;
  } catch {
    /* missing or malformed → default */
  }
  return true;
}
```

- [ ] **Step 5: Run tests**

```
npm run test -- tests/policy-telemetry-optout.test.ts
```
Expected: 14 PASS (5 transition + 9 enabled).

- [ ] **Step 6: Build clean**

```
npm run build
```
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/policy/telemetry-config.ts tests/policy-telemetry-optout.test.ts
git commit -m "feat(policy): isTelemetryEnabled + config field (D5)

Env precedence (NEXUS_TELEMETRY=0|1|true|false) over .nexus.json
{telemetry:bool}; default enabled. Unknown env values fall through
to config/default. .nexus.json malformed → default.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `computeInputHash` — canonical JSON + 16-char SHA256

**Files:**
- Modify: `src/policy/telemetry-config.ts`
- Create: `tests/policy-telemetry-hash.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/policy-telemetry-hash.test.ts
import { describe, it, expect } from 'vitest';
import { computeInputHash } from '../src/policy/telemetry-config.js';

describe('computeInputHash', () => {
  it('returns a 16-character hex string', () => {
    const h = computeInputHash({ a: 1 });
    expect(h).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(h)).toBe(true);
  });

  it('is deterministic across calls', () => {
    const a = computeInputHash({ file_path: 'x.ts', new_string: 'y' });
    const b = computeInputHash({ file_path: 'x.ts', new_string: 'y' });
    expect(a).toBe(b);
  });

  it('is order-insensitive (sorts keys recursively)', () => {
    const a = computeInputHash({ file_path: 'x.ts', new_string: 'y' });
    const b = computeInputHash({ new_string: 'y', file_path: 'x.ts' });
    expect(a).toBe(b);
  });

  it('descends into nested objects for sorting', () => {
    const a = computeInputHash({ outer: { a: 1, b: 2 }, c: 3 });
    const b = computeInputHash({ c: 3, outer: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it('different inputs produce different hashes', () => {
    const a = computeInputHash({ file_path: 'x.ts' });
    const b = computeInputHash({ file_path: 'y.ts' });
    expect(a).not.toBe(b);
  });

  it('handles arrays without sorting their elements', () => {
    const a = computeInputHash({ list: [1, 2, 3] });
    const b = computeInputHash({ list: [3, 2, 1] });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```
npm run test -- tests/policy-telemetry-hash.test.ts
```
Expected: 6 FAIL ("computeInputHash is not a function").

- [ ] **Step 3: Implement in `src/policy/telemetry-config.ts`**

Append:

```typescript
import { createHash } from 'node:crypto';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k]));
  return '{' + pairs.join(',') + '}';
}

export function computeInputHash(toolInput: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(toolInput)).digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Run tests**

```
npm run test -- tests/policy-telemetry-hash.test.ts
```
Expected: 6 PASS.

- [ ] **Step 5: Build clean**

```
npm run build
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/policy/telemetry-config.ts tests/policy-telemetry-hash.test.ts
git commit -m "feat(policy): computeInputHash — canonical JSON SHA256 (D5)

Recursive key-sort + JSON.stringify, then sha256 → 16-char hex prefix.
Stable across runs and field orderings; different content → different
hash. Used by override-rate correlation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Dispatcher integration — timing + recordEvent + try/catch + noop row

**Files:**
- Modify: `src/policy/types.ts`
- Modify: `src/policy/dispatcher.ts`
- Create: `tests/policy-telemetry-dispatcher.test.ts`

- [ ] **Step 1: Widen `PolicyContext` and `DispatchOptions`**

In `src/policy/types.ts`:

```typescript
import type Database from 'better-sqlite3';
// ... existing exports ...

export interface PolicyContext {
  rootDir: string;
  dbPath: string;
  queryEngine?: QueryEngineLike;
  /** Telemetry handle (D5). Forwarded by the dispatcher; rules ignore it. */
  telemetryDb?: Database.Database;
  /** Canonical hash of `tool_input` (D5). NULL when telemetry disabled. */
  inputHash?: string;
}
```

In `src/policy/dispatcher.ts`, widen `DispatchOptions`:

```typescript
import type Database from 'better-sqlite3';

export interface DispatchOptions {
  rootDir: string;
  rules: readonly PolicyRule[];
  queryEngine?: QueryEngineLike;
  telemetryDb?: Database.Database;
  inputHash?: string;
}
```

- [ ] **Step 2: Write failing tests**

```typescript
// tests/policy-telemetry-dispatcher.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { dispatchPolicy } from '../src/policy/dispatcher.js';
import { openTelemetryDb, closeTelemetryDb } from '../src/policy/telemetry.js';
import type { PolicyEvent, PolicyRule, PolicyDecision } from '../src/policy/types.js';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-disp-tel-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const event = (over: Partial<PolicyEvent> = {}): PolicyEvent => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: 'src/foo.ts' },
  session_id: 'sess-A',
  ...over,
});

const allowAlways: PolicyRule = {
  name: 'allow-always',
  evaluate: () => ({ decision: 'allow' as const, rule: 'allow-always' }),
};
const noopAlways: PolicyRule = {
  name: 'noop-always',
  evaluate: () => null,
};
const throwingRule: PolicyRule = {
  name: 'thrower',
  evaluate: () => { throw new Error('boom'); },
};

function readEvents(): Record<string, unknown>[] {
  const db = new Database(path.join(tmpRoot, '.nexus', 'telemetry.db'), { readonly: true });
  const rows = db.prepare('SELECT * FROM events ORDER BY id').all() as Record<string, unknown>[];
  db.close();
  return rows;
}

describe('dispatcher telemetry integration', () => {
  it('records one row when a rule fires', () => {
    const db = openTelemetryDb(tmpRoot)!;
    dispatchPolicy(event(), { rootDir: tmpRoot, rules: [allowAlways], telemetryDb: db, inputHash: 'aabb' });
    closeTelemetryDb(db);
    const rows = readEvents();
    expect(rows.length).toBe(1);
    expect(rows[0].rule).toBe('allow-always');
    expect(rows[0].decision).toBe('allow');
    expect(rows[0].input_hash).toBe('aabb');
    expect(rows[0].session_id).toBe('sess-A');
    expect(rows[0].hook_event).toBe('PreToolUse');
    expect(typeof rows[0].latency_us).toBe('number');
    expect(rows[0].latency_us as number).toBeGreaterThanOrEqual(0);
  });

  it('records a single noop row when no rule fires', () => {
    const db = openTelemetryDb(tmpRoot)!;
    dispatchPolicy(event(), { rootDir: tmpRoot, rules: [noopAlways], telemetryDb: db, inputHash: 'aabb' });
    closeTelemetryDb(db);
    const rows = readEvents();
    expect(rows.length).toBe(1);
    expect(rows[0].rule).toBeNull();
    expect(rows[0].decision).toBe('noop');
    expect(rows[0].input_hash).toBe('aabb');
  });

  it('does not record a row for a rule that throws (caught + skipped)', () => {
    const db = openTelemetryDb(tmpRoot)!;
    const resp = dispatchPolicy(event(), {
      rootDir: tmpRoot, rules: [throwingRule, allowAlways], telemetryDb: db, inputHash: 'aabb',
    });
    expect(resp.decision).toBe('allow');
    closeTelemetryDb(db);
    const rows = readEvents();
    // exactly one row for allow-always; thrower contributes nothing
    expect(rows.length).toBe(1);
    expect(rows[0].rule).toBe('allow-always');
  });

  it('does not throw when telemetryDb is missing', () => {
    const resp = dispatchPolicy(event(), { rootDir: tmpRoot, rules: [allowAlways] });
    expect(resp.decision).toBe('allow');
  });

  it('records latency in microseconds (sane bound)', () => {
    const db = openTelemetryDb(tmpRoot)!;
    dispatchPolicy(event(), { rootDir: tmpRoot, rules: [allowAlways], telemetryDb: db });
    closeTelemetryDb(db);
    const rows = readEvents();
    expect((rows[0].latency_us as number) < 1_000_000).toBe(true); // <1s
  });
});
```

- [ ] **Step 3: Run test, verify failure**

```
npm run test -- tests/policy-telemetry-dispatcher.test.ts
```
Expected: 5 FAIL ("expected 0 to be 1" etc — dispatcher doesn't write rows yet).

- [ ] **Step 4: Modify `src/policy/dispatcher.ts`**

Replace the entire file body with:

```typescript
import * as path from 'node:path';
import { computeStaleHint } from './stale-hint.js';
import { recordEvent } from './telemetry.js';
import type { PolicyEvent, PolicyResponse, PolicyRule, PolicyContext, QueryEngineLike } from './types.js';
import type Database from 'better-sqlite3';

export interface DispatchOptions {
  rootDir: string;
  rules: readonly PolicyRule[];
  queryEngine?: QueryEngineLike;
  telemetryDb?: Database.Database;
  inputHash?: string;
}

/**
 * Evaluate rules in order. The first rule that returns a decision other than
 * `noop`/`null` wins. `noop` is treated as "rule inspected but abstains" and
 * allows later rules to decide. If no rule decides, the response is `allow`
 * and a single `noop` row is recorded for override correlation.
 *
 * Per-rule evaluation is wrapped in try/catch — a thrown rule cannot break
 * dispatch.
 *
 * Always attaches `stale_hint` — the caller (PreToolUse hook) can downgrade
 * a deny to a warning on stale data if it wishes.
 */
export function dispatchPolicy(event: PolicyEvent, opts: DispatchOptions): PolicyResponse {
  const ctx: PolicyContext = {
    rootDir: opts.rootDir,
    dbPath: path.join(opts.rootDir, '.nexus', 'index.db'),
    ...(opts.queryEngine ? { queryEngine: opts.queryEngine } : {}),
    ...(opts.telemetryDb ? { telemetryDb: opts.telemetryDb } : {}),
    ...(opts.inputHash ? { inputHash: opts.inputHash } : {}),
  };

  const filePath = extractTouchedPath(event, opts.rootDir);

  for (const rule of opts.rules) {
    const t0 = process.hrtime.bigint();
    let decision: ReturnType<PolicyRule['evaluate']> = null;
    try {
      decision = rule.evaluate(event, ctx);
    } catch {
      decision = null;
    }
    const latency_us = Number((process.hrtime.bigint() - t0) / 1000n);

    if (!decision || decision.decision === 'noop') continue;

    recordEvent(opts.telemetryDb ?? null, {
      ts_ms: Date.now(),
      session_id: event.session_id ?? null,
      hook_event: (event.hook_event_name === 'PostToolUse' ? 'PostToolUse' : 'PreToolUse'),
      tool_name: event.tool_name,
      rule: rule.name,
      decision: decision.decision,
      latency_us,
      input_hash: opts.inputHash ?? null,
      file_path: filePath ?? null,
      payload_json: null,
    });

    return {
      decision: decision.decision,
      reason: decision.reason,
      rule: decision.rule,
      ...(decision.additional_context && decision.decision !== 'deny'
        ? { additional_context: decision.additional_context }
        : {}),
      stale_hint: computeStaleHint({
        rootDir: opts.rootDir,
        touchedAbsPath: filePath,
      }),
    };
  }

  // No rule decided — record a noop row keyed on (session_id, input_hash) so
  // V4's override-rate join can detect "the action proceeded."
  recordEvent(opts.telemetryDb ?? null, {
    ts_ms: Date.now(),
    session_id: event.session_id ?? null,
    hook_event: (event.hook_event_name === 'PostToolUse' ? 'PostToolUse' : 'PreToolUse'),
    tool_name: event.tool_name,
    rule: null,
    decision: 'noop',
    latency_us: 0,
    input_hash: opts.inputHash ?? null,
    file_path: filePath ?? null,
    payload_json: null,
  });

  return {
    decision: 'allow',
    stale_hint: computeStaleHint({
      rootDir: opts.rootDir,
      touchedAbsPath: filePath,
    }),
  };
}

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

- [ ] **Step 5: Run telemetry-dispatcher tests + existing dispatcher tests**

```
npm run test -- tests/policy-telemetry-dispatcher.test.ts tests/policy-dispatcher.test.ts
```
Expected: all PASS — existing dispatcher tests continue to pass because behavior is unchanged when telemetryDb is omitted.

- [ ] **Step 6: Run full test sweep**

```
npm run build && npm run test
```
Expected: 770 + 14 store + 14 optout + 6 hash + 5 disp = 809 PASS.

- [ ] **Step 7: Commit**

```bash
git add src/policy/types.ts src/policy/dispatcher.ts tests/policy-telemetry-dispatcher.test.ts
git commit -m "feat(policy): dispatcher telemetry integration (D5)

Per-rule timing, try/catch around rule.evaluate, recordEvent on the
deciding rule, and a single noop row when all rules abstain. Existing
dispatcher tests unaffected — when telemetryDb is omitted, behavior
matches the prior implementation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Policy-entry integration — open/prune/transition/hash/close

**Files:**
- Modify: `src/transports/policy-entry.ts`
- Create: `tests/policy-telemetry-entry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/policy-telemetry-entry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

let tmpRoot: string;
const repoRoot = path.resolve(__dirname, '..');

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-entry-tel-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runEntry(payload: object, env?: Record<string, string>): string {
  const bin = path.join(repoRoot, 'dist', 'transports', 'policy-entry.js');
  const r = execFileSync(process.execPath, [bin], {
    input: JSON.stringify(payload),
    env: { ...process.env, ...(env ?? {}) },
    encoding: 'utf-8',
  });
  return r;
}

function readRows(): Record<string, unknown>[] {
  const dbPath = path.join(tmpRoot, '.nexus', 'telemetry.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT * FROM events ORDER BY id').all() as Record<string, unknown>[];
  db.close();
  return rows;
}

describe('policy-entry telemetry integration', () => {
  it('records a row for a real Pre event', () => {
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/foo.ts' },
      session_id: 'sess-X',
      cwd: tmpRoot,
    });
    const rows = readRows();
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('sess-X');
    expect(typeof rows[0].input_hash).toBe('string');
    expect((rows[0].input_hash as string).length).toBe(16);
  });

  it('does not create telemetry.db when NEXUS_TELEMETRY=0', () => {
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/foo.ts' },
      session_id: 'sess-X',
      cwd: tmpRoot,
    }, { NEXUS_TELEMETRY: '0' });
    expect(fs.existsSync(path.join(tmpRoot, '.nexus', 'telemetry.db'))).toBe(false);
  });

  it('Pre + Post with same input_hash both recorded', () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/foo.ts' },
      session_id: 'sess-Y',
      cwd: tmpRoot,
    };
    runEntry(payload);
    runEntry({ ...payload, hook_event_name: 'PostToolUse' });
    const rows = readRows();
    expect(rows.length).toBe(2);
    expect(rows[0].input_hash).toBe(rows[1].input_hash);
    expect(rows[0].hook_event).toBe('PreToolUse');
    expect(rows[1].hook_event).toBe('PostToolUse');
  });

  it('records opt_out transition when env flips', () => {
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/foo.ts' },
      cwd: tmpRoot,
    });
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/foo.ts' },
      cwd: tmpRoot,
    }, { NEXUS_TELEMETRY: '0' });
    const rows = readRows();
    const optOuts = rows.filter(r => r.hook_event === 'opt_out');
    expect(optOuts.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```
npm run build && npm run test -- tests/policy-telemetry-entry.test.ts
```
Expected: 4 FAIL ("rows.length = 0 expected 1" etc — entry doesn't write rows yet).

- [ ] **Step 3: Modify `src/transports/policy-entry.ts`**

Add imports and rework `main()`:

```typescript
import { openTelemetryDb, closeTelemetryDb, pruneIfDue, recordOptOutTransition } from '../policy/telemetry.js';
import { isTelemetryEnabled, computeInputHash } from '../policy/telemetry-config.js';

// ... existing helpers ...

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

  // Telemetry boundary: detect transition first, then conditionally open + prune.
  const enabled = isTelemetryEnabled(rootDir);
  recordOptOutTransition(rootDir, enabled);
  const telemetryDb = enabled ? openTelemetryDb(rootDir) : null;
  if (telemetryDb) {
    try { pruneIfDue(telemetryDb); } catch { /* swallow */ }
  }
  const inputHash = computeInputHash(event.tool_input);

  const queryEngine = tryOpenEngine(rootDir);

  try {
    const response = dispatchPolicy(event, {
      rootDir,
      rules: DEFAULT_RULES,
      ...(queryEngine ? { queryEngine } : {}),
      ...(telemetryDb ? { telemetryDb } : {}),
      inputHash,
    });
    process.stdout.write(JSON.stringify(response));
  } finally {
    if (telemetryDb) closeTelemetryDb(telemetryDb);
  }
}
```

- [ ] **Step 4: Run telemetry-entry tests**

```
npm run build && npm run test -- tests/policy-telemetry-entry.test.ts
```
Expected: 4 PASS.

- [ ] **Step 5: Run full test sweep**

```
npm run build && npm run test
```
Expected: 809 + 4 = 813 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/transports/policy-entry.ts tests/policy-telemetry-entry.test.ts
git commit -m "feat(policy): policy-entry telemetry boundary (D5)

At process start: detect opt-out transition, open + prune (24h gate),
compute input_hash, thread telemetryDb + inputHash into dispatchPolicy,
close in finally. NEXUS_TELEMETRY=0 short-circuits before any DB I/O.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: CLI `nexus telemetry stats`

**Files:**
- Modify: `src/transports/cli.ts`
- Create: `tests/policy-telemetry-cli.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/policy-telemetry-cli.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

let tmpRoot: string;
const repoRoot = path.resolve(__dirname, '..');
const cliBin = path.join(repoRoot, 'dist', 'transports', 'cli.js');

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-tel-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seed(rows: { ts_ms: number; rule: string | null; decision: string | null; hook_event: string; latency_us: number; session_id?: string; input_hash?: string }[]): void {
  fs.mkdirSync(path.join(tmpRoot, '.nexus'), { recursive: true });
  const dbPath = path.join(tmpRoot, '.nexus', 'telemetry.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL,
      session_id TEXT, hook_event TEXT NOT NULL, tool_name TEXT,
      rule TEXT, decision TEXT, latency_us INTEGER, input_hash TEXT,
      file_path TEXT, payload_json TEXT
    );
    INSERT INTO meta VALUES('schema_version','1');
  `);
  const stmt = db.prepare(`INSERT INTO events
    (ts_ms, session_id, hook_event, tool_name, rule, decision, latency_us, input_hash, file_path, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`);
  for (const r of rows) {
    stmt.run(r.ts_ms, r.session_id ?? null, r.hook_event, 'Read', r.rule, r.decision, r.latency_us, r.input_hash ?? null);
  }
  db.close();
}

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [cliBin, ...args], {
    cwd: tmpRoot,
    encoding: 'utf-8',
  });
}

describe('nexus telemetry stats', () => {
  it('prints "no events" on missing DB', () => {
    const out = runCli(['telemetry', 'stats']);
    expect(out.toLowerCase()).toContain('no events');
  });

  it('prints decision counts by rule', () => {
    const now = Date.now();
    seed([
      { ts_ms: now, hook_event: 'PreToolUse', rule: 'r1', decision: 'allow', latency_us: 100 },
      { ts_ms: now, hook_event: 'PreToolUse', rule: 'r1', decision: 'allow', latency_us: 200 },
      { ts_ms: now, hook_event: 'PreToolUse', rule: 'r1', decision: 'ask', latency_us: 150 },
      { ts_ms: now, hook_event: 'PreToolUse', rule: 'r2', decision: 'deny', latency_us: 50 },
    ]);
    const out = runCli(['telemetry', 'stats']);
    expect(out).toContain('r1');
    expect(out).toContain('r2');
    expect(out).toContain('allow');
    expect(out).toContain('ask');
    expect(out).toContain('deny');
  });

  it('--json emits parseable JSON with rules + opt_outs keys', () => {
    seed([{ ts_ms: Date.now(), hook_event: 'PreToolUse', rule: 'r1', decision: 'allow', latency_us: 100 }]);
    const out = runCli(['telemetry', 'stats', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed.rules).toBeDefined();
    expect(parsed.opt_outs).toBeDefined();
    expect(parsed.since).toBeDefined();
  });

  it('--since=7d filters older rows out', () => {
    const now = Date.now();
    const old = now - 10 * 86400000;
    seed([
      { ts_ms: old, hook_event: 'PreToolUse', rule: 'old', decision: 'allow', latency_us: 1 },
      { ts_ms: now, hook_event: 'PreToolUse', rule: 'new', decision: 'allow', latency_us: 1 },
    ]);
    const out = runCli(['telemetry', 'stats', '--since=7d', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed.rules.old).toBeUndefined();
    expect(parsed.rules.new).toBeDefined();
  });

  it('reports override rate from Pre ask + matching Post', () => {
    const now = Date.now();
    seed([
      { ts_ms: now,     hook_event: 'PreToolUse',  rule: 'r1', decision: 'ask',  latency_us: 1, session_id: 's', input_hash: 'h1' },
      { ts_ms: now+100, hook_event: 'PostToolUse', rule: null, decision: 'noop', latency_us: 1, session_id: 's', input_hash: 'h1' },
      { ts_ms: now,     hook_event: 'PreToolUse',  rule: 'r1', decision: 'ask',  latency_us: 1, session_id: 's', input_hash: 'h2' },
      // h2 has no matching post → not overridden
    ]);
    const out = runCli(['telemetry', 'stats', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed.rules.r1.asks).toBe(2);
    expect(parsed.rules.r1.overrides).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```
npm run build && npm run test -- tests/policy-telemetry-cli.test.ts
```
Expected: 5 FAIL ("unknown command 'telemetry'" or similar).

- [ ] **Step 3: Add `telemetry stats` to `src/transports/cli.ts`**

Locate the program registration block (search for `program.command` near the bottom). Append a new subcommand. First add the implementation function near the formatters:

```typescript
import Database from 'better-sqlite3';

interface TelemetryStats {
  since: string;
  rules: Record<string, {
    events: number;
    decisions: Record<string, number>;
    asks?: number;
    overrides?: number;
    p50_us: number | null;
    p95_us: number | null;
    p99_us: number | null;
  }>;
  opt_outs: { transitions: number };
}

function parseSince(spec: string | undefined): number {
  if (!spec) return 30 * 86400000;
  const m = /^(\d+)([dh])$/.exec(spec);
  if (!m) return 30 * 86400000;
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 3600 * 1000 : n * 86400 * 1000;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function computeTelemetryStats(rootDir: string, sinceSpec: string | undefined): TelemetryStats | null {
  const dbPath = path.join(rootDir, '.nexus', 'telemetry.db');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const since = Date.now() - parseSince(sinceSpec);
    const decisions = db.prepare(`
      SELECT rule, decision, COUNT(*) AS n
      FROM events
      WHERE hook_event='PreToolUse' AND ts_ms > ? AND rule IS NOT NULL
      GROUP BY rule, decision
    `).all(since) as { rule: string; decision: string; n: number }[];

    const overrides = db.prepare(`
      SELECT pre.rule AS rule,
             COUNT(*) AS asks,
             SUM(CASE WHEN post.id IS NOT NULL THEN 1 ELSE 0 END) AS overridden
      FROM events pre
      LEFT JOIN events post
        ON post.session_id = pre.session_id
       AND post.input_hash = pre.input_hash
       AND post.hook_event = 'PostToolUse'
       AND post.ts_ms BETWEEN pre.ts_ms AND pre.ts_ms + 300000
      WHERE pre.hook_event='PreToolUse' AND pre.decision='ask' AND pre.ts_ms > ?
      GROUP BY pre.rule
    `).all(since) as { rule: string; asks: number; overridden: number }[];

    const ruleNames = new Set<string>();
    decisions.forEach(d => ruleNames.add(d.rule));
    overrides.forEach(o => ruleNames.add(o.rule));

    const rules: TelemetryStats['rules'] = {};
    for (const rule of ruleNames) {
      const decs: Record<string, number> = {};
      let total = 0;
      for (const d of decisions.filter(x => x.rule === rule)) {
        decs[d.decision] = d.n;
        total += d.n;
      }
      const lats = db.prepare(`
        SELECT latency_us FROM events
        WHERE rule=? AND latency_us IS NOT NULL AND ts_ms > ?
        ORDER BY latency_us
      `).all(rule, since).map(r => (r as { latency_us: number }).latency_us);
      const ov = overrides.find(o => o.rule === rule);
      rules[rule] = {
        events: total,
        decisions: decs,
        ...(ov ? { asks: ov.asks, overrides: ov.overridden } : {}),
        p50_us: percentile(lats, 50),
        p95_us: percentile(lats, 95),
        p99_us: percentile(lats, 99),
      };
    }

    const optOutRow = db.prepare(`
      SELECT COUNT(*) AS n FROM events
      WHERE hook_event IN ('opt_out','opt_in') AND ts_ms > ?
    `).get(since) as { n: number };

    return {
      since: sinceSpec ?? '30d',
      rules,
      opt_outs: { transitions: optOutRow.n },
    };
  } finally {
    db.close();
  }
}

function formatTelemetryStats(s: TelemetryStats): string {
  const lines: string[] = [];
  lines.push(`telemetry stats — since ${s.since}`);
  lines.push('');
  if (Object.keys(s.rules).length === 0) {
    lines.push('  (no events)');
  } else {
    for (const [rule, info] of Object.entries(s.rules)) {
      lines.push(`  ${rule}`);
      const decs = Object.entries(info.decisions).map(([d, n]) => `${d}=${n}`).join(' ');
      lines.push(`    events: ${info.events}  ${decs}`);
      if (info.asks !== undefined && info.asks > 0) {
        const rate = ((info.overrides ?? 0) / info.asks * 100).toFixed(1);
        lines.push(`    overrides: ${info.overrides}/${info.asks} (${rate}%)`);
      }
      const fmt = (v: number | null) => v === null ? '-' : `${v}us`;
      lines.push(`    latency: p50=${fmt(info.p50_us)} p95=${fmt(info.p95_us)} p99=${fmt(info.p99_us)}`);
    }
  }
  lines.push('');
  lines.push(`  opt_out transitions: ${s.opt_outs.transitions}`);
  return lines.join('\n');
}
```

Then register the subcommand. Find where other subcommands are registered (e.g., `program.command('outline')`) and add:

```typescript
const telemetry = program.command('telemetry').description('Policy telemetry');
telemetry
  .command('stats')
  .description('Print telemetry digest')
  .option('--since <spec>', 'Time window: 30d, 7d, 1h', '30d')
  .option('--json', 'Emit JSON')
  .action((opts: { since?: string; json?: boolean }) => {
    const root = detectRoot(process.cwd());
    const stats = computeTelemetryStats(root, opts.since);
    if (!stats || Object.keys(stats.rules).length === 0) {
      if (opts.json) {
        console.log(JSON.stringify({ since: opts.since ?? '30d', rules: {}, opt_outs: { transitions: 0 } }));
      } else {
        console.log('telemetry stats: no events recorded');
      }
      return;
    }
    if (opts.json) console.log(JSON.stringify(stats));
    else console.log(formatTelemetryStats(stats));
  });
```

- [ ] **Step 4: Run tests**

```
npm run build && npm run test -- tests/policy-telemetry-cli.test.ts -t "stats"
```
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/cli.ts tests/policy-telemetry-cli.test.ts
git commit -m "feat(cli): nexus telemetry stats (D5)

Decision counts, latency p50/p95/p99 per rule, override rate from
Pre/Post correlation (5-min window), opt-out transition count. Plain
text or --json. Time window via --since (30d default).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: CLI `nexus telemetry export`

**Files:**
- Modify: `src/transports/cli.ts`
- Modify: `tests/policy-telemetry-cli.test.ts` (extend)

- [ ] **Step 1: Append failing tests**

```typescript
describe('nexus telemetry export', () => {
  it('emits NDJSON, one row per line', () => {
    const now = Date.now();
    seed([
      { ts_ms: now,   hook_event: 'PreToolUse', rule: 'r1', decision: 'allow', latency_us: 10 },
      { ts_ms: now+1, hook_event: 'PreToolUse', rule: 'r2', decision: 'ask',   latency_us: 20 },
    ]);
    const out = runCli(['telemetry', 'export']);
    const lines = out.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).rule).toBe('r1');
    expect(JSON.parse(lines[1]).rule).toBe('r2');
  });

  it('--format=csv emits header + rows', () => {
    seed([{ ts_ms: Date.now(), hook_event: 'PreToolUse', rule: 'r1', decision: 'allow', latency_us: 10 }]);
    const out = runCli(['telemetry', 'export', '--format=csv']);
    const lines = out.trim().split('\n');
    expect(lines[0]).toContain('rule');
    expect(lines[0]).toContain('decision');
    expect(lines[1]).toContain('r1');
  });

  it('respects --since=1d', () => {
    const now = Date.now();
    seed([
      { ts_ms: now - 3 * 86400000, hook_event: 'PreToolUse', rule: 'old', decision: 'allow', latency_us: 1 },
      { ts_ms: now,                 hook_event: 'PreToolUse', rule: 'new', decision: 'allow', latency_us: 1 },
    ]);
    const out = runCli(['telemetry', 'export', '--since=1d']);
    const lines = out.trim().split('\n');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).rule).toBe('new');
  });

  it('empty DB exits cleanly with no output', () => {
    const out = runCli(['telemetry', 'export']);
    expect(out.trim()).toBe('');
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Expected: 4 FAIL ("unknown command export").

- [ ] **Step 3: Implement `export` subcommand**

Inside `src/transports/cli.ts`, before the `stats` registration block, add a helper:

```typescript
const EXPORT_COLUMNS = [
  'id','ts_ms','session_id','hook_event','tool_name','rule','decision',
  'latency_us','input_hash','file_path','payload_json',
];

function exportTelemetry(rootDir: string, sinceSpec: string | undefined, format: 'ndjson' | 'csv'): void {
  const dbPath = path.join(rootDir, '.nexus', 'telemetry.db');
  if (!fs.existsSync(dbPath)) return;
  const db = new Database(dbPath, { readonly: true });
  try {
    const since = Date.now() - parseSince(sinceSpec);
    const rows = db.prepare(`SELECT * FROM events WHERE ts_ms > ? ORDER BY id`).all(since) as Record<string, unknown>[];
    if (rows.length === 0) return;
    if (format === 'ndjson') {
      for (const r of rows) console.log(JSON.stringify(r));
    } else {
      console.log(EXPORT_COLUMNS.join(','));
      for (const r of rows) {
        console.log(EXPORT_COLUMNS.map(c => csvEscape(r[c])).join(','));
      }
    }
  } finally {
    db.close();
  }
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
```

And register:

```typescript
telemetry
  .command('export')
  .description('Dump events as NDJSON or CSV')
  .option('--since <spec>', 'Time window: 30d, 7d, 1h', '30d')
  .option('--format <fmt>', 'ndjson | csv', 'ndjson')
  .action((opts: { since?: string; format?: string }) => {
    const root = detectRoot(process.cwd());
    const fmt = opts.format === 'csv' ? 'csv' : 'ndjson';
    exportTelemetry(root, opts.since, fmt);
  });
```

- [ ] **Step 4: Run tests**

```
npm run build && npm run test -- tests/policy-telemetry-cli.test.ts -t "export"
```
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/cli.ts tests/policy-telemetry-cli.test.ts
git commit -m "feat(cli): nexus telemetry export (D5)

NDJSON (default) or CSV; --since filtering. Empty DB → no output, exit 0.
CSV escapes embedded quotes and newlines.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: CLI `nexus telemetry purge`

**Files:**
- Modify: `src/transports/cli.ts`
- Modify: `tests/policy-telemetry-cli.test.ts` (extend)

- [ ] **Step 1: Append failing tests**

```typescript
describe('nexus telemetry purge', () => {
  it('--yes deletes telemetry.db', () => {
    seed([{ ts_ms: Date.now(), hook_event: 'PreToolUse', rule: 'r1', decision: 'allow', latency_us: 1 }]);
    expect(fs.existsSync(path.join(tmpRoot, '.nexus', 'telemetry.db'))).toBe(true);
    runCli(['telemetry', 'purge', '--yes']);
    expect(fs.existsSync(path.join(tmpRoot, '.nexus', 'telemetry.db'))).toBe(false);
  });

  it('without --yes prints a confirmation prompt and does not delete', () => {
    seed([{ ts_ms: Date.now(), hook_event: 'PreToolUse', rule: 'r1', decision: 'allow', latency_us: 1 }]);
    const out = runCli(['telemetry', 'purge']);
    expect(out.toLowerCase()).toContain('--yes');
    expect(fs.existsSync(path.join(tmpRoot, '.nexus', 'telemetry.db'))).toBe(true);
  });

  it('on missing DB, --yes exits cleanly', () => {
    runCli(['telemetry', 'purge', '--yes']); // should not throw
    expect(fs.existsSync(path.join(tmpRoot, '.nexus', 'telemetry.db'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Expected: 3 FAIL.

- [ ] **Step 3: Register `purge` subcommand**

```typescript
telemetry
  .command('purge')
  .description('Delete .nexus/telemetry.db')
  .option('--yes', 'Confirm deletion (required)')
  .action((opts: { yes?: boolean }) => {
    const root = detectRoot(process.cwd());
    const dbPath = path.join(root, '.nexus', 'telemetry.db');
    if (!opts.yes) {
      console.log('telemetry purge: re-run with --yes to confirm.');
      return;
    }
    try {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        // also clean up WAL/SHM siblings
        for (const ext of ['-wal','-shm']) {
          const p = dbPath + ext;
          if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* ignore */ }
        }
      }
    } catch {
      /* ignore */
    }
  });
```

- [ ] **Step 4: Run tests**

```
npm run build && npm run test -- tests/policy-telemetry-cli.test.ts -t "purge"
```
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/cli.ts tests/policy-telemetry-cli.test.ts
git commit -m "feat(cli): nexus telemetry purge (D5)

Requires --yes; cleans up WAL/SHM siblings. Empty DB → no-op exit 0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Integration test — Pre→Post override flow

**Files:**
- Create: `tests/policy-telemetry-integration.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
// tests/policy-telemetry-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

let tmpRoot: string;
const repoRoot = path.resolve(__dirname, '..');
const entryBin = path.join(repoRoot, 'dist', 'transports', 'policy-entry.js');
const cliBin = path.join(repoRoot, 'dist', 'transports', 'cli.js');

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-int-tel-'));
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{"name":"x"}');
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runEntry(payload: object): void {
  execFileSync(process.execPath, [entryBin], {
    input: JSON.stringify(payload), encoding: 'utf-8',
  });
}

function runStatsJson(): { rules: Record<string, { asks?: number; overrides?: number }> } {
  const out = execFileSync(process.execPath, [cliBin, 'telemetry', 'stats', '--json'], {
    cwd: tmpRoot, encoding: 'utf-8',
  });
  return JSON.parse(out);
}

describe('telemetry override correlation end-to-end', () => {
  it('Pre ask + matching Post → counted as override', () => {
    const payload = (hook: string) => ({
      hook_event_name: hook,
      tool_name: 'Read',
      tool_input: { file_path: 'package.json' }, // triggers read-on-structured: ask
      session_id: 'sess-OV',
      cwd: tmpRoot,
    });
    runEntry(payload('PreToolUse'));
    runEntry(payload('PostToolUse'));
    const stats = runStatsJson();
    expect(stats.rules['read-on-structured'].asks).toBe(1);
    expect(stats.rules['read-on-structured'].overrides).toBe(1);
  });

  it('Pre ask without Post → not overridden', () => {
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'package.json' },
      session_id: 'sess-NO',
      cwd: tmpRoot,
    });
    const stats = runStatsJson();
    expect(stats.rules['read-on-structured'].asks).toBe(1);
    expect(stats.rules['read-on-structured'].overrides).toBe(0);
  });

  it('Pre/Post in different sessions → not overridden', () => {
    runEntry({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'package.json' },
      session_id: 'sess-A',
      cwd: tmpRoot,
    });
    runEntry({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'package.json' },
      session_id: 'sess-B',
      cwd: tmpRoot,
    });
    const stats = runStatsJson();
    expect(stats.rules['read-on-structured'].asks).toBe(1);
    expect(stats.rules['read-on-structured'].overrides).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

```
npm run build && npm run test -- tests/policy-telemetry-integration.test.ts
```
Expected: 3 PASS.

If `read-on-structured` doesn't fire because of file-classification, the test will need to use a different ask-emitting trigger. Verify by inspecting what stats emit:

```
node dist/transports/cli.js telemetry stats --json
```

If you see no `read-on-structured` entry, switch the file path to something that classifies as a lockfile (`yarn.lock`) or another structured kind.

- [ ] **Step 3: Commit**

```bash
git add tests/policy-telemetry-integration.test.ts
git commit -m "test(policy): D5 telemetry Pre→Post override integration

End-to-end: real nexus-policy-check + real nexus telemetry stats.
Covers happy override, unmatched ask, cross-session non-match.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Docs — CHANGELOG + CLAUDE.md + roadmap

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`
- Modify: `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md`

- [ ] **Step 1: Update `CHANGELOG.md`**

Prepend a new section under the latest unreleased / version heading:

```markdown
## D5 v1 — Telemetry — 2026-04-25

- New `.nexus/telemetry.db` (SQLite, separate from index DB) records every
  policy event with rule, decision, latency, session_id, and a canonical
  hash of `tool_input`.
- Override correlation: PreToolUse `ask` rows joined to PostToolUse rows on
  `(session_id, input_hash)` within a 5-minute window.
- Retention: drop rows older than 30 days, keep newest 100,000. Pruned on
  policy-entry startup, gated to once per 24h.
- Opt-out: `NEXUS_TELEMETRY=0|false` env var (highest priority) or
  `.nexus.json {"telemetry": false}`. Default: enabled. Transitions
  recorded as `opt_out`/`opt_in` events.
- New CLI: `nexus telemetry stats|export|purge` (no MCP tool in v1).
```

- [ ] **Step 2: Update `CLAUDE.md`**

Find the "Policy transport" / shipped rules block. Add a new subsection:

```markdown
**Telemetry (D5):** every policy event is recorded to `.nexus/telemetry.db`
(decision, rule, latency, session_id, canonical input_hash). Disabled via
`NEXUS_TELEMETRY=0` or `.nexus.json {"telemetry": false}`; transitions are
themselves logged. Retention: 30 days OR 100k rows, pruned at startup
(24h gate). CLI: `nexus telemetry stats|export|purge`.
```

- [ ] **Step 3: Update the roadmap doc**

Edit `C:/Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md`:

Find the line:
```
- **D5 telemetry** — `.nexus/telemetry.db`, gated on retention/opt-out design.
```

Replace with:
```
- **D5 telemetry — SHIPPED 2026-04-25** — `.nexus/telemetry.db` (separate
  from index DB), 30d/100k retention, opt-out via `NEXUS_TELEMETRY=0` or
  `.nexus.json {"telemetry":false}`. CLI: `nexus telemetry stats|export|purge`.
  Records latency, decisions, override correlation (session_id +
  input_hash), and opt-in/out transitions. Closes V3 metrics-gate
  prerequisite.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: D5 v1 telemetry shipped

CHANGELOG entry; CLAUDE.md notes the new CLI surface and opt-out path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(The roadmap file lives outside the repo; commit it separately or note that
it's a global plans-dir update with no git tracking.)

---

### Task 15: Final verification + smoke test

**Files:** None (verification only).

- [ ] **Step 1: Full clean build + test sweep**

```
npm run build && npm run lint && npm run test
```
Expected: exit 0; ~822 PASS (770 baseline + 14 store + 14 optout + 6 hash + 5 disp + 4 entry + 12 cli + 3 integration).

Adjust the count if a few CLI/integration tests merge into one another — the goal is "no regressions, all D5 tests green."

- [ ] **Step 2: Hot-path smoke test**

```bash
mkdir -p /tmp/d5-smoke && cd /tmp/d5-smoke
echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"src/foo.ts"},"session_id":"smoke","cwd":"/tmp/d5-smoke"}' \
  | node "C:/Claude Code/Nexus/.claude/worktrees/d5-telemetry/dist/transports/policy-entry.js"
ls -la .nexus/
node "C:/Claude Code/Nexus/.claude/worktrees/d5-telemetry/dist/transports/cli.js" telemetry stats
```
Expected: `.nexus/telemetry.db` exists; `stats` shows at least one row recorded.

- [ ] **Step 3: Opt-out smoke test**

```bash
NEXUS_TELEMETRY=0 echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"src/x.ts"},"cwd":"/tmp/d5-smoke"}' \
  | node "C:/Claude Code/Nexus/.claude/worktrees/d5-telemetry/dist/transports/policy-entry.js"
node "C:/Claude Code/Nexus/.claude/worktrees/d5-telemetry/dist/transports/cli.js" telemetry stats --json | python -c "import json,sys; d=json.load(sys.stdin); print('opt_outs:', d['opt_outs']['transitions'])"
```
Expected: opt_outs count is 1 (we transitioned from enabled→disabled for this run).

- [ ] **Step 4: Confirm no missing exports / lint errors**

```
npm run lint
```
Expected: exit 0.

- [ ] **Step 5: Push branch + open PR**

(Defer until user confirms — this plan does not push by default.)

---

## Self-Review Checklist (executed during plan-write)

**Spec coverage:**
- ✓ Goal — D5 captures latency / decisions / override / opt-out (Tasks 2-9)
- ✓ Architecture — separate DB, lazy init, dispatcher integration (Tasks 2-8)
- ✓ Components — telemetry.ts, telemetry-config.ts, dispatcher mods, entry mods (Tasks 2-9)
- ✓ Schema (events + meta + indexes) — Task 2
- ✓ Retention (30d/100k/24h-gate) — Task 4
- ✓ Override SQL — Task 10 stats query
- ✓ Opt-out semantics + env precedence — Tasks 5, 6
- ✓ CLI surface — Tasks 10-12
- ✓ Error handling (swallow + corrupt-recover) — Tasks 2, 3, 4
- ✓ Test files (~40 cases across 7 files) — Tasks 2-13

**Placeholder scan:** none in tasks (every step has concrete code).

**Type consistency:** `TelemetryEvent`, `recordEvent`, `openTelemetryDb`,
`pruneIfDue`, `recordOptOutTransition`, `closeTelemetryDb`,
`isTelemetryEnabled`, `computeInputHash` — all match between definitions and
call sites. `DispatchOptions` widening matches `PolicyContext` widening (both
add `telemetryDb` and `inputHash` of the same types).
