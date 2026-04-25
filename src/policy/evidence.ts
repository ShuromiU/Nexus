/**
 * Pure helpers for the D3 evidence-summary rule. No fs, no DB, no shell.
 *
 * Splits Bash commands on `&&` / `||` / `;`, strips leading
 * `KEY=value` env-var prefixes, then matches each segment against either
 * the git/gh trigger patterns or a configurable test allow-list.
 */

export type GitTrigger =
  | { kind: 'commit' }
  | { kind: 'push' }
  | { kind: 'pr_create' };

const GIT_TRIGGER_PATTERNS: { kind: GitTrigger['kind']; re: RegExp }[] = [
  { kind: 'commit', re: /^git\s+commit(\s|$)/ },
  { kind: 'push', re: /^git\s+push(\s|$)/ },
  { kind: 'pr_create', re: /^gh\s+pr\s+create(\s|$)/ },
];

export const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /^npm\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/,
  /^pnpm\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/,
  /^yarn\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/,
  /^vitest(?:\s|$)/,
  /^jest(?:\s|$)/,
  /^pytest(?:\s|$)/,
  /^go\s+test(?:\s|$)/,
  /^cargo\s+test(?:\s|$)/,
  /^nexus\s+test(?:\s|$)/,
];

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;)\s*/;
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

function normalizeSegment(seg: string): string {
  return seg.trim().replace(ENV_PREFIX, '');
}

export function parseGitTrigger(command: string): GitTrigger | null {
  if (typeof command !== 'string' || command.trim().length === 0) return null;
  for (const raw of command.split(SEGMENT_SPLIT)) {
    const seg = normalizeSegment(raw);
    for (const { kind, re } of GIT_TRIGGER_PATTERNS) {
      if (re.test(seg)) return { kind };
    }
  }
  return null;
}

export function parseTestCommand(
  command: string,
  patterns: readonly RegExp[] = TEST_COMMAND_PATTERNS,
): string | null {
  if (typeof command !== 'string' || command.trim().length === 0) return null;
  for (const raw of command.split(SEGMENT_SPLIT)) {
    const seg = normalizeSegment(raw);
    for (const re of patterns) {
      if (re.test(seg)) return seg;
    }
  }
  return null;
}

export interface AffectedCaller {
  symbol: string;
  file: string;
  caller_count: number;
  sample_sites: { file: string; line: number }[];
}

export interface NewUnusedExport {
  symbol: string;
  file: string;
  kind: string;
}

export interface EvidenceSummary {
  trigger: GitTrigger['kind'];
  tests_run_this_session: boolean;
  affected_callers: AffectedCaller[];
  new_unused_exports: NewUnusedExport[];
  caller_risk: 'low' | 'medium' | 'high';
  evidence_ok: boolean;
  stale_hint: boolean;
}

export const SUMMARY_MAX_CHARS = 1200;
export const MAX_AFFECTED_CALLERS = 10;
export const MAX_UNUSED_EXPORTS = 10;
export const MAX_SAMPLE_SITES = 3;

const TRIGGER_LABEL: Record<GitTrigger['kind'], string> = {
  commit: 'commit',
  push: 'push',
  pr_create: 'PR create',
};

export function formatEvidenceSummary(s: EvidenceSummary): string {
  const icon = s.evidence_ok ? '✅' : '⚠️';
  const head = `${icon} Pre-${TRIGGER_LABEL[s.trigger]} evidence (Nexus advisory):`;

  const lines: string[] = [head];
  lines.push(
    `tests_run_this_session=${s.tests_run_this_session}, caller_risk=${s.caller_risk}, evidence_ok=${s.evidence_ok}.`,
  );

  if (s.affected_callers.length > 0) {
    const shown = s.affected_callers.slice(0, MAX_AFFECTED_CALLERS);
    const overflow = s.affected_callers.length - shown.length;
    const items = shown.map(a => {
      const sites = a.sample_sites
        .slice(0, MAX_SAMPLE_SITES)
        .map(site => `${site.file}:${site.line}`)
        .join(', ');
      const sitesPart = sites ? ` [${sites}]` : '';
      return `  - \`${a.symbol}\` in ${a.file} (${a.caller_count} caller${a.caller_count === 1 ? '' : 's'})${sitesPart}`;
    });
    lines.push('Affected exports:');
    lines.push(...items);
    if (overflow > 0) lines.push(`  …+${overflow} more callers`);
  } else {
    lines.push('Affected exports: none.');
  }

  if (s.new_unused_exports.length > 0) {
    const shown = s.new_unused_exports.slice(0, MAX_UNUSED_EXPORTS);
    const overflow = s.new_unused_exports.length - shown.length;
    lines.push('New unused exports:');
    for (const u of shown) {
      lines.push(`  - \`${u.symbol}\` (${u.kind}) in ${u.file}`);
    }
    if (overflow > 0) lines.push(`  …+${overflow} more unused`);
  }

  if (s.stale_hint) {
    lines.push('stale_hint=true: index may lag the working tree.');
  }

  let out = lines.join('\n');
  if (out.length > SUMMARY_MAX_CHARS) {
    out = out.slice(0, SUMMARY_MAX_CHARS - 1) + '…';
  }
  return out;
}
