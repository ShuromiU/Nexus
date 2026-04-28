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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-analyze-'));
});
afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface SeedRow {
  ts_ms: number;
  rule: string | null;
  decision: string | null;
  hook_event: string;
  latency_us: number | null;
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
    VALUES (?, ?, ?, 'Read', ?, ?, ?, ?, NULL, NULL)`);
  for (const r of rows) {
    stmt.run(r.ts_ms, r.session_id ?? null, r.hook_event, r.rule, r.decision, r.latency_us, r.input_hash ?? null);
  }
  db.close();
}

interface CliResult { stdout: string; status: number }
function runCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [cliBin, ...args], {
      cwd: tmpRoot,
      encoding: 'utf-8',
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; status?: number };
    const stdout = typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString('utf-8') ?? '');
    return { stdout, status: err.status ?? 1 };
  }
}

describe('nexus telemetry analyze', () => {
  it('reports "no telemetry" on missing DB', () => {
    const { stdout, status } = runCli(['telemetry', 'analyze']);
    expect(stdout.toLowerCase()).toContain('no telemetry');
    expect(status).toBe(0);
  });

  it('--json on missing DB returns insufficient_data envelope', () => {
    const { stdout } = runCli(['telemetry', 'analyze', '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.overall.verdict).toBe('insufficient_data');
    expect(parsed.thresholds.p50_us).toBe(50_000);
    expect(parsed.thresholds.override_rate).toBeCloseTo(0.10);
    expect(parsed.rules).toEqual({});
  });

  it('--json reports per-rule verdicts and overall pass', () => {
    const now = Date.now();
    const rows: SeedRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ ts_ms: now, hook_event: 'PreToolUse', rule: 'r1', decision: 'allow', latency_us: 1_000 });
    }
    seed(rows);
    const { stdout, status } = runCli(['telemetry', 'analyze', '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.rules.r1.verdict).toBe('pass');
    expect(parsed.overall.verdict).toBe('pass');
    expect(status).toBe(0);
  });

  it('exits non-zero when overall verdict is fail', () => {
    const now = Date.now();
    const rows: SeedRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ ts_ms: now, hook_event: 'PreToolUse', rule: 'red', decision: 'ask', latency_us: 1_000, session_id: 's', input_hash: `h${i}` });
      if (i < 10) {
        rows.push({ ts_ms: now + 100, hook_event: 'PostToolUse', rule: null, decision: 'noop', latency_us: null, session_id: 's', input_hash: `h${i}` });
      }
    }
    seed(rows);
    const { stdout, status } = runCli(['telemetry', 'analyze']);
    expect(stdout).toContain('FAIL');
    expect(stdout).toContain('failing: red');
    expect(status).toBe(1);
  });

  it('--strict makes warn exit non-zero', () => {
    const now = Date.now();
    const rows: SeedRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ ts_ms: now, hook_event: 'PreToolUse', rule: 'slow', decision: 'allow', latency_us: 60_000 });
    }
    seed(rows);
    const lax = runCli(['telemetry', 'analyze']);
    expect(lax.status).toBe(0);
    expect(lax.stdout).toContain('WARN');

    const strict = runCli(['telemetry', 'analyze', '--strict']);
    expect(strict.status).toBe(1);
  });

  it('--p50-us override changes the verdict', () => {
    const now = Date.now();
    const rows: SeedRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ ts_ms: now, hook_event: 'PreToolUse', rule: 'r1', decision: 'allow', latency_us: 60_000 });
    }
    seed(rows);
    const tight = runCli(['telemetry', 'analyze', '--json']);
    expect(JSON.parse(tight.stdout).rules.r1.verdict).toBe('warn');

    const loose = runCli(['telemetry', 'analyze', '--p50-us', '100000', '--json']);
    expect(JSON.parse(loose.stdout).rules.r1.verdict).toBe('pass');
  });

  it('--since=7d filters older rows', () => {
    const now = Date.now();
    const rows: SeedRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ ts_ms: now - 10 * 86400000, hook_event: 'PreToolUse', rule: 'old', decision: 'allow', latency_us: 1_000 });
      rows.push({ ts_ms: now,                  hook_event: 'PreToolUse', rule: 'new', decision: 'allow', latency_us: 1_000 });
    }
    seed(rows);
    const { stdout } = runCli(['telemetry', 'analyze', '--since=7d', '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.rules.old).toBeUndefined();
    expect(parsed.rules.new).toBeDefined();
  });
});
