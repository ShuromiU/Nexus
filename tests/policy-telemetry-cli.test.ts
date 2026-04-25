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

interface SeedRow {
  ts_ms: number;
  rule: string | null;
  decision: string | null;
  hook_event: string;
  latency_us: number;
  session_id?: string;
  input_hash?: string;
}

function seed(rows: SeedRow[]): void {
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
    ]);
    const out = runCli(['telemetry', 'stats', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed.rules.r1.asks).toBe(2);
    expect(parsed.rules.r1.overrides).toBe(1);
  });
});

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
    runCli(['telemetry', 'purge', '--yes']);
    expect(fs.existsSync(path.join(tmpRoot, '.nexus', 'telemetry.db'))).toBe(false);
  });
});
