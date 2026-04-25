import { execFileSync } from 'node:child_process';
import type { PolicyRule, QueryEngineLike } from '../types.js';
import {
  parseGitTrigger,
  formatEvidenceSummary,
  MAX_SAMPLE_SITES,
  type GitTrigger,
  type AffectedCaller,
  type NewUnusedExport,
  type EvidenceSummary,
} from '../evidence.js';
import { bucketRisk } from '../impact.js';
import { hasTestRunThisSession } from '../session-state.js';

export type RunGit = (args: string[], cwd: string) => string;

const GIT_TIMEOUT_MS = 3000;
const ENV_ALLOW_LIST = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT'];

function pickEnv(keys: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

const defaultRunGit: RunGit = (args, cwd) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT_MS,
    env: pickEnv(ENV_ALLOW_LIST),
  });

export interface EvidenceSummaryDeps {
  runGit?: RunGit;
}

function parseStatusPorcelain(out: string): string[] {
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    if (xy === '??') continue; // untracked: index doesn't know it
    const rest = line.slice(3);
    // Renames: "R  old -> new"
    const arrow = rest.indexOf(' -> ');
    const p = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    files.add(p.trim().replace(/\\/g, '/'));
  }
  return [...files];
}

function resolveUpstream(rootDir: string, runGit: RunGit): string | null {
  try {
    const u = runGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      rootDir,
    ).trim();
    if (u) return u;
  } catch {
    /* fall through */
  }
  try {
    const head = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], rootDir).trim();
    if (head.startsWith('refs/remotes/')) return head.slice('refs/remotes/'.length);
  } catch {
    /* fall through */
  }
  return null;
}

export function _collectChangedFiles(
  rootDir: string,
  trigger: GitTrigger,
  runGit: RunGit,
): string[] {
  try {
    if (trigger.kind === 'commit') {
      const out = runGit(['status', '--porcelain=v1'], rootDir);
      return parseStatusPorcelain(out);
    }
    const upstream = resolveUpstream(rootDir, runGit);
    if (!upstream) return [];
    const base = runGit(['merge-base', upstream, 'HEAD'], rootDir).trim();
    if (!base) return [];
    const diff = runGit(['diff', '--name-only', `${base}..HEAD`], rootDir);
    return diff
      .split('\n')
      .map(s => s.trim().replace(/\\/g, '/'))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function aggregateAffectedCallers(
  engine: QueryEngineLike,
  files: string[],
): AffectedCaller[] {
  const out: AffectedCaller[] = [];
  for (const file of files) {
    let envelope;
    try {
      envelope = engine.outline(file);
    } catch {
      continue;
    }
    const outline = envelope.results[0];
    if (!outline) continue;
    const exportedTopLevel = outline.outline.filter(e => outline.exports.includes(e.name));
    for (const entry of exportedTopLevel) {
      let callerCount = 0;
      let sampleSites: { file: string; line: number }[] = [];
      try {
        const env = engine.callers(entry.name, { file, limit: 50 });
        const callers = env.results[0]?.callers ?? [];
        callerCount = callers.length;
        sampleSites = callers
          .slice(0, MAX_SAMPLE_SITES)
          .map(c => {
            const site = c.call_sites?.[0];
            return {
              file: c.caller?.file ?? file,
              line: site?.line ?? c.caller?.line ?? 0,
            };
          });
      } catch {
        /* keep zeros */
      }
      out.push({
        symbol: entry.name,
        file,
        caller_count: callerCount,
        sample_sites: sampleSites,
      });
    }
  }
  out.sort((a, b) => b.caller_count - a.caller_count);
  return out;
}

function aggregateNewUnusedExports(
  engine: QueryEngineLike,
  files: string[],
): NewUnusedExport[] {
  const out: NewUnusedExport[] = [];
  for (const file of files) {
    try {
      const env = engine.unusedExports({ path: file, limit: 20, mode: 'default' });
      for (const r of env.results) {
        out.push({ symbol: r.name, file: r.file, kind: r.kind });
      }
    } catch {
      /* skip file */
    }
  }
  out.sort((a, b) =>
    a.file === b.file ? a.symbol.localeCompare(b.symbol) : a.file.localeCompare(b.file),
  );
  return out;
}

export function buildEvidenceRule(deps: EvidenceSummaryDeps = {}): PolicyRule {
  const runGit = deps.runGit ?? defaultRunGit;
  return {
    name: 'evidence-summary',
    evaluate(event, ctx) {
      if (event.hook_event_name !== 'PreToolUse') return null;
      if (event.tool_name !== 'Bash') return null;
      const command = event.tool_input.command;
      if (typeof command !== 'string') return null;
      const trigger = parseGitTrigger(command);
      if (!trigger) return null;
      if (!ctx.queryEngine) return null;

      const changed = _collectChangedFiles(ctx.rootDir, trigger, runGit);
      if (changed.length === 0) return null;

      const affected = aggregateAffectedCallers(ctx.queryEngine, changed);
      if (affected.length === 0) return null;

      const unused = aggregateNewUnusedExports(ctx.queryEngine, changed);

      const sessionId = event.session_id ?? '';
      const testsRun = sessionId ? hasTestRunThisSession(ctx.rootDir, sessionId) : false;

      const maxCallers = affected.reduce((m, a) => Math.max(m, a.caller_count), 0);
      const callerRisk = bucketRisk(maxCallers);
      const evidenceOk = testsRun && callerRisk !== 'high' && unused.length === 0;

      // Pass the FULL aggregated lists to the formatter — it slices to
      // MAX_AFFECTED_CALLERS / MAX_UNUSED_EXPORTS internally and appends
      // `+N more callers/unused` from the overflow.
      const summary: EvidenceSummary = {
        trigger: trigger.kind,
        tests_run_this_session: testsRun,
        affected_callers: affected,
        new_unused_exports: unused,
        caller_risk: callerRisk,
        evidence_ok: evidenceOk,
        stale_hint: false,
      };
      return {
        decision: 'allow',
        rule: 'evidence-summary',
        additional_context: formatEvidenceSummary(summary),
      };
    },
  };
}

export const evidenceSummaryRule: PolicyRule = buildEvidenceRule();
