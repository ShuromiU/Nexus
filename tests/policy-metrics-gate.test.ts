import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  computeMetricsGate,
  formatMetricsGate,
  DEFAULT_THRESHOLDS,
} from '../src/policy/metrics-gate.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
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
});
afterEach(() => { db.close(); });

interface Row {
  ts_ms: number;
  rule: string | null;
  decision: string | null;
  hook_event: string;
  latency_us: number | null;
  session_id?: string;
  input_hash?: string;
}

function seed(rows: Row[]): void {
  const stmt = db.prepare(`INSERT INTO events
    (ts_ms, session_id, hook_event, tool_name, rule, decision, latency_us, input_hash, file_path, payload_json)
    VALUES (?, ?, ?, 'Read', ?, ?, ?, ?, NULL, NULL)`);
  for (const r of rows) {
    stmt.run(r.ts_ms, r.session_id ?? null, r.hook_event, r.rule, r.decision, r.latency_us, r.input_hash ?? null);
  }
}

const DAY = 86400000;

function pre(rule: string, decision: string, latency_us: number, opts: { ts_ms?: number; session_id?: string; input_hash?: string } = {}): Row {
  return {
    ts_ms: opts.ts_ms ?? Date.now(),
    rule, decision, hook_event: 'PreToolUse', latency_us,
    session_id: opts.session_id, input_hash: opts.input_hash,
  };
}
function post(session_id: string, input_hash: string, opts: { ts_ms?: number } = {}): Row {
  return {
    ts_ms: opts.ts_ms ?? Date.now() + 100,
    rule: null, decision: 'noop', hook_event: 'PostToolUse', latency_us: null,
    session_id, input_hash,
  };
}

describe('computeMetricsGate — empty input', () => {
  it('returns insufficient_data on empty DB', () => {
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.overall.verdict).toBe('insufficient_data');
    expect(r.total_events).toBe(0);
    expect(Object.keys(r.rules)).toEqual([]);
  });

  it('echoes the since label', () => {
    const r = computeMetricsGate(db, { sinceMs: 7 * DAY, sinceLabel: '7d' });
    expect(r.since).toBe('7d');
    expect(r.since_ms).toBe(7 * DAY);
  });

  it('exposes the resolved thresholds (defaults)', () => {
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it('lets the caller override individual thresholds', () => {
    const r = computeMetricsGate(db, {
      sinceMs: 30 * DAY, sinceLabel: '30d',
      thresholds: { p95_us: 200_000 },
    });
    expect(r.thresholds.p95_us).toBe(200_000);
    expect(r.thresholds.p50_us).toBe(DEFAULT_THRESHOLDS.p50_us);
  });
});

describe('computeMetricsGate — rule verdict logic', () => {
  it('pass: events>=min, latency under, no override breach', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) rows.push(pre('r1', 'allow', 1_000));
    seed(rows);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.rules.r1.verdict).toBe('pass');
    expect(r.rules.r1.events).toBe(30);
    expect(r.rules.r1.latency.p50_pass).toBe(true);
    expect(r.rules.r1.latency.p95_pass).toBe(true);
  });

  it('insufficient_data: below min_events_per_rule', () => {
    seed([pre('r1', 'allow', 1_000), pre('r1', 'allow', 1_000)]);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.rules.r1.verdict).toBe('insufficient_data');
  });

  it('insufficient_data overridden by lower threshold', () => {
    seed([pre('r1', 'allow', 1_000), pre('r1', 'allow', 1_000)]);
    const r = computeMetricsGate(db, {
      sinceMs: 30 * DAY, sinceLabel: '30d',
      thresholds: { min_events_per_rule: 1 },
    });
    expect(r.rules.r1.verdict).toBe('pass');
  });

  it('warn: latency p50 over threshold but no override breach', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) rows.push(pre('r1', 'allow', 60_000));
    seed(rows);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.rules.r1.verdict).toBe('warn');
    expect(r.rules.r1.latency.p50_pass).toBe(false);
  });

  it('warn: latency p95 over threshold (p50 ok)', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) {
      const lat = i < 27 ? 1_000 : 200_000;
      rows.push(pre('r1', 'allow', lat));
    }
    seed(rows);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.rules.r1.latency.p50_pass).toBe(true);
    expect(r.rules.r1.latency.p95_pass).toBe(false);
    expect(r.rules.r1.verdict).toBe('warn');
  });

  it('fail: override rate above threshold blocks even with green latency', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(pre('r1', 'ask', 1_000, { session_id: 's', input_hash: `h${i}` }));
      if (i < 6) rows.push(post('s', `h${i}`));
    }
    seed(rows);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.rules.r1.overrides?.asks).toBe(30);
    expect(r.rules.r1.overrides?.overridden).toBe(6);
    expect(r.rules.r1.overrides?.rate).toBeCloseTo(0.20);
    expect(r.rules.r1.overrides?.pass).toBe(false);
    expect(r.rules.r1.verdict).toBe('fail');
  });

  it('override rate at exactly threshold passes', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(pre('r1', 'ask', 1_000, { session_id: 's', input_hash: `h${i}` }));
      if (i < 3) rows.push(post('s', `h${i}`));
    }
    seed(rows);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.rules.r1.overrides?.rate).toBeCloseTo(0.10);
    expect(r.rules.r1.overrides?.pass).toBe(true);
    expect(r.rules.r1.verdict).toBe('pass');
  });

  it('overrides null when there are no asks', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) rows.push(pre('r1', 'allow', 1_000));
    seed(rows);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.rules.r1.overrides).toBeNull();
  });
});

describe('computeMetricsGate — overall verdict + filtering', () => {
  it('overall fail: any rule fails', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) rows.push(pre('green', 'allow', 1_000));
    for (let i = 0; i < 30; i++) {
      rows.push(pre('red', 'ask', 1_000, { session_id: 's', input_hash: `r${i}` }));
      if (i < 10) rows.push(post('s', `r${i}`));
    }
    seed(rows);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.overall.verdict).toBe('fail');
    expect(r.overall.failing_rules).toEqual(['red']);
  });

  it('overall warn: warns but no fails', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) rows.push(pre('green', 'allow', 1_000));
    for (let i = 0; i < 30; i++) rows.push(pre('slow', 'allow', 60_000));
    seed(rows);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.overall.verdict).toBe('warn');
    expect(r.overall.warning_rules).toEqual(['slow']);
    expect(r.overall.failing_rules).toEqual([]);
  });

  it('overall pass: all rules pass', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) rows.push(pre('a', 'allow', 1_000));
    for (let i = 0; i < 30; i++) rows.push(pre('b', 'allow', 2_000));
    seed(rows);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.overall.verdict).toBe('pass');
  });

  it('filters by sinceMs', () => {
    const now = Date.now();
    seed([
      pre('old', 'allow', 1_000, { ts_ms: now - 10 * DAY }),
      pre('new', 'allow', 1_000, { ts_ms: now }),
    ]);
    const r = computeMetricsGate(db, { sinceMs: 7 * DAY, sinceLabel: '7d' });
    expect(r.rules.old).toBeUndefined();
    expect(r.rules.new).toBeDefined();
  });

  it('counts opt_out transitions in window', () => {
    seed([
      { ts_ms: Date.now(), rule: null, decision: null, hook_event: 'opt_out', latency_us: null },
      { ts_ms: Date.now(), rule: null, decision: null, hook_event: 'opt_in',  latency_us: null },
    ]);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    expect(r.opt_outs.transitions).toBe(2);
  });
});

describe('formatMetricsGate', () => {
  it('renders verdict tags + thresholds + per-rule breakdown', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(pre('preedit-impact', 'ask', 60_000, { session_id: 's', input_hash: `h${i}` }));
      if (i < 5) rows.push(post('s', `h${i}`));
    }
    seed(rows);
    const r = computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' });
    const out = formatMetricsGate(r);
    expect(out).toContain('telemetry analyze');
    expect(out).toContain('30d');
    expect(out).toContain('preedit-impact');
    expect(out).toContain('thresholds:');
    expect(out).toContain('p50<=50.0ms');
    expect(out).toContain('override_rate<=10.0%');
    expect(out).toContain('overall:');
  });

  it('reports "(no rule events)" when there are no rule rows', () => {
    const out = formatMetricsGate(
      computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' }),
    );
    expect(out).toContain('(no rule events)');
  });

  it('marks failing rules in the overall summary', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(pre('redrule', 'ask', 1_000, { session_id: 's', input_hash: `h${i}` }));
      if (i < 10) rows.push(post('s', `h${i}`));
    }
    seed(rows);
    const out = formatMetricsGate(
      computeMetricsGate(db, { sinceMs: 30 * DAY, sinceLabel: '30d' }),
    );
    expect(out).toContain('FAIL');
    expect(out).toContain('failing: redrule');
  });
});
