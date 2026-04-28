import type Database from 'better-sqlite3';

/**
 * Pack-utilization analyzer (D4 v2 / D1 gate).
 *
 * Reads `pack_runs` from `.nexus/telemetry.db` and emits a verdict on
 * whether `nexus_pack` alone is sufficient for the project's typical
 * queries. The roadmap explicitly gates D1 (`nexus_next`) on this
 * signal: D1 ships only if pack proves insufficient.
 *
 * Verdict vocabulary (mirrors the policy metrics gate but inverted in
 * intent — here "fail" means "pack is failing, so D1 is justified"):
 *
 *   - pass:  pack is sufficient — no D1 needed
 *   - warn:  pack is constrained — D1 deserves consideration
 *   - fail:  pack saturates frequently — D1 is justified
 *   - insufficient_data: not enough pack runs to decide
 */

export const DEFAULT_PACK_THRESHOLDS: PackGateThresholds = {
  hit_budget_warn: 0.20,
  hit_budget_fail: 0.40,
  avg_util_warn: 0.85,
  avg_util_fail: 0.90,
  min_runs: 30,
};

export interface PackGateThresholds {
  /** Hit-budget rate that triggers `warn`. Range 0..1. */
  hit_budget_warn: number;
  /** Hit-budget rate that triggers `fail`. */
  hit_budget_fail: number;
  /** Average utilization that triggers `warn`. */
  avg_util_warn: number;
  /** Average utilization that triggers `fail`. */
  avg_util_fail: number;
  /** Below this many pack runs in the window we say `insufficient_data`. */
  min_runs: number;
}

export type PackVerdict = 'pass' | 'warn' | 'fail' | 'insufficient_data';

export interface PackGateReport {
  since: string;
  since_ms: number;
  thresholds: PackGateThresholds;
  total_runs: number;
  /** Sum of `total_tokens` across all runs. */
  total_tokens_used: number;
  /** Sum of `budget_tokens` across all runs. */
  total_budget_allocated: number;
  /** Mean `total_tokens / budget_tokens` (NaN-safe — zero budgets ignored). */
  avg_utilization: number;
  /** Runs where `total_tokens >= budget_tokens`. */
  hit_budget_count: number;
  /** Fraction of runs that hit budget. Equals `hit_budget_count / total_runs`. */
  hit_budget_rate: number;
  /** Mean `skipped_count` across all runs. */
  avg_skipped: number;
  /** Latency stats for pack itself (ms). */
  latency: {
    p50_ms: number | null;
    p95_ms: number | null;
    p99_ms: number | null;
  };
  verdict: PackVerdict;
  /** Human-readable reasons that drove the verdict. */
  reasons: string[];
}

interface PackRow {
  budget_tokens: number;
  total_tokens: number;
  skipped_count: number;
  timing_ms: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function classify(report: PackGateReport, t: PackGateThresholds): { verdict: PackVerdict; reasons: string[] } {
  if (report.total_runs < t.min_runs) {
    return {
      verdict: 'insufficient_data',
      reasons: [`only ${report.total_runs} pack runs (need >= ${t.min_runs})`],
    };
  }
  const reasons: string[] = [];
  let level: PackVerdict = 'pass';
  const bump = (next: PackVerdict): void => {
    if (next === 'fail') level = 'fail';
    else if (next === 'warn' && level !== 'fail') level = 'warn';
  };
  if (report.hit_budget_rate >= t.hit_budget_fail) {
    reasons.push(`hit_budget_rate=${(report.hit_budget_rate * 100).toFixed(1)}% >= ${(t.hit_budget_fail * 100).toFixed(0)}%`);
    bump('fail');
  } else if (report.hit_budget_rate >= t.hit_budget_warn) {
    reasons.push(`hit_budget_rate=${(report.hit_budget_rate * 100).toFixed(1)}% >= ${(t.hit_budget_warn * 100).toFixed(0)}%`);
    bump('warn');
  }
  if (report.avg_utilization >= t.avg_util_fail) {
    reasons.push(`avg_utilization=${(report.avg_utilization * 100).toFixed(1)}% >= ${(t.avg_util_fail * 100).toFixed(0)}%`);
    bump('fail');
  } else if (report.avg_utilization >= t.avg_util_warn) {
    reasons.push(`avg_utilization=${(report.avg_utilization * 100).toFixed(1)}% >= ${(t.avg_util_warn * 100).toFixed(0)}%`);
    bump('warn');
  }
  if (level === 'pass' && reasons.length === 0) {
    reasons.push('pack consistently fits its budget');
  }
  return { verdict: level, reasons };
}

export function computePackMetricsGate(
  db: Database.Database,
  opts: { sinceMs: number; sinceLabel: string; thresholds?: Partial<PackGateThresholds> },
): PackGateReport {
  const thresholds: PackGateThresholds = { ...DEFAULT_PACK_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const since = Date.now() - opts.sinceMs;

  let rows: PackRow[];
  try {
    rows = db.prepare(`
      SELECT budget_tokens, total_tokens, skipped_count, timing_ms
      FROM pack_runs WHERE ts_ms > ?
      ORDER BY ts_ms
    `).all(since) as PackRow[];
  } catch {
    rows = [];
  }

  const total_runs = rows.length;
  let total_tokens_used = 0;
  let total_budget_allocated = 0;
  let utilSum = 0;
  let utilCount = 0;
  let hits = 0;
  let skippedSum = 0;
  const timings: number[] = [];

  for (const r of rows) {
    total_tokens_used += r.total_tokens;
    total_budget_allocated += r.budget_tokens;
    skippedSum += r.skipped_count;
    if (r.budget_tokens > 0) {
      utilSum += r.total_tokens / r.budget_tokens;
      utilCount++;
    }
    if (r.total_tokens >= r.budget_tokens) hits++;
    timings.push(r.timing_ms);
  }
  timings.sort((a, b) => a - b);

  const partial: PackGateReport = {
    since: opts.sinceLabel,
    since_ms: opts.sinceMs,
    thresholds,
    total_runs,
    total_tokens_used,
    total_budget_allocated,
    avg_utilization: utilCount > 0 ? utilSum / utilCount : 0,
    hit_budget_count: hits,
    hit_budget_rate: total_runs > 0 ? hits / total_runs : 0,
    avg_skipped: total_runs > 0 ? skippedSum / total_runs : 0,
    latency: {
      p50_ms: percentile(timings, 50),
      p95_ms: percentile(timings, 95),
      p99_ms: percentile(timings, 99),
    },
    verdict: 'insufficient_data',
    reasons: [],
  };
  const { verdict, reasons } = classify(partial, thresholds);
  partial.verdict = verdict;
  partial.reasons = reasons;
  return partial;
}

function verdictTag(v: PackVerdict): string {
  switch (v) {
    case 'pass': return 'PASS';
    case 'warn': return 'WARN';
    case 'fail': return 'FAIL';
    case 'insufficient_data': return 'N/A ';
  }
}

function fmtMs(v: number | null): string {
  if (v === null) return '-';
  if (v < 1) return `${(v * 1000).toFixed(0)}us`;
  return `${v.toFixed(1)}ms`;
}

export function formatPackMetricsGate(r: PackGateReport): string {
  const lines: string[] = [];
  lines.push(`pack analyze — since ${r.since}  (runs=${r.total_runs})`);
  lines.push('');
  lines.push(`thresholds: hit_budget warn>=${(r.thresholds.hit_budget_warn * 100).toFixed(0)}% fail>=${(r.thresholds.hit_budget_fail * 100).toFixed(0)}%, avg_util warn>=${(r.thresholds.avg_util_warn * 100).toFixed(0)}% fail>=${(r.thresholds.avg_util_fail * 100).toFixed(0)}%, min_runs=${r.thresholds.min_runs}`);
  lines.push('');
  if (r.total_runs === 0) {
    lines.push('  (no pack_runs recorded yet)');
  } else {
    lines.push(`  tokens: used=${r.total_tokens_used}  allocated=${r.total_budget_allocated}`);
    lines.push(`  utilization: avg=${(r.avg_utilization * 100).toFixed(1)}%  hit_budget=${r.hit_budget_count}/${r.total_runs} (${(r.hit_budget_rate * 100).toFixed(1)}%)`);
    lines.push(`  skipped:     avg ${r.avg_skipped.toFixed(1)} items/run`);
    lines.push(`  latency:     p50=${fmtMs(r.latency.p50_ms)}  p95=${fmtMs(r.latency.p95_ms)}  p99=${fmtMs(r.latency.p99_ms)}`);
  }
  lines.push('');
  lines.push(`verdict: [${verdictTag(r.verdict)}]  ${verdictDescription(r.verdict)}`);
  for (const reason of r.reasons) lines.push(`  - ${reason}`);
  return lines.join('\n');
}

function verdictDescription(v: PackVerdict): string {
  switch (v) {
    case 'pass': return 'pack is sufficient — D1 (nexus_next) NOT justified by current data';
    case 'warn': return 'pack is constrained — D1 (nexus_next) deserves consideration';
    case 'fail': return 'pack saturates frequently — D1 (nexus_next) is justified';
    case 'insufficient_data': return 'not enough pack runs to decide D1';
  }
}
