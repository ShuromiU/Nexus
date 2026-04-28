import type Database from 'better-sqlite3';

export const DEFAULT_THRESHOLDS: GateThresholds = {
  p50_us: 50_000,
  p95_us: 150_000,
  override_rate: 0.10,
  min_events_per_rule: 30,
};

export interface GateThresholds {
  p50_us: number;
  p95_us: number;
  override_rate: number;
  min_events_per_rule: number;
}

export type Verdict = 'pass' | 'warn' | 'fail' | 'insufficient_data';

export interface RuleGateReport {
  events: number;
  decisions: Record<string, number>;
  latency: {
    p50_us: number | null;
    p95_us: number | null;
    p99_us: number | null;
    p50_pass: boolean | null;
    p95_pass: boolean | null;
  };
  overrides: {
    asks: number;
    overridden: number;
    rate: number;
    pass: boolean;
  } | null;
  verdict: Verdict;
}

export interface MetricsGateReport {
  since: string;
  since_ms: number;
  thresholds: GateThresholds;
  total_events: number;
  rules: Record<string, RuleGateReport>;
  overall: {
    verdict: Verdict;
    failing_rules: string[];
    warning_rules: string[];
  };
  opt_outs: { transitions: number };
}

interface DecisionRow { rule: string; decision: string; n: number }
interface OverrideRow { rule: string; asks: number; overridden: number }
interface LatencyRow { latency_us: number }

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function ruleVerdict(report: RuleGateReport, thresholds: GateThresholds): Verdict {
  if (report.events < thresholds.min_events_per_rule) return 'insufficient_data';
  if (report.overrides !== null && !report.overrides.pass) return 'fail';
  const { p50_pass, p95_pass } = report.latency;
  if (p50_pass === false || p95_pass === false) return 'warn';
  return 'pass';
}

export function computeMetricsGate(
  db: Database.Database,
  opts: { sinceMs: number; sinceLabel: string; thresholds?: Partial<GateThresholds> },
): MetricsGateReport {
  const thresholds: GateThresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const since = Date.now() - opts.sinceMs;

  const decisions = db.prepare(`
    SELECT rule, decision, COUNT(*) AS n
    FROM events
    WHERE hook_event='PreToolUse' AND ts_ms > ? AND rule IS NOT NULL
    GROUP BY rule, decision
  `).all(since) as DecisionRow[];

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
  `).all(since) as OverrideRow[];

  const ruleNames = new Set<string>();
  decisions.forEach(d => ruleNames.add(d.rule));
  overrides.forEach(o => ruleNames.add(o.rule));

  const rules: Record<string, RuleGateReport> = {};
  let totalEvents = 0;

  for (const rule of ruleNames) {
    const decs: Record<string, number> = {};
    let events = 0;
    for (const d of decisions.filter(x => x.rule === rule)) {
      decs[d.decision] = d.n;
      events += d.n;
    }
    totalEvents += events;

    const lats = (db.prepare(`
      SELECT latency_us FROM events
      WHERE rule=? AND latency_us IS NOT NULL AND ts_ms > ?
      ORDER BY latency_us
    `).all(rule, since) as LatencyRow[]).map(r => r.latency_us);

    const p50 = percentile(lats, 50);
    const p95 = percentile(lats, 95);
    const p99 = percentile(lats, 99);

    const ov = overrides.find(o => o.rule === rule);
    const overridesReport = ov && ov.asks > 0
      ? {
          asks: ov.asks,
          overridden: ov.overridden,
          rate: ov.overridden / ov.asks,
          pass: ov.overridden / ov.asks <= thresholds.override_rate,
        }
      : null;

    const report: RuleGateReport = {
      events,
      decisions: decs,
      latency: {
        p50_us: p50,
        p95_us: p95,
        p99_us: p99,
        p50_pass: p50 === null ? null : p50 <= thresholds.p50_us,
        p95_pass: p95 === null ? null : p95 <= thresholds.p95_us,
      },
      overrides: overridesReport,
      verdict: 'insufficient_data',
    };
    report.verdict = ruleVerdict(report, thresholds);
    rules[rule] = report;
  }

  const failing_rules: string[] = [];
  const warning_rules: string[] = [];
  let anyData = false;
  for (const [name, r] of Object.entries(rules)) {
    if (r.verdict === 'fail') failing_rules.push(name);
    else if (r.verdict === 'warn') warning_rules.push(name);
    if (r.verdict !== 'insufficient_data') anyData = true;
  }

  let overallVerdict: Verdict;
  if (failing_rules.length > 0) overallVerdict = 'fail';
  else if (!anyData) overallVerdict = 'insufficient_data';
  else if (warning_rules.length > 0) overallVerdict = 'warn';
  else overallVerdict = 'pass';

  const optOutRow = db.prepare(`
    SELECT COUNT(*) AS n FROM events
    WHERE hook_event IN ('opt_out','opt_in') AND ts_ms > ?
  `).get(since) as { n: number };

  return {
    since: opts.sinceLabel,
    since_ms: opts.sinceMs,
    thresholds,
    total_events: totalEvents,
    rules,
    overall: { verdict: overallVerdict, failing_rules, warning_rules },
    opt_outs: { transitions: optOutRow.n },
  };
}

function fmtUs(v: number | null): string {
  if (v === null) return '-';
  if (v < 1000) return `${v}us`;
  return `${(v / 1000).toFixed(1)}ms`;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function verdictTag(v: Verdict): string {
  switch (v) {
    case 'pass': return 'PASS';
    case 'warn': return 'WARN';
    case 'fail': return 'FAIL';
    case 'insufficient_data': return 'N/A ';
  }
}

export function formatMetricsGate(r: MetricsGateReport): string {
  const lines: string[] = [];
  lines.push(`telemetry analyze — since ${r.since}  (events=${r.total_events})`);
  lines.push('');
  lines.push(`thresholds: p50<=${fmtUs(r.thresholds.p50_us)}, p95<=${fmtUs(r.thresholds.p95_us)}, override_rate<=${fmtPct(r.thresholds.override_rate)}, min_events_per_rule=${r.thresholds.min_events_per_rule}`);
  lines.push('');

  if (Object.keys(r.rules).length === 0) {
    lines.push('  (no rule events)');
  } else {
    for (const [name, info] of Object.entries(r.rules)) {
      lines.push(`  [${verdictTag(info.verdict)}] ${name}  (events=${info.events})`);
      const decs = Object.entries(info.decisions).map(([d, n]) => `${d}=${n}`).join(' ');
      if (decs) lines.push(`    decisions: ${decs}`);
      const { p50_us, p95_us, p99_us, p50_pass, p95_pass } = info.latency;
      const p50Tag = p50_pass === false ? ' [over]' : '';
      const p95Tag = p95_pass === false ? ' [over]' : '';
      lines.push(`    latency:  p50=${fmtUs(p50_us)}${p50Tag}  p95=${fmtUs(p95_us)}${p95Tag}  p99=${fmtUs(p99_us)}`);
      if (info.overrides) {
        const tag = info.overrides.pass ? '' : ' [over]';
        lines.push(`    override: ${info.overrides.overridden}/${info.overrides.asks} = ${fmtPct(info.overrides.rate)}${tag}`);
      }
    }
  }

  lines.push('');
  lines.push(`overall: ${verdictTag(r.overall.verdict)}`);
  if (r.overall.failing_rules.length > 0) {
    lines.push(`  failing: ${r.overall.failing_rules.join(', ')}`);
  }
  if (r.overall.warning_rules.length > 0) {
    lines.push(`  warnings: ${r.overall.warning_rules.join(', ')}`);
  }
  lines.push(`  opt_out transitions: ${r.opt_outs.transitions}`);
  return lines.join('\n');
}
