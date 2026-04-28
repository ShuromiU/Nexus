import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { openTelemetryDb, recordPackRun, closeTelemetryDb } from '../src/policy/telemetry.js';
import {
  computePackMetricsGate, formatPackMetricsGate, DEFAULT_PACK_THRESHOLDS,
} from '../src/policy/pack-metrics-gate.js';

describe('pack-metrics-gate', () => {
  let tmpRoot: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pack-gate-'));
    const opened = openTelemetryDb(tmpRoot);
    if (!opened) throw new Error('failed to open telemetry db');
    db = opened;
  });

  afterEach(() => {
    try { closeTelemetryDb(db); } catch { /* ignore */ }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function record(partial: Partial<Parameters<typeof recordPackRun>[1]> = {}): void {
    recordPackRun(db, {
      ts_ms: Date.now(),
      session_id: null,
      query: 'q',
      budget_tokens: 1000,
      total_tokens: 500,
      included_count: 3,
      skipped_count: 0,
      timing_ms: 5,
      ...partial,
    });
  }

  it('returns insufficient_data when below min_runs', () => {
    for (let i = 0; i < 5; i++) record();
    const r = computePackMetricsGate(db, { sinceMs: 86400000, sinceLabel: '1d' });
    expect(r.verdict).toBe('insufficient_data');
    expect(r.total_runs).toBe(5);
    expect(r.reasons[0]).toContain('only 5 pack runs');
  });

  it('returns pass when pack consistently fits its budget', () => {
    for (let i = 0; i < 30; i++) record({ budget_tokens: 1000, total_tokens: 200 });
    const r = computePackMetricsGate(db, { sinceMs: 86400000, sinceLabel: '1d' });
    expect(r.verdict).toBe('pass');
    expect(r.hit_budget_count).toBe(0);
    expect(r.hit_budget_rate).toBe(0);
    expect(r.avg_utilization).toBeCloseTo(0.2);
  });

  it('returns warn when avg_util crosses warn threshold', () => {
    for (let i = 0; i < 30; i++) record({ budget_tokens: 1000, total_tokens: 870 });
    const r = computePackMetricsGate(db, { sinceMs: 86400000, sinceLabel: '1d' });
    expect(r.verdict).toBe('warn');
    expect(r.avg_utilization).toBeCloseTo(0.87);
  });

  it('returns fail when hit_budget_rate crosses fail threshold', () => {
    for (let i = 0; i < 20; i++) record({ budget_tokens: 1000, total_tokens: 1000 });
    for (let i = 0; i < 30; i++) record({ budget_tokens: 1000, total_tokens: 100 });
    const r = computePackMetricsGate(db, { sinceMs: 86400000, sinceLabel: '1d' });
    // 20/50 = 40% hit rate → fail
    expect(r.verdict).toBe('fail');
    expect(r.hit_budget_count).toBe(20);
    expect(r.hit_budget_rate).toBe(0.4);
  });

  it('respects threshold overrides', () => {
    for (let i = 0; i < 30; i++) record({ budget_tokens: 1000, total_tokens: 750 });
    const tighter = computePackMetricsGate(db, {
      sinceMs: 86400000, sinceLabel: '1d',
      thresholds: { avg_util_warn: 0.70, avg_util_fail: 0.74 },
    });
    expect(tighter.verdict).toBe('fail');
    const looser = computePackMetricsGate(db, {
      sinceMs: 86400000, sinceLabel: '1d',
      thresholds: { avg_util_warn: 0.95, avg_util_fail: 0.99 },
    });
    expect(looser.verdict).toBe('pass');
  });

  it('respects since window — old runs excluded', () => {
    for (let i = 0; i < 30; i++) record({ ts_ms: Date.now() - 86400000 * 60 }); // 60 days ago
    const r = computePackMetricsGate(db, { sinceMs: 86400000 * 30, sinceLabel: '30d' });
    expect(r.total_runs).toBe(0);
    expect(r.verdict).toBe('insufficient_data');
  });

  it('reports zero counts and pass-by-default for an empty db', () => {
    const r = computePackMetricsGate(db, { sinceMs: 86400000, sinceLabel: '1d' });
    expect(r.total_runs).toBe(0);
    expect(r.verdict).toBe('insufficient_data');
    expect(r.hit_budget_count).toBe(0);
  });

  it('computes latency percentiles', () => {
    for (let i = 0; i < 30; i++) record({ timing_ms: i + 1 });
    const r = computePackMetricsGate(db, { sinceMs: 86400000, sinceLabel: '1d' });
    expect(r.latency.p50_ms).toBeGreaterThanOrEqual(15);
    expect(r.latency.p95_ms).toBeGreaterThanOrEqual(28);
    expect(r.latency.p99_ms).toBeGreaterThanOrEqual(29);
  });

  it('formatPackMetricsGate produces a verdict-tagged report', () => {
    for (let i = 0; i < 30; i++) record({ budget_tokens: 1000, total_tokens: 400 });
    const r = computePackMetricsGate(db, { sinceMs: 86400000, sinceLabel: '1d' });
    const out = formatPackMetricsGate(r);
    expect(out).toContain('pack analyze — since 1d  (runs=30)');
    expect(out).toContain('verdict: [PASS]');
    expect(out).toContain('D1 (nexus_next) NOT justified');
  });

  it('format includes thresholds line and reason bullets', () => {
    for (let i = 0; i < 30; i++) record({ budget_tokens: 1000, total_tokens: 1000 });
    const r = computePackMetricsGate(db, { sinceMs: 86400000, sinceLabel: '1d' });
    const out = formatPackMetricsGate(r);
    expect(out).toContain('thresholds:');
    expect(out).toContain('hit_budget warn>=20%');
    expect(out).toContain('verdict: [FAIL]');
    expect(out).toContain('  - hit_budget_rate=');
  });

  it('exposes DEFAULT_PACK_THRESHOLDS as a sane default', () => {
    expect(DEFAULT_PACK_THRESHOLDS.min_runs).toBeGreaterThan(0);
    expect(DEFAULT_PACK_THRESHOLDS.hit_budget_warn).toBeGreaterThan(0);
    expect(DEFAULT_PACK_THRESHOLDS.hit_budget_fail).toBeGreaterThan(DEFAULT_PACK_THRESHOLDS.hit_budget_warn);
    expect(DEFAULT_PACK_THRESHOLDS.avg_util_fail).toBeGreaterThanOrEqual(DEFAULT_PACK_THRESHOLDS.avg_util_warn);
  });
});
