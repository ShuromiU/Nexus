#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { runIndex } from '../index/orchestrator.js';
import { openDatabase, applySchema } from '../db/schema.js';
import { QueryEngine } from '../query/engine.js';
import { repair } from '../db/integrity.js';
import { detectRoot, detectCaseSensitivity, resolveRoot } from '../workspace/detector.js';
import {
  computeMetricsGate, formatMetricsGate, DEFAULT_THRESHOLDS,
  type MetricsGateReport, type GateThresholds,
} from '../policy/metrics-gate.js';
import {
  computePackMetricsGate, formatPackMetricsGate, DEFAULT_PACK_THRESHOLDS,
  type PackGateReport, type PackGateThresholds,
} from '../policy/pack-metrics-gate.js';
import { openTelemetryDb, recordPackRun, closeTelemetryDb } from '../policy/telemetry.js';
import type {
  SymbolResult, OccurrenceResult, ModuleEdgeResult,
  TreeEntry, IndexStats, NexusResult, ImporterResult, GrepResult,
  OutlineResult, BatchOutlineResult, SourceResult, SliceResult, DepsResult,
  RelationsResult,
} from '../query/engine.js';

// Side-effect: register all language adapters
import '../analysis/languages/typescript.js';
import '../analysis/languages/python.js';
import '../analysis/languages/go.js';
import '../analysis/languages/rust.js';
import '../analysis/languages/java.js';
import '../analysis/languages/csharp.js';

// ── Telemetry helpers (D5) ────────────────────────────────────────────

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
      const lats = (db.prepare(`
        SELECT latency_us FROM events
        WHERE rule=? AND latency_us IS NOT NULL AND ts_ms > ?
        ORDER BY latency_us
      `).all(rule, since) as { latency_us: number }[]).map(r => r.latency_us);
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
      const fmt = (v: number | null): string => v === null ? '-' : `${v}us`;
      lines.push(`    latency: p50=${fmt(info.p50_us)} p95=${fmt(info.p95_us)} p99=${fmt(info.p99_us)}`);
    }
  }
  lines.push('');
  lines.push(`  opt_out transitions: ${s.opt_outs.transitions}`);
  return lines.join('\n');
}

const TELEMETRY_EXPORT_COLUMNS = [
  'id', 'ts_ms', 'session_id', 'hook_event', 'tool_name', 'rule', 'decision',
  'latency_us', 'input_hash', 'file_path', 'payload_json',
];

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function analyzeTelemetry(
  rootDir: string,
  sinceSpec: string | undefined,
  thresholdOverrides: Partial<GateThresholds>,
): MetricsGateReport | null {
  const dbPath = path.join(rootDir, '.nexus', 'telemetry.db');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    return computeMetricsGate(db, {
      sinceMs: parseSince(sinceSpec),
      sinceLabel: sinceSpec ?? '30d',
      thresholds: thresholdOverrides,
    });
  } finally {
    db.close();
  }
}

function analyzePackTelemetry(
  rootDir: string,
  sinceSpec: string | undefined,
  thresholdOverrides: Partial<PackGateThresholds>,
): PackGateReport | null {
  const dbPath = path.join(rootDir, '.nexus', 'telemetry.db');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    return computePackMetricsGate(db, {
      sinceMs: parseSince(sinceSpec),
      sinceLabel: sinceSpec ?? '30d',
      thresholds: thresholdOverrides,
    });
  } finally {
    db.close();
  }
}

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
      console.log(TELEMETRY_EXPORT_COLUMNS.join(','));
      for (const r of rows) {
        console.log(TELEMETRY_EXPORT_COLUMNS.map(c => csvEscape(r[c])).join(','));
      }
    }
  } finally {
    db.close();
  }
}

// ── Output Formatting ─────────────────────────────────────────────────

function formatSymbols(results: SymbolResult[]): string {
  if (results.length === 0) return 'No symbols found.';

  const lines: string[] = [];
  for (const s of results) {
    const loc = `${s.file}:${s.line}:${s.col}`;
    const sig = s.signature ? ` ${s.signature}` : '';
    const scope = s.scope ? ` (in ${s.scope})` : '';
    lines.push(`  ${s.kind.padEnd(12)} ${s.name}${sig}${scope}`);
    lines.push(`               ${loc}`);
    if (s.doc) {
      lines.push(`               ${s.doc}`);
    }
  }
  return lines.join('\n');
}

function formatOccurrences(results: OccurrenceResult[]): string {
  if (results.length === 0) return 'No occurrences found.';

  const lines: string[] = [];
  for (const o of results) {
    const conf = o.confidence === 'exact' ? '*' : '~';
    lines.push(`  ${conf} ${o.file}:${o.line}:${o.col}`);
    if (o.context) {
      lines.push(`    ${o.context.trim()}`);
    }
  }
  lines.push('');
  lines.push('  * = exact, ~ = heuristic');
  return lines.join('\n');
}

function formatEdges(results: ModuleEdgeResult[], direction: 'exports' | 'imports'): string {
  if (results.length === 0) return `No ${direction} found.`;

  const lines: string[] = [];
  for (const e of results) {
    const flags: string[] = [];
    if (e.is_default) flags.push('default');
    if (e.is_star) flags.push('*');
    if (e.is_type) flags.push('type');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

    const name = e.name ?? (e.is_star ? '*' : '<unnamed>');
    const alias = e.alias ? ` as ${e.alias}` : '';
    const source = e.source ? ` from '${e.source}'` : '';

    lines.push(`  ${e.kind.padEnd(10)} ${name}${alias}${source}${flagStr}  :${e.line}`);
  }
  return lines.join('\n');
}

function formatImporters(results: ImporterResult[]): string {
  if (results.length === 0) return 'No files import from this source.';

  const lines: string[] = [];
  for (const r of results) {
    const flags: string[] = [];
    if (r.is_default) flags.push('default');
    if (r.is_star) flags.push('*');
    if (r.is_type) flags.push('type');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    const names = r.names.length > 0 ? r.names.join(', ') : '<side-effect>';
    lines.push(`  ${r.file}:${r.line}`);
    lines.push(`    imports { ${names} } from '${r.source}'${flagStr}`);
  }
  return lines.join('\n');
}

function formatTree(results: TreeEntry[]): string {
  if (results.length === 0) return 'No files found.';

  const lines: string[] = [];
  for (const f of results) {
    const status = f.status !== 'indexed' ? ` [${f.status}]` : '';
    const exports = f.exports.length > 0 ? ` → ${f.exports.join(', ')}` : '';
    lines.push(`  ${f.path}  (${f.language}, ${f.symbol_count} symbols)${exports}${status}`);
  }
  return lines.join('\n');
}

function formatGrepResults(results: GrepResult[]): string {
  if (results.length === 0) return 'No matches found.';

  const lines: string[] = [];
  for (const r of results) {
    lines.push(`  ${r.file}:${r.line}:${r.col}`);
    lines.push(`    ${r.context.trim()}`);
  }
  return lines.join('\n');
}

function formatStats(stats: IndexStats): string {
  const lines: string[] = [];

  lines.push(`  Root:      ${stats.root}`);
  lines.push(`  Status:    ${stats.index_status} | Health: ${stats.index_health}`);
  lines.push(`  Indexed:   ${stats.last_indexed_at || 'never'}`);
  lines.push(`  Schema:    v${stats.schema_version} | Extractor: v${stats.extractor_version}`);
  lines.push('');
  lines.push(`  Files:     ${stats.files.total} total, ${stats.files.indexed} indexed, ${stats.files.skipped} skipped, ${stats.files.errored} errored`);
  lines.push(`  Symbols:   ${stats.symbols_total}`);

  const langs = Object.entries(stats.languages);
  if (langs.length > 0) {
    lines.push('');
    lines.push('  Languages:');
    for (const [lang, info] of langs) {
      const caps = info.capabilities;
      const capList: string[] = ['defs'];
      if (caps.imports) capList.push('imports');
      if (caps.exports) capList.push('exports');
      if (caps.occurrences) capList.push(`refs(${caps.occurrenceQuality})`);
      if (caps.typeExports) capList.push('type-exports');
      if (caps.docstrings) capList.push('docs');
      if (caps.signatures) capList.push('sigs');
      lines.push(`    ${lang.padEnd(20)} ${info.files} files, ${info.symbols} symbols  [${capList.join(', ')}]`);
    }
  }

  return lines.join('\n');
}

function formatOutline(result: OutlineResult): string {
  const lines: string[] = [];
  lines.push(`  ${result.file}  (${result.language}, ${result.lines} lines)`);
  lines.push('');

  if (result.imports.length > 0) {
    lines.push('  Imports:');
    for (const imp of result.imports) {
      const typeFlag = imp.is_type ? ' [type]' : '';
      const names = imp.names.length > 0 ? `{ ${imp.names.join(', ')} }` : '<side-effect>';
      lines.push(`    ${names} from '${imp.source}'${typeFlag}`);
    }
    lines.push('');
  }

  if (result.exports.length > 0) {
    lines.push(`  Exports: ${result.exports.join(', ')}`);
    lines.push('');
  }

  const formatEntry = (entry: OutlineResult['outline'][0], indent: number) => {
    const pad = '  '.repeat(indent);
    const range = entry.end_line ? `:${entry.line}-${entry.end_line}` : `:${entry.line}`;
    const sig = entry.signature ? ` ${entry.signature}` : '';
    const doc = entry.doc_summary ? `  — ${entry.doc_summary}` : '';
    lines.push(`${pad}${entry.kind.padEnd(12)} ${entry.name}${sig}${range}${doc}`);
    if (entry.children) {
      for (const child of entry.children) {
        formatEntry(child, indent + 1);
      }
    }
  };

  for (const entry of result.outline) {
    formatEntry(entry, 1);
  }

  return lines.join('\n');
}

function formatBatchOutline(result: BatchOutlineResult): string {
  const lines: string[] = [];
  const entries = Object.entries(result.outlines);

  if (entries.length === 0) {
    lines.push('No matching files found.');
  } else {
    for (let i = 0; i < entries.length; i++) {
      const outline = entries[i][1];
      lines.push(`  -- ${outline.file} --`);
      lines.push(formatOutline(outline));
      if (i < entries.length - 1) {
        lines.push('');
      }
    }
  }

  if (result.missing && result.missing.length > 0) {
    lines.push('');
    lines.push('  Missing:');
    for (const file of result.missing) {
      lines.push(`    ${file}`);
    }
  }

  return lines.join('\n');
}

function formatSource(results: SourceResult[]): string {
  if (results.length === 0) return 'No matching symbols found.';

  const lines: string[] = [];
  for (const r of results) {
    const sig = r.signature ? ` ${r.signature}` : '';
    lines.push(`  ── ${r.kind} ${r.name}${sig}  ${r.file}:${r.line}-${r.end_line}`);
    if (r.doc) {
      lines.push(`  ${r.doc}`);
    }
    lines.push('');
    for (const srcLine of r.source.split('\n')) {
      lines.push(`  ${srcLine}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatSlice(result: SliceResult): string {
  const lines: string[] = [];
  lines.push(`  -- root: ${result.root.name}  ${result.root.file}:${result.root.line}-${result.root.end_line} --`);
  lines.push('');
  for (const srcLine of result.root.source.split('\n')) {
    lines.push(`  ${srcLine}`);
  }

  if (result.references.length > 0) {
    lines.push('');
    lines.push('  References:');
    for (const ref of result.references) {
      lines.push(`  -- ${ref.name}  ${ref.file}:${ref.line}-${ref.end_line} --`);
      for (const srcLine of ref.source.split('\n')) {
        lines.push(`  ${srcLine}`);
      }
      lines.push('');
    }
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
  } else {
    lines.push('');
    lines.push('  No referenced symbols found.');
  }

  if (result.disambiguation && result.disambiguation.length > 0) {
    lines.push('');
    lines.push('  Other matches:');
    for (const alt of result.disambiguation) {
      lines.push(`    ${alt.kind} ${alt.name}  ${alt.file}:${alt.line}:${alt.col}`);
    }
  }

  if (result.truncated) {
    lines.push('');
    lines.push('  Output truncated.');
  }

  return lines.join('\n');
}

function formatDeps(result: DepsResult): string {
  const lines: string[] = [];
  lines.push(`  ${result.direction === 'imports' ? 'Dependencies' : 'Dependents'} of ${result.root} (depth: ${result.depth})`);
  lines.push('');

  const formatNode = (node: DepsResult['tree'], indent: number, isLast: boolean, prefix: string) => {
    const connector = indent === 0 ? '' : (isLast ? '└── ' : '├── ');
    const exports = node.exports && node.exports.length > 0 ? ` → ${node.exports.join(', ')}` : '';
    lines.push(`${prefix}${connector}${node.file}  (${node.language})${exports}`);

    const childPrefix = indent === 0 ? '  ' : prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.deps.length; i++) {
      formatNode(node.deps[i], indent + 1, i === node.deps.length - 1, childPrefix);
    }
  };

  formatNode(result.tree, 0, true, '  ');
  return lines.join('\n');
}

function formatRelations(result: RelationsResult): string {
  const lines: string[] = [];
  const dirArrow = result.query.direction === 'children' ? '←' : (result.query.direction === 'both' ? '↔' : '→');
  const kindFilter = result.query.kind ? ` (${result.query.kind})` : '';
  lines.push(`  ${result.query.name} ${dirArrow}${kindFilter}  depth=${result.query.depth}`);
  lines.push('');

  if (result.results.length === 0) {
    lines.push('  (no relations)');
    return lines.join('\n');
  }

  for (const e of result.results) {
    const indent = '  '.repeat(e.depth);
    const arrow = `--${e.kind}-->`;
    const targetTag = e.target.resolved
      ? `${e.target.resolved_name ?? e.target.name}  ${e.target.file ?? ''}:${e.target.line ?? '?'}`
      : `${e.target.name}  (unresolved)`;
    lines.push(`${indent}${e.source.name} (${e.source.file}:${e.source.line}) ${arrow} ${targetTag}`);
  }
  return lines.join('\n');
}

function printEnvelope<T>(result: NexusResult<T>, body: string): void {
  console.log(body);
  console.log('');
  console.log(`  ${result.count} result(s) in ${result.timing_ms}ms | index: ${result.index_status}, health: ${result.index_health}`);
}

// ── Install printing helper ───────────────────────────────────────────

function printInstallPlan(
  plan: import('./install.js').InstallPlan,
  dryRun: boolean,
): void {
  const tag = dryRun ? '[dry-run]' : '[install]';
  console.log(`${tag} settings: ${plan.settings.filePath}`);
  for (const c of plan.settings.changes) {
    console.log(`  ${c.hook.padEnd(14)} ${c.action.padEnd(10)} ${c.detail}`);
  }
  if (plan.mcp) {
    console.log(`${tag} mcp: ${plan.mcp.filePath}`);
    for (const c of plan.mcp.changes) {
      console.log(`  ${c.hook.padEnd(20)} ${c.action.padEnd(10)} ${c.detail}`);
    }
  }
  if (dryRun) {
    console.log('');
    console.log('--- proposed settings.json ---');
    console.log(plan.settings.afterContent || '(file would be deleted/empty)');
    if (plan.mcp) {
      console.log('');
      console.log('--- proposed .mcp.json ---');
      console.log(plan.mcp.afterContent || '(file would be deleted/empty)');
    }
  }
}

// ── DB Helpers ────────────────────────────────────────────────────────

/**
 * Resolve the starting directory for CLI command actions using the shared
 * precedence chain (--root > NEXUS_ROOT > CLAUDE_PROJECT_DIR > MCP roots > cwd).
 * Inside Commander action handlers we use this instead of `process.cwd()` so
 * that `NEXUS_ROOT` and `CLAUDE_PROJECT_DIR` are honored consistently.
 */
function workingRoot(): string {
  return resolveRoot().startDir;
}

/**
 * Build a pack-run recorder that persists to `.nexus/telemetry.db`. Opens
 * the db lazily on first call and reuses the handle across invocations
 * for the lifetime of this CLI process. Best-effort: if telemetry can't
 * be opened, the recorder becomes a no-op. Honors the existing
 * `NEXUS_TELEMETRY=0|false` opt-out.
 */
function makePackRecorder(rootDir: string): (run: import('../query/budget-ledger.js').BudgetEntry) => void {
  const env = process.env.NEXUS_TELEMETRY;
  if (env === '0' || env === 'false' || env === 'no') return () => undefined;
  let db: Database.Database | null | undefined; // undefined = not yet opened
  return (run) => {
    try {
      if (db === undefined) db = openTelemetryDb(rootDir);
      if (!db) return;
      recordPackRun(db, {
        ts_ms: Date.parse(run.timestamp) || Date.now(),
        session_id: process.env.CLAUDE_SESSION_ID ?? null,
        query: run.query,
        budget_tokens: run.budget_tokens,
        total_tokens: run.total_tokens,
        included_count: run.included_count,
        skipped_count: run.skipped_count,
        timing_ms: run.timing_ms,
      });
    } catch { /* swallow — never block pack() */ }
  };
}


function openQueryDb(startDir: string): { db: ReturnType<typeof openDatabase>; rootDir: string; dbPath: string } {
  const rootDir = detectRoot(startDir);
  const dbPath = path.join(rootDir, '.nexus', 'index.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`No index found at ${dbPath}. Run 'nexus build' first.`);
    process.exit(1);
  }

  const db = openDatabase(dbPath);
  applySchema(db);
  return { db, rootDir, dbPath };
}

// ── CLI Definition ────────────────────────────────────────────────────

export function createProgram(): Command {
  const program = new Command();

  program
    .name('nexus')
    .description('Codebase index & query tool — one query replaces five searches')
    .version('0.2.0');

  // ── build ─────────────────────────────────────────────────────────

  program
    .command('build')
    .description('Build or update the index (auto-routes to overlay in worktree mode)')
    .option('--incremental', 'Run incremental update (default behavior)')
    .action(async (_opts) => {
      try {
        const { detectWorkspace } = await import('../workspace/detector.js');
        const info = detectWorkspace(workingRoot());

        if (info.mode === 'worktree') {
          const { buildWorktreeIndex } = await import('../index/overlay-orchestrator.js');
          const outcome = buildWorktreeIndex(info);
          if (outcome.kind === 'overlay') {
            const r = outcome.result;
            console.log(`Index overlay-on-parent build complete:`);
            console.log(`  parent=${info.baseIndexPath}`);
            console.log(`  overlay=${info.overlayPath}`);
            console.log(`  ${r.filesScanned} scanned, ${r.filesIndexed} indexed, ${r.filesSkipped} skipped, ${r.filesErrored} errored`);
            console.log(`  ${r.durationMs}ms`);
          } else {
            const r = outcome.result;
            console.log(`Index worktree-isolated build complete (degraded: ${outcome.reason}):`);
            console.log(`  ${r.filesScanned} scanned, ${r.filesIndexed} indexed, ${r.filesSkipped} skipped, ${r.filesErrored} errored`);
            console.log(`  ${r.durationMs}ms`);
          }
          return;
        }

        const result = runIndex(workingRoot());
        console.log(`Index ${result.mode} build complete:`);
        console.log(`  ${result.filesScanned} scanned, ${result.filesIndexed} indexed, ${result.filesSkipped} skipped, ${result.filesErrored} errored`);
        console.log(`  ${result.durationMs}ms`);
      } catch (err) {
        console.error(`Build failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ── rebuild ───────────────────────────────────────────────────────

  program
    .command('rebuild')
    .description('Force a full index rebuild')
    .option('--force', 'Force full rebuild (default for rebuild)')
    .action((_opts) => {
      try {
        const result = runIndex(workingRoot(), true);
        console.log(`Full rebuild complete:`);
        console.log(`  ${result.filesScanned} scanned, ${result.filesIndexed} indexed, ${result.filesSkipped} skipped, ${result.filesErrored} errored`);
        console.log(`  ${result.durationMs}ms`);
      } catch (err) {
        console.error(`Rebuild failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ── find ──────────────────────────────────────────────────────────

  program
    .command('find <name>')
    .description('Find where a symbol is defined')
    .option('-k, --kind <kind>', 'Filter by symbol kind (function, class, interface, etc.)')
    .action((name: string, opts: { kind?: string }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.find(name, opts.kind);
        printEnvelope(result, formatSymbols(result.results));
      } finally {
        db.close();
      }
    });

  // ── refs ──────────────────────────────────────────────────────────

  program
    .command('refs <name>')
    .description('Find all occurrences of an identifier')
    .option('--ref-kinds <kinds>', 'comma-separated: call,read,write,type-ref,declaration')
    .action((name: string, opts: { refKinds?: string }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.occurrences(name, {
          ref_kinds: opts.refKinds?.split(',').map(s => s.trim()),
        });
        printEnvelope(result, formatOccurrences(result.results));
      } finally {
        db.close();
      }
    });

  // ── exports ───────────────────────────────────────────────────────

  program
    .command('exports <file>')
    .description('List what a file exports')
    .action((file: string) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.exports(file);
        printEnvelope(result, formatEdges(result.results, 'exports'));
      } finally {
        db.close();
      }
    });

  // ── imports ───────────────────────────────────────────────────────

  program
    .command('imports <file>')
    .description('List what a file imports')
    .action((file: string) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.imports(file);
        printEnvelope(result, formatEdges(result.results, 'imports'));
      } finally {
        db.close();
      }
    });

  // ── importers ──────────────────────────────────────────────────────

  program
    .command('importers <source>')
    .description('Find all files that import from a source module')
    .action((source: string) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.importers(source);
        printEnvelope(result, formatImporters(result.results));
      } finally {
        db.close();
      }
    });

  // ── tree ──────────────────────────────────────────────────────────

  program
    .command('tree [path]')
    .description('List indexed files under a path prefix with export summaries')
    .action((pathPrefix?: string) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.tree(pathPrefix);
        printEnvelope(result, formatTree(result.results));
      } finally {
        db.close();
      }
    });

  // ── search ────────────────────────────────────────────────────────

  program
    .command('search <query>')
    .description('Fuzzy search across symbol names')
    .option('-l, --limit <n>', 'Max results', '20')
    .option('-p, --path <prefix>', 'Path prefix filter')
    .action((query: string, opts: { limit: string; path?: string }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const limit = parseInt(opts.limit, 10) || 20;
        const result = engine.search(query, limit, undefined, opts.path);
        // Format search results like find, but with score
        const lines: string[] = [];
        if (result.results.length === 0) {
          lines.push('No matches found.');
          if (result.suggestions && result.suggestions.length > 0) {
            lines.push('');
            lines.push('  Did you mean?');
            for (const s of result.suggestions) {
              lines.push(`    - ${s}`);
            }
          }
        } else {
          for (const s of result.results) {
            const score = (s._score * 100).toFixed(0);
            const loc = `${s.file}:${s.line}:${s.col}`;
            lines.push(`  ${score.padStart(3)}%  ${s.kind.padEnd(12)} ${s.name}`);
            lines.push(`               ${loc}`);
          }
        }
        printEnvelope(result, lines.join('\n'));
      } finally {
        db.close();
      }
    });

  // ── grep ──────────────────────────────────────────────────────────

  program
    .command('grep <pattern>')
    .description('Search file contents with regex across all indexed files')
    .option('-p, --path <prefix>', 'Path prefix filter')
    .option('--lang <language>', 'Language filter')
    .option('-l, --limit <n>', 'Max results', '50')
    .action((pattern: string, opts: { path?: string; lang?: string; limit: string }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const limit = parseInt(opts.limit, 10) || 50;
        const result = engine.grep(pattern, opts.path, opts.lang, limit);
        printEnvelope(result, formatGrepResults(result.results));
      } finally {
        db.close();
      }
    });

  // ── outline ───────────────────────────────────────────────────────

  program
    .command('outline <files...>')
    .description('Structural outline of a file — symbols, imports, exports')
    .action((files: string[]) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        if (files.length === 1) {
          const result = engine.outline(files[0]);
          if (result.results.length > 0) {
            printEnvelope(result, formatOutline(result.results[0]));
          } else {
            printEnvelope(result, 'File not found.');
          }
        } else {
          const result = engine.outlineMany(files);
          printEnvelope(result, formatBatchOutline(result.results[0]));
        }
      } finally {
        db.close();
      }
    });

  // ── source ───────────────────────────────────────────────────────

  program
    .command('source <name>')
    .description('Extract source code for a symbol')
    .option('-f, --file <file>', 'Narrow to a specific file')
    .action((name: string, opts: { file?: string }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.source(name, opts.file);
        printEnvelope(result, formatSource(result.results));
      } finally {
        db.close();
      }
    });

  program
    .command('slice <name>')
    .description('Extract a symbol and the named symbols it references')
    .option('-f, --file <file>', 'Narrow to a specific file')
    .option('-l, --limit <n>', 'Max referenced symbols', '20')
    .option('--ref-kinds <kinds>', 'comma-separated: call,read,write,type-ref,declaration')
    .action((name: string, opts: { file?: string; limit: string; refKinds?: string }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const limit = parseInt(opts.limit, 10) || 20;
        const result = engine.slice(name, {
          file: opts.file,
          limit,
          ref_kinds: opts.refKinds?.split(',').map(s => s.trim()),
        });
        if (result.results.length > 0) {
          printEnvelope(result, formatSlice(result.results[0]));
        } else {
          printEnvelope(result, 'No matching symbols found.');
        }
      } finally {
        db.close();
      }
    });

  // ── deps ─────────────────────────────────────────────────────────

  program
    .command('deps <file>')
    .description('Show transitive dependency tree')
    .option('-d, --direction <dir>', 'imports or importers', 'imports')
    .option('--depth <n>', 'Max depth (1-5)', '2')
    .action((file: string, opts: { direction: string; depth: string }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const direction = opts.direction === 'importers' ? 'importers' as const : 'imports' as const;
        const depth = Math.min(Math.max(parseInt(opts.depth, 10) || 2, 1), 5);
        const result = engine.deps(file, direction, depth);
        if (result.results.length > 0) {
          printEnvelope(result, formatDeps(result.results[0]));
        } else {
          printEnvelope(result, 'File not found.');
        }
      } finally {
        db.close();
      }
    });

  // ── stats ─────────────────────────────────────────────────────────

  program
    .command('stats')
    .description('Show index summary and per-language capabilities')
    .option('--session', 'Include the per-process budget accountant snapshot (D4)')
    .option('--recent-limit <n>', 'Max recent pack() entries when --session is set', '10')
    .option('--pretty', 'Pretty-print JSON instead of the human formatter')
    .action((opts: { session?: boolean; recentLimit?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.stats({
          ...(opts.session ? { session: true } : {}),
          ...(opts.recentLimit ? { recent_limit: parseInt(opts.recentLimit, 10) || 10 } : {}),
        });
        if (opts.pretty || opts.session) {
          printJson(result, !!opts.pretty);
        } else {
          printEnvelope(result, formatStats(result.results[0]));
        }
      } finally {
        db.close();
      }
    });

  // ── repair ────────────────────────────────────────────────────────

  program
    .command('repair')
    .description('Run full integrity check, rebuild if corrupt')
    .action(() => {
      const rootDir = detectRoot(workingRoot());
      const dbPath = path.join(rootDir, '.nexus', 'index.db');

      if (!fs.existsSync(dbPath)) {
        console.log('No index found. Run \'nexus build\' to create one.');
        return;
      }

      const caseSensitive = detectCaseSensitivity(rootDir);
      const result = repair(dbPath, rootDir, caseSensitive);
      console.log(result.message);

      if (result.needsRebuild) {
        console.log('Running full rebuild...');
        const buildResult = runIndex(rootDir, true);
        console.log(`Rebuild complete: ${buildResult.filesIndexed} files indexed in ${buildResult.durationMs}ms`);
      }
    });

  // ── New token-saver commands ──────────────────────────────────────
  // These output JSON (use --pretty for indented). MCP-first tools — the
  // CLI is provided for scripting and quick local debugging.

  const printJson = (value: unknown, pretty: boolean): void => {
    console.log(pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
  };

  program
    .command('callers <name>')
    .description('Find functions/classes that call this symbol (inverse of slice)')
    .option('-f, --file <file>', 'Disambiguate when name is multi-defined')
    .option('-d, --depth <n>', 'Recursion depth, 1-3', '1')
    .option('-l, --limit <n>', 'Max callers per level', '30')
    .option('--ref-kinds <kinds>', 'comma-separated: call,read,write,type-ref,declaration')
    .option('--pretty', 'Pretty-print JSON')
    .action((name: string, opts: { file?: string; depth: string; limit: string; refKinds?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.callers(name, {
          file: opts.file,
          depth: parseInt(opts.depth, 10) || 1,
          limit: parseInt(opts.limit, 10) || 30,
          ref_kinds: opts.refKinds?.split(',').map(s => s.trim()),
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('pack <query>')
    .description('Token-budget-aware context bundle (outlines + sources up to budget)')
    .option('-b, --budget <n>', 'Token budget', '4000')
    .option('-p, --paths <paths>', 'Comma-separated path prefixes')
    .option('--pretty', 'Pretty-print JSON')
    .action((query: string, opts: { budget: string; paths?: string; pretty?: boolean }) => {
      const root = workingRoot();
      const { db } = openQueryDb(root);
      try {
        const engine = new QueryEngine(db, { packRecorder: makePackRecorder(root) });
        const result = engine.pack(query, {
          budget_tokens: parseInt(opts.budget, 10) || 4000,
          paths: opts.paths ? opts.paths.split(',').map(s => s.trim()) : undefined,
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('changed')
    .description('Files changed since a git ref with current outlines')
    .option('-r, --ref <ref>', 'Git ref to compare against', 'HEAD~1')
    .option('--pretty', 'Pretty-print JSON')
    .action((opts: { ref: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.changed({ ref: opts.ref });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('diff-outline <refA> [refB]')
    .description('Semantic diff of symbols between two git refs')
    .option('--pretty', 'Pretty-print JSON')
    .action((refA: string, refB: string | undefined, opts: { pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.diffOutline(refA, refB);
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('signatures <names...>')
    .description('Batch signature lookup (no body) for multiple symbol names')
    .option('-f, --file <file>', 'Optional file scope')
    .option('-k, --kind <kind>', 'Optional kind filter')
    .option('--pretty', 'Pretty-print JSON')
    .action((names: string[], opts: { file?: string; kind?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.signatures(names, { file: opts.file, kind: opts.kind });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('definition-at <file> <line> [col]')
    .description('Resolve identifier at file:line[:col] to its definition source')
    .option('--pretty', 'Pretty-print JSON')
    .action((file: string, line: string, col: string | undefined, opts: { pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.definitionAt(file, parseInt(line, 10), col ? parseInt(col, 10) : undefined);
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('unused-exports')
    .description('Find exports with no importers and no external occurrences')
    .option('-p, --path <prefix>', 'Path prefix to scope (e.g. "src/")')
    .option('-l, --limit <n>', 'Max results', '100')
    .option('--mode <mode>', 'default|runtime_only', 'default')
    .option('--pretty', 'Pretty-print JSON')
    .action((opts: { path?: string; limit: string; mode?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.unusedExports({
          path: opts.path,
          limit: parseInt(opts.limit, 10) || 100,
          mode: opts.mode === 'runtime_only' ? 'runtime_only' : 'default',
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('private-dead')
    .description('Find private dead code: top-level symbols not exported and unreferenced in their own file')
    .option('-p, --path <prefix>', 'Path prefix to scope (e.g. "src/")')
    .option('-l, --limit <n>', 'Max results', '100')
    .option('--kinds <list>', 'Comma-separated symbol kinds (default: function,class,interface,type,enum,constant,variable,hook,component)')
    .option('--pretty', 'Pretty-print JSON')
    .action((opts: { path?: string; limit: string; kinds?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.privateDeadCode({
          path: opts.path,
          limit: parseInt(opts.limit, 10) || 100,
          ...(opts.kinds ? { kinds: opts.kinds.split(',').map(s => s.trim()).filter(Boolean) } : {}),
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('stale-docs')
    .description('Detect functions/methods whose @param tags drift from their signature (B3)')
    .option('-p, --path <prefix>', 'Path prefix to scope (e.g. "src/")')
    .option('-l, --limit <n>', 'Max results', '100')
    .option('--kinds <list>', 'Comma-separated symbol kinds (default: function,method,hook,component)')
    .option('--pretty', 'Pretty-print JSON')
    .action((opts: { path?: string; limit: string; kinds?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.staleDocs({
          path: opts.path,
          limit: parseInt(opts.limit, 10) || 100,
          ...(opts.kinds ? { kinds: opts.kinds.split(',').map(s => s.trim()).filter(Boolean) } : {}),
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('tests-for')
    .description('Find test files that import a source symbol or file (B5)')
    .option('-n, --name <name>', 'Source symbol name')
    .option('-f, --file <path>', 'Source file path')
    .option('-l, --limit <n>', 'Max results', '100')
    .option('--pretty', 'Pretty-print JSON')
    .action((opts: { name?: string; file?: string; limit: string; pretty?: boolean }) => {
      if (!opts.name && !opts.file) {
        console.error('tests-for: provide --name or --file');
        process.exit(2);
      }
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.testsFor({
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.file ? { file: opts.file } : {}),
          limit: parseInt(opts.limit, 10) || 100,
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('relations <name>')
    .description('Declared structural relationships (extends, implements). TypeScript only in v1.')
    .option('--direction <dir>', 'parents | children | both', 'parents')
    .option('--kind <k>', 'extends_class | implements | extends_interface')
    .option('--depth <n>', 'Recursion depth (1-5)', '1')
    .option('-l, --limit <n>', 'Max edges', '200')
    .option('--pretty', 'Pretty-print JSON')
    .action((name: string, opts: { direction?: string; kind?: string; depth: string; limit: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const direction = (opts.direction === 'children' || opts.direction === 'both') ? opts.direction : 'parents';
        const result = engine.relations(name, {
          direction: direction as 'parents' | 'children' | 'both',
          kind: opts.kind,
          depth: parseInt(opts.depth, 10) || 1,
          limit: parseInt(opts.limit, 10) || 200,
        });
        if (opts.pretty) {
          printJson(result, true);
        } else {
          printEnvelope(result, formatRelations(result.results[0]));
        }
      } finally {
        db.close();
      }
    });

  program
    .command('clarify <name>')
    .description('Disambiguate an ambiguous symbol — every candidate with file/kind/scope/importers + suggested picks')
    .option('--pretty', 'Pretty-print JSON')
    .action((name: string, opts: { pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.clarify(name);
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('rename-safety <name>')
    .description('Composed risk verdict for renaming a symbol — callers + importers + relations + collisions in one call')
    .option('-f, --file <file>', 'Optional file path to disambiguate')
    .option('--new-name <new>', 'Optional proposed new name (enables collision detection)')
    .option('--pretty', 'Pretty-print JSON')
    .action((name: string, opts: { file?: string; newName?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.renameSafety(name, {
          file: opts.file,
          new_name: opts.newName,
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('refactor-preview <name>')
    .description('Dry-run rename preview — every edit site grouped by file plus the rename-safety risk verdict')
    .option('-f, --file <file>', 'Optional file path to disambiguate')
    .option('--new-name <new>', 'Optional proposed new name (enables collision detection)')
    .option('--pretty', 'Pretty-print JSON')
    .action((name: string, opts: { file?: string; newName?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.refactorPreview(name, {
          file: opts.file,
          new_name: opts.newName,
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('kind-index <kind>')
    .description('List all symbols of a given kind, optionally under a path prefix')
    .option('-p, --path <prefix>', 'Path prefix')
    .option('-l, --limit <n>', 'Max results', '200')
    .option('--pretty', 'Pretty-print JSON')
    .action((kind: string, opts: { path?: string; limit: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.kindIndex(kind, {
          path: opts.path,
          limit: parseInt(opts.limit, 10) || 200,
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('doc <name>')
    .description('Just the docstring(s) for a symbol — no body')
    .option('-f, --file <file>', 'Optional file scope')
    .option('--pretty', 'Pretty-print JSON')
    .action((name: string, opts: { file?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.doc(name, { file: opts.file });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('structured-query <file> <path>')
    .description('Extract a value from a structured config file by dotted path (e.g. "compilerOptions.strict")')
    .option('--pretty', 'Pretty-print JSON')
    .action((file: string, queryPath: string, opts: { pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.structuredQuery(file, queryPath);
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('structured-outline <file>')
    .description('List top-level keys of a structured config file with value kinds')
    .option('--pretty', 'Pretty-print JSON')
    .action((file: string, opts: { pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.structuredOutline(file);
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  // ── lockfile-deps ──────────────────────────────────────────────────

  program
    .command('lockfile-deps <file> [name]')
    .description('List {name, version} entries from a lockfile (yarn.lock, package-lock.json, pnpm-lock.yaml, Cargo.lock)')
    .option('--pretty', 'Pretty-print JSON')
    .action((file: string, name: string | undefined, opts: { pretty?: boolean }) => {
      const { db } = openQueryDb(workingRoot());
      try {
        const engine = new QueryEngine(db);
        const result = engine.lockfileDeps(file, name);
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  // ── telemetry ──────────────────────────────────────────────────────

  const telemetry = program.command('telemetry').description('Policy telemetry (D5)');

  telemetry
    .command('stats')
    .description('Print telemetry digest')
    .option('--since <spec>', 'Time window: 30d, 7d, 1h', '30d')
    .option('--json', 'Emit JSON')
    .action((opts: { since?: string; json?: boolean }) => {
      const root = detectRoot(workingRoot());
      const stats = computeTelemetryStats(root, opts.since);
      if (!stats || Object.keys(stats.rules).length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({
            since: opts.since ?? '30d',
            rules: {},
            opt_outs: { transitions: stats?.opt_outs.transitions ?? 0 },
          }));
        } else {
          console.log('telemetry stats: no events recorded');
        }
        return;
      }
      if (opts.json) console.log(JSON.stringify(stats));
      else console.log(formatTelemetryStats(stats));
    });

  telemetry
    .command('analyze')
    .description('Evaluate V4 metrics gate (policy rules) or D1 gate (--pack)')
    .option('--since <spec>', 'Time window: 30d, 7d, 1h', '30d')
    .option('--json', 'Emit JSON')
    .option('--pack', 'Analyze pack-utilization for the D1 gate instead of policy rules')
    .option('--p50-us <n>', 'Override p50 latency threshold (microseconds)')
    .option('--p95-us <n>', 'Override p95 latency threshold (microseconds)')
    .option('--override-rate <f>', 'Override max acceptable override rate (0-1)')
    .option('--min-events <n>', 'Min events per rule for a verdict (default 30)')
    .option('--hit-budget-warn <f>', 'Pack-mode: hit-budget-rate warn threshold (0-1)')
    .option('--hit-budget-fail <f>', 'Pack-mode: hit-budget-rate fail threshold (0-1)')
    .option('--avg-util-warn <f>', 'Pack-mode: avg utilization warn threshold (0-1)')
    .option('--avg-util-fail <f>', 'Pack-mode: avg utilization fail threshold (0-1)')
    .option('--min-runs <n>', 'Pack-mode: minimum pack runs for a verdict (default 30)')
    .option('--strict', 'Exit non-zero on warn or fail (default: only fail)')
    .action((opts: {
      since?: string; json?: boolean; pack?: boolean;
      p50Us?: string; p95Us?: string; overrideRate?: string; minEvents?: string;
      hitBudgetWarn?: string; hitBudgetFail?: string;
      avgUtilWarn?: string; avgUtilFail?: string; minRuns?: string;
      strict?: boolean;
    }) => {
      const root = detectRoot(workingRoot());

      if (opts.pack) {
        const overrides: Partial<PackGateThresholds> = {};
        if (opts.hitBudgetWarn !== undefined) overrides.hit_budget_warn = Number(opts.hitBudgetWarn);
        if (opts.hitBudgetFail !== undefined) overrides.hit_budget_fail = Number(opts.hitBudgetFail);
        if (opts.avgUtilWarn !== undefined) overrides.avg_util_warn = Number(opts.avgUtilWarn);
        if (opts.avgUtilFail !== undefined) overrides.avg_util_fail = Number(opts.avgUtilFail);
        if (opts.minRuns !== undefined) overrides.min_runs = Number(opts.minRuns);

        const report = analyzePackTelemetry(root, opts.since, overrides);
        if (!report) {
          if (opts.json) {
            console.log(JSON.stringify({
              since: opts.since ?? '30d',
              thresholds: { ...DEFAULT_PACK_THRESHOLDS, ...overrides },
              total_runs: 0,
              verdict: 'insufficient_data',
              reasons: ['no telemetry recorded'],
            }));
          } else {
            console.log('telemetry analyze --pack: no telemetry recorded');
          }
          return;
        }
        if (opts.json) console.log(JSON.stringify(report));
        else console.log(formatPackMetricsGate(report));

        if (report.verdict === 'fail' || (opts.strict && report.verdict === 'warn')) {
          process.exitCode = 1;
        }
        return;
      }

      const overrides: Partial<GateThresholds> = {};
      if (opts.p50Us !== undefined) overrides.p50_us = Number(opts.p50Us);
      if (opts.p95Us !== undefined) overrides.p95_us = Number(opts.p95Us);
      if (opts.overrideRate !== undefined) overrides.override_rate = Number(opts.overrideRate);
      if (opts.minEvents !== undefined) overrides.min_events_per_rule = Number(opts.minEvents);

      const report = analyzeTelemetry(root, opts.since, overrides);
      if (!report) {
        if (opts.json) {
          console.log(JSON.stringify({
            since: opts.since ?? '30d',
            thresholds: { ...DEFAULT_THRESHOLDS, ...overrides },
            total_events: 0,
            rules: {},
            overall: { verdict: 'insufficient_data', failing_rules: [], warning_rules: [] },
            opt_outs: { transitions: 0 },
          }));
        } else {
          console.log('telemetry analyze: no telemetry recorded');
        }
        return;
      }
      if (opts.json) console.log(JSON.stringify(report));
      else console.log(formatMetricsGate(report));

      if (report.overall.verdict === 'fail' || (opts.strict && report.overall.verdict === 'warn')) {
        process.exitCode = 1;
      }
    });

  telemetry
    .command('export')
    .description('Dump events as NDJSON or CSV')
    .option('--since <spec>', 'Time window: 30d, 7d, 1h', '30d')
    .option('--format <fmt>', 'ndjson | csv', 'ndjson')
    .action((opts: { since?: string; format?: string }) => {
      const root = detectRoot(workingRoot());
      const fmt: 'ndjson' | 'csv' = opts.format === 'csv' ? 'csv' : 'ndjson';
      exportTelemetry(root, opts.since, fmt);
    });

  telemetry
    .command('purge')
    .description('Delete .nexus/telemetry.db')
    .option('--yes', 'Confirm deletion (required)')
    .action((opts: { yes?: boolean }) => {
      const root = detectRoot(workingRoot());
      const dbPath = path.join(root, '.nexus', 'telemetry.db');
      if (!opts.yes) {
        console.log('telemetry purge: re-run with --yes to confirm.');
        return;
      }
      try {
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
          for (const ext of ['-wal', '-shm']) {
            const sib = dbPath + ext;
            if (fs.existsSync(sib)) {
              try { fs.unlinkSync(sib); } catch { /* ignore */ }
            }
          }
        }
      } catch {
        /* ignore */
      }
    });

  // ── serve ──────────────────────────────────────────────────────────

  program
    .command('serve')
    .description('Start MCP server (stdio transport)')
    .action(async () => {
      const { startServer } = await import('./mcp.js');
      await startServer(workingRoot());
    });

  // ── doctor ─────────────────────────────────────────────────────────

  program
    .command('install')
    .description('Install Nexus hook entries (and optionally MCP server) into Claude Code settings.json')
    .option('--dry-run', 'Show the planned diff without writing')
    .option('--project', 'Install into the project .claude/settings.json instead of the user-scope file')
    .option('--mcp', 'Also write/update the project-root .mcp.json with absolute-path nexus server entry')
    .option('--bake-root', 'Add `--root <resolved>` to the MCP args (worktree-local installs only)')
    .action(async (opts: { dryRun?: boolean; project?: boolean; mcp?: boolean; bakeRoot?: boolean }) => {
      const { planInstall, applyInstall } = await import('./install.js');
      const plan = planInstall({
        ...(opts.project ? { project: true } : {}),
        ...(opts.mcp ? { mcp: true } : {}),
        ...(opts.bakeRoot ? { bakeRoot: true } : {}),
      });
      printInstallPlan(plan, !!opts.dryRun);
      if (!opts.dryRun) applyInstall(plan);
    });

  program
    .command('uninstall')
    .description('Remove Nexus-owned hook entries from Claude Code settings.json')
    .option('--dry-run', 'Show the planned diff without writing')
    .option('--project', 'Uninstall from the project .claude/settings.json instead of the user-scope file')
    .action(async (opts: { dryRun?: boolean; project?: boolean }) => {
      const { planUninstall, applyInstall } = await import('./install.js');
      const plan = planUninstall(opts.project ? { project: true } : {});
      printInstallPlan(plan, !!opts.dryRun);
      if (!opts.dryRun) applyInstall(plan);
    });

  program
    .command('doctor')
    .description('Diagnose Nexus setup: workspace mode, index health, MCP/hook wiring, binaries')
    .option('--json', 'Emit machine-readable JSON instead of human text')
    .action(async (opts: { json?: boolean }) => {
      const { buildDoctorReport, formatDoctorReport } = await import('./doctor.js');
      const report = buildDoctorReport();
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        process.stdout.write(formatDoctorReport(report));
      }
    });

  return program;
}

// ── Exports for formatting (used by tests and future MCP) ───────────

export {
  formatSymbols,
  formatOccurrences,
  formatEdges,
  formatImporters,
  formatTree,
  formatGrepResults,
  formatStats,
  formatOutline,
  formatBatchOutline,
  formatSource,
  formatSlice,
  formatDeps,
};

// ── Main ──────────────────────────────────────────────────────────────

// Only parse when run directly (not imported by tests)
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('transports/cli.js')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('transports/cli.ts');

if (isDirectRun) {
  const program = createProgram();
  program.parse();
}
