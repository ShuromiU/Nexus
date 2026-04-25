import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evidenceSummaryRule,
  buildEvidenceRule,
  _collectChangedFiles,
  type RunGit,
} from '../src/policy/rules/evidence-summary.js';
import { appendTestRun } from '../src/policy/session-state.js';
import type { PolicyContext, PolicyEvent, QueryEngineLike } from '../src/policy/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-d3-evidence-'));
});

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    rootDir: tmpDir,
    dbPath: path.join(tmpDir, '.nexus', 'index.db'),
    ...over,
  };
}

function ev(over: Partial<PolicyEvent> = {}): PolicyEvent {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m wip' },
    session_id: 's1',
    cwd: tmpDir,
    ...over,
  };
}

const emptyEngine: QueryEngineLike = {
  importers: () => ({ results: [], count: 0 }),
  outline: () => ({ results: [] }),
  callers: () => ({ results: [{ callers: [] }] }),
  unusedExports: () => ({ results: [] }),
};

describe('evidenceSummaryRule (skip paths)', () => {
  it('returns null on PostToolUse events', () => {
    const decision = evidenceSummaryRule.evaluate(
      ev({ hook_event_name: 'PostToolUse' }),
      ctx({ queryEngine: emptyEngine }),
    );
    expect(decision).toBeNull();
  });

  it('returns null on non-Bash tools', () => {
    const decision = evidenceSummaryRule.evaluate(
      ev({ tool_name: 'Edit', tool_input: { file_path: 'x.ts' } }),
      ctx({ queryEngine: emptyEngine }),
    );
    expect(decision).toBeNull();
  });

  it('returns null when command is not a string', () => {
    const decision = evidenceSummaryRule.evaluate(
      ev({ tool_input: { command: 42 as unknown as string } }),
      ctx({ queryEngine: emptyEngine }),
    );
    expect(decision).toBeNull();
  });

  it('returns null when command is not a recognised git/gh trigger', () => {
    const decision = evidenceSummaryRule.evaluate(
      ev({ tool_input: { command: 'git status' } }),
      ctx({ queryEngine: emptyEngine }),
    );
    expect(decision).toBeNull();
  });

  it('returns null when ctx.queryEngine is undefined', () => {
    const decision = evidenceSummaryRule.evaluate(ev(), ctx());
    expect(decision).toBeNull();
  });

  it('exposes name "evidence-summary"', () => {
    expect(evidenceSummaryRule.name).toBe('evidence-summary');
  });
});

function makeEngine(over: Partial<QueryEngineLike> = {}): QueryEngineLike {
  const base: QueryEngineLike = {
    importers: () => ({ results: [], count: 0 }),
    outline: file => ({
      results: [{
        file,
        exports: ['foo'],
        outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 5 }],
      }],
    }),
    callers: () => ({
      results: [{
        callers: Array.from({ length: 6 }, (_, i) => ({
          caller: { file: `src/c${i}.ts`, line: 10 + i },
          call_sites: [{ line: 12 + i, col: 4 }],
        })),
      }],
    }),
    unusedExports: () => ({ results: [] }),
  };
  return { ...base, ...over };
}

function gitStub(map: Record<string, string>): RunGit {
  return (args: string[]) => {
    const key = args.join(' ');
    if (key in map) return map[key];
    return '';
  };
}

describe('evidenceSummaryRule (happy path)', () => {
  it('emits allow + summary on commit with one indexed dirty source', () => {
    const runGit = gitStub({
      'status --porcelain=v1': ' M src/foo.ts\n?? scratch.md\n',
    });
    const rule = buildEvidenceRule({ runGit });
    const decision = rule.evaluate(ev(), ctx({ queryEngine: makeEngine() }));

    expect(decision?.decision).toBe('allow');
    expect(decision?.rule).toBe('evidence-summary');
    expect(decision?.additional_context).toContain('foo');
    // 6 callers → medium risk
    expect(decision?.additional_context).toMatch(/medium/);
    expect(decision?.additional_context).toMatch(/tests_run_this_session=false/);
  });

  it('returns null when working tree is clean', () => {
    const runGit = gitStub({ 'status --porcelain=v1': '' });
    const rule = buildEvidenceRule({ runGit });
    const decision = rule.evaluate(ev(), ctx({ queryEngine: makeEngine() }));
    expect(decision).toBeNull();
  });

  it('returns null when no changed file is indexed', () => {
    const runGit = gitStub({ 'status --porcelain=v1': ' M src/foo.ts\n' });
    const engine = makeEngine({ outline: () => ({ results: [] }) });
    const rule = buildEvidenceRule({ runGit });
    expect(rule.evaluate(ev(), ctx({ queryEngine: engine }))).toBeNull();
  });

  it('handles git push trigger via merge-base + diff', () => {
    const runGit = gitStub({
      'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main',
      'merge-base origin/main HEAD': 'abc123',
      'diff --name-only abc123..HEAD': 'src/foo.ts\n',
    });
    const rule = buildEvidenceRule({ runGit });
    const decision = rule.evaluate(
      ev({ tool_input: { command: 'git push' } }),
      ctx({ queryEngine: makeEngine() }),
    );
    expect(decision?.decision).toBe('allow');
    expect(decision?.additional_context).toMatch(/push/i);
  });

  it('handles gh pr create trigger', () => {
    const runGit = gitStub({
      'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main',
      'merge-base origin/main HEAD': 'abc123',
      'diff --name-only abc123..HEAD': 'src/foo.ts\n',
    });
    const rule = buildEvidenceRule({ runGit });
    const decision = rule.evaluate(
      ev({ tool_input: { command: 'gh pr create --title x' } }),
      ctx({ queryEngine: makeEngine() }),
    );
    expect(decision?.decision).toBe('allow');
    expect(decision?.additional_context).toMatch(/PR/i);
  });

  it('lists new_unused_exports when present', () => {
    const runGit = gitStub({ 'status --porcelain=v1': ' M src/foo.ts\n' });
    const engine = makeEngine({
      unusedExports: () => ({
        results: [
          { name: 'unusedFn', file: 'src/foo.ts', kind: 'function', line: 10 },
          { name: 'unusedConst', file: 'src/foo.ts', kind: 'constant', line: 20 },
        ],
      }),
    });
    const rule = buildEvidenceRule({ runGit });
    const decision = rule.evaluate(ev(), ctx({ queryEngine: engine }));
    expect(decision?.additional_context).toContain('unusedFn');
    expect(decision?.additional_context).toContain('unusedConst');
    expect(decision?.additional_context).toMatch(/evidence_ok=false/);
  });

  it('caps affected callers at 10 with overflow suffix', () => {
    const runGit = gitStub({
      'status --porcelain=v1': Array.from({ length: 30 }, (_, i) => ` M src/f${i}.ts`).join('\n') + '\n',
    });
    const engine = makeEngine({
      outline: file => ({
        results: [{
          file,
          exports: ['foo'],
          outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 5 }],
        }],
      }),
    });
    const rule = buildEvidenceRule({ runGit });
    const decision = rule.evaluate(ev(), ctx({ queryEngine: engine }));
    expect(decision?.additional_context).toMatch(/\+\d+ more callers/);
  });

  it('sets tests_run_this_session=true when session state has a record', () => {
    appendTestRun(tmpDir, 's1', { cmd: 'npm test', ts_ms: 1, exit: 0 });
    const runGit = gitStub({ 'status --porcelain=v1': ' M src/foo.ts\n' });
    const rule = buildEvidenceRule({ runGit });
    const decision = rule.evaluate(ev(), ctx({ queryEngine: makeEngine() }));
    expect(decision?.additional_context).toMatch(/tests_run_this_session=true/);
  });

  it('treats engine.unusedExports throws as empty', () => {
    const runGit = gitStub({ 'status --porcelain=v1': ' M src/foo.ts\n' });
    const engine = makeEngine({
      unusedExports: () => { throw new Error('db error'); },
    });
    const rule = buildEvidenceRule({ runGit });
    const decision = rule.evaluate(ev(), ctx({ queryEngine: engine }));
    expect(decision?.decision).toBe('allow');
    expect(decision?.additional_context).not.toContain('unusedFn');
  });

  it('treats engine.callers throws as zero callers', () => {
    const runGit = gitStub({ 'status --porcelain=v1': ' M src/foo.ts\n' });
    const engine = makeEngine({
      callers: () => { throw new Error('db error'); },
    });
    const rule = buildEvidenceRule({ runGit });
    const decision = rule.evaluate(ev(), ctx({ queryEngine: engine }));
    // 0 callers from one symbol → no affected entries with caller_count > 0,
    // but the symbol still appears with caller_count=0 → low risk.
    expect(decision?.decision).toBe('allow');
    expect(decision?.additional_context).toMatch(/caller_risk=low/);
  });

  it('returns null when runGit throws', () => {
    const runGit: RunGit = () => { throw new Error('git missing'); };
    const rule = buildEvidenceRule({ runGit });
    const decision = rule.evaluate(ev(), ctx({ queryEngine: makeEngine() }));
    expect(decision).toBeNull();
  });

  it('strips renamed paths in git status (R old -> new)', () => {
    const runGit = gitStub({
      'status --porcelain=v1': 'R  src/old.ts -> src/foo.ts\n',
    });
    const rule = buildEvidenceRule({ runGit });
    const decision = rule.evaluate(ev(), ctx({ queryEngine: makeEngine() }));
    expect(decision?.decision).toBe('allow');
    expect(decision?.additional_context).toContain('src/foo.ts');
  });
});

describe('_collectChangedFiles', () => {
  it('skips untracked files in commit mode', () => {
    const runGit = gitStub({
      'status --porcelain=v1': '?? new.ts\n M tracked.ts\n',
    });
    expect(_collectChangedFiles('/x', { kind: 'commit' }, runGit)).toEqual(['tracked.ts']);
  });

  it('returns empty when no upstream and origin/HEAD missing', () => {
    const runGit: RunGit = () => { throw new Error('not a repo'); };
    expect(_collectChangedFiles('/x', { kind: 'push' }, runGit)).toEqual([]);
  });

  it('falls back to origin/HEAD when @{u} fails', () => {
    let upstreamCalled = false;
    const runGit: RunGit = (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') {
        upstreamCalled = true;
        throw new Error('no upstream');
      }
      if (key === 'symbolic-ref refs/remotes/origin/HEAD') {
        return 'refs/remotes/origin/main\n';
      }
      if (key === 'merge-base origin/main HEAD') return 'sha\n';
      if (key === 'diff --name-only sha..HEAD') return 'src/foo.ts\n';
      return '';
    };
    const out = _collectChangedFiles('/x', { kind: 'pr_create' }, runGit);
    expect(upstreamCalled).toBe(true);
    expect(out).toEqual(['src/foo.ts']);
  });
});
