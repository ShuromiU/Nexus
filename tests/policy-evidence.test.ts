import { describe, it, expect } from 'vitest';
import {
  parseGitTrigger,
  parseTestCommand,
  TEST_COMMAND_PATTERNS,
  formatEvidenceSummary,
  SUMMARY_MAX_CHARS,
  type EvidenceSummary,
} from '../src/policy/evidence.js';

describe('parseGitTrigger', () => {
  it('matches plain git commit', () => {
    expect(parseGitTrigger("git commit -m 'x'")).toEqual({ kind: 'commit' });
    expect(parseGitTrigger('git commit')).toEqual({ kind: 'commit' });
    expect(parseGitTrigger('git commit --amend')).toEqual({ kind: 'commit' });
  });

  it('is whitespace tolerant', () => {
    expect(parseGitTrigger('  git commit  ')).toEqual({ kind: 'commit' });
  });

  it('matches git push', () => {
    expect(parseGitTrigger('git push')).toEqual({ kind: 'push' });
    expect(parseGitTrigger('git push --force')).toEqual({ kind: 'push' });
  });

  it('matches gh pr create', () => {
    expect(parseGitTrigger('gh pr create --title x')).toEqual({ kind: 'pr_create' });
  });

  it('detects trigger inside a chained command', () => {
    expect(parseGitTrigger("git add . && git commit -m 'x'")).toEqual({ kind: 'commit' });
    expect(parseGitTrigger('npm test && git push')).toEqual({ kind: 'push' });
  });

  it('first trigger wins on multi-segment', () => {
    expect(parseGitTrigger('git push && gh pr create')).toEqual({ kind: 'push' });
  });

  it('ignores non-trigger commands', () => {
    expect(parseGitTrigger('git status')).toBeNull();
    expect(parseGitTrigger('echo git commit')).toBeNull();
    expect(parseGitTrigger('git commitfoo')).toBeNull();
  });

  it('strips leading env var assignments', () => {
    expect(parseGitTrigger('GIT_AUTHOR_NAME=foo git commit')).toEqual({ kind: 'commit' });
    expect(parseGitTrigger('CI=1 FOO=bar git push')).toEqual({ kind: 'push' });
  });

  it('returns null on empty / whitespace / non-string', () => {
    expect(parseGitTrigger('')).toBeNull();
    expect(parseGitTrigger('   ')).toBeNull();
    expect(parseGitTrigger(undefined as unknown as string)).toBeNull();
  });

  it('handles the literal git-commit segment after && / || / ;', () => {
    expect(parseGitTrigger('foo && git commit')).toEqual({ kind: 'commit' });
    expect(parseGitTrigger('foo || git commit')).toEqual({ kind: 'commit' });
    expect(parseGitTrigger('foo; git commit')).toEqual({ kind: 'commit' });
  });
});

describe('parseTestCommand', () => {
  it('matches npm/pnpm/yarn variants', () => {
    expect(parseTestCommand('npm test')).toBe('npm test');
    expect(parseTestCommand('npm run test')).toBe('npm run test');
    expect(parseTestCommand('npm run test:unit')).toBe('npm run test:unit');
    expect(parseTestCommand('pnpm test')).toBe('pnpm test');
    expect(parseTestCommand('pnpm run test')).toBe('pnpm run test');
    expect(parseTestCommand('yarn test')).toBe('yarn test');
  });

  it('matches bare runners', () => {
    expect(parseTestCommand('vitest')).toBe('vitest');
    expect(parseTestCommand('jest')).toBe('jest');
    expect(parseTestCommand('pytest')).toBe('pytest');
    expect(parseTestCommand('go test')).toBe('go test');
    expect(parseTestCommand('cargo test')).toBe('cargo test');
    expect(parseTestCommand('nexus test')).toBe('nexus test');
  });

  it('strips leading env var assignments', () => {
    expect(parseTestCommand('CI=1 npm test')).toBe('npm test');
  });

  it('matches first segment of a chain', () => {
    expect(parseTestCommand('npm test && git push')).toBe('npm test');
  });

  it('returns null on non-test commands', () => {
    expect(parseTestCommand('npm install')).toBeNull();
    expect(parseTestCommand('echo npm test')).toBeNull();
    expect(parseTestCommand('vitestify')).toBeNull();
  });

  it('returns null for empty/non-string', () => {
    expect(parseTestCommand('')).toBeNull();
    expect(parseTestCommand('   ')).toBeNull();
    expect(parseTestCommand(undefined as unknown as string)).toBeNull();
  });

  it('honors a custom-pattern overload', () => {
    const custom = [/^make\s+test(?:\s|$)/];
    expect(parseTestCommand('make test', custom)).toBe('make test');
    expect(parseTestCommand('npm test', custom)).toBeNull();
  });

  it('exports a non-empty default pattern list', () => {
    expect(TEST_COMMAND_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('formatEvidenceSummary', () => {
  function baseSummary(over: Partial<EvidenceSummary> = {}): EvidenceSummary {
    return {
      trigger: 'commit',
      tests_run_this_session: false,
      affected_callers: [],
      new_unused_exports: [],
      caller_risk: 'low',
      evidence_ok: false,
      stale_hint: false,
      ...over,
    };
  }

  it('renders the empty case', () => {
    const out = formatEvidenceSummary(baseSummary());
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(out).toMatch(/commit/i);
  });

  it('uses ✅ when evidence_ok is true', () => {
    const out = formatEvidenceSummary(
      baseSummary({ tests_run_this_session: true, evidence_ok: true }),
    );
    expect(out).toContain('✅');
    expect(out).toMatch(/tests_run/i);
  });

  it('uses ⚠️ when evidence_ok is false', () => {
    const out = formatEvidenceSummary(
      baseSummary({ tests_run_this_session: false, evidence_ok: false }),
    );
    expect(out).toContain('⚠️');
  });

  it('mentions high risk when caller_risk is high', () => {
    const out = formatEvidenceSummary(
      baseSummary({
        affected_callers: [
          { symbol: 'foo', file: 'src/a.ts', caller_count: 14, sample_sites: [] },
        ],
        caller_risk: 'high',
      }),
    );
    expect(out).toMatch(/high/);
    expect(out).toContain('foo');
  });

  it('lists sample_sites for top affected caller', () => {
    const out = formatEvidenceSummary(
      baseSummary({
        affected_callers: [{
          symbol: 'foo',
          file: 'src/a.ts',
          caller_count: 1,
          sample_sites: [{ file: 'src/b.ts', line: 12 }],
        }],
        caller_risk: 'low',
      }),
    );
    expect(out).toMatch(/src\/b\.ts:12/);
  });

  it('truncates with +N more callers when over MAX_AFFECTED_CALLERS', () => {
    const big = baseSummary({
      affected_callers: Array.from({ length: 30 }, (_, i) => ({
        symbol: `sym${i}`,
        file: 'src/a.ts',
        caller_count: 30 - i,
        sample_sites: [],
      })),
    });
    const out = formatEvidenceSummary(big);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(out).toMatch(/\+\d+ more callers/);
  });

  it('truncates with +N more unused when over MAX_UNUSED_EXPORTS', () => {
    const big = baseSummary({
      new_unused_exports: Array.from({ length: 30 }, (_, i) => ({
        symbol: `sym${i}`,
        file: 'src/a.ts',
        kind: 'function',
      })),
    });
    const out = formatEvidenceSummary(big);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(out).toMatch(/\+\d+ more unused/);
  });

  it('mentions push/pr_create triggers in the lead', () => {
    expect(formatEvidenceSummary(baseSummary({ trigger: 'push' }))).toMatch(/push/i);
    expect(formatEvidenceSummary(baseSummary({ trigger: 'pr_create' }))).toMatch(/PR/i);
  });
});
