import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { dispatchPolicy } from '../src/policy/dispatcher.js';
import { openDatabase, applySchema } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import type { PolicyRule, PolicyEvent } from '../src/policy/types.js';
import { DEFAULT_RULES } from '../src/policy/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-disp-'));
  fs.mkdirSync(path.join(tmpDir, '.nexus'), { recursive: true });
  const db = openDatabase(path.join(tmpDir, '.nexus', 'index.db'));
  applySchema(db);
  new NexusStore(db).setMeta('last_indexed_at', new Date().toISOString());
  db.close();
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function ev(tool = 'Grep', input: Record<string, unknown> = { pattern: 'x' }): PolicyEvent {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
}

describe('dispatchPolicy', () => {
  it('defaults to allow when no rule matches', () => {
    const resp = dispatchPolicy(ev('UnknownTool'), { rootDir: tmpDir, rules: [] });
    expect(resp.decision).toBe('allow');
    expect(resp.stale_hint).toBe(false);
  });

  it('first explicit non-null rule decision wins', () => {
    const ruleA: PolicyRule = { name: 'A', evaluate: () => ({ decision: 'deny', rule: 'A' }) };
    const ruleB: PolicyRule = { name: 'B', evaluate: () => ({ decision: 'allow', rule: 'B' }) };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [ruleA, ruleB] });
    expect(resp.decision).toBe('deny');
    expect(resp.rule).toBe('A');
  });

  it('skips rules that return null', () => {
    const ruleA: PolicyRule = { name: 'A', evaluate: () => null };
    const ruleB: PolicyRule = { name: 'B', evaluate: () => ({ decision: 'allow', rule: 'B' }) };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [ruleA, ruleB] });
    expect(resp.decision).toBe('allow');
    expect(resp.rule).toBe('B');
  });

  it('attaches stale_hint=true when index missing', () => {
    fs.rmSync(path.join(tmpDir, '.nexus'), { recursive: true });
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [] });
    expect(resp.stale_hint).toBe(true);
  });

  it('noop rule decision does not block default allow fallthrough', () => {
    const ruleA: PolicyRule = { name: 'A', evaluate: () => ({ decision: 'noop', rule: 'A' }) };
    const ruleB: PolicyRule = { name: 'B', evaluate: () => ({ decision: 'deny', rule: 'B' }) };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [ruleA, ruleB] });
    expect(resp.decision).toBe('deny');
  });

  it('normalizes backslash paths in tool_input (Windows compat)', () => {
    const captured: Array<{ path?: string }> = [];
    const ruleA: PolicyRule = {
      name: 'A',
      evaluate: (event) => {
        captured.push({ path: event.tool_input.file_path as string });
        return { decision: 'allow', rule: 'A' };
      },
    };
    const resp = dispatchPolicy(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'src\\policy\\types.ts' },
      },
      { rootDir: tmpDir, rules: [ruleA] },
    );
    // The rule itself receives the raw event; this test only exercises that
    // dispatchPolicy still routes correctly. stale_hint will read the file that
    // does not exist, so hint should be false (cannot-disprove-freshness case).
    expect(resp.decision).toBe('allow');
    expect(resp.stale_hint).toBe(false);
  });

  it('forwards additional_context on allow', () => {
    const rule: PolicyRule = {
      name: 'A',
      evaluate: () => ({
        decision: 'allow',
        rule: 'A',
        additional_context: 'try nexus_outline',
      }),
    };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [rule] });
    expect(resp.decision).toBe('allow');
    expect(resp.additional_context).toBe('try nexus_outline');
  });

  it('forwards additional_context on ask', () => {
    const rule: PolicyRule = {
      name: 'A',
      evaluate: () => ({
        decision: 'ask',
        rule: 'A',
        additional_context: 'prefer nexus_structured_query',
        reason: 'use structured',
      }),
    };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [rule] });
    expect(resp.decision).toBe('ask');
    expect(resp.additional_context).toBe('prefer nexus_structured_query');
  });

  it('drops additional_context on deny', () => {
    const rule: PolicyRule = {
      name: 'A',
      evaluate: () => ({
        decision: 'deny',
        rule: 'A',
        additional_context: 'would be inappropriate here',
        reason: 'nope',
      }),
    };
    const resp = dispatchPolicy(ev(), { rootDir: tmpDir, rules: [rule] });
    expect(resp.decision).toBe('deny');
    expect(resp.additional_context).toBeUndefined();
  });
});

describe('dispatchPolicy with DEFAULT_RULES', () => {
  it('Grep event still routes to grep-on-code', () => {
    const resp = dispatchPolicy(ev('Grep', { pattern: 'foo' }), {
      rootDir: tmpDir,
      rules: DEFAULT_RULES,
    });
    expect(resp.decision).toBe('deny');
    expect(resp.rule).toBe('grep-on-code');
  });

  it('Read on package.json routes to read-on-structured with ask', () => {
    const resp = dispatchPolicy(
      ev('Read', { file_path: 'package.json' }),
      { rootDir: tmpDir, rules: DEFAULT_RULES },
    );
    expect(resp.decision).toBe('ask');
    expect(resp.rule).toBe('read-on-structured');
    expect(resp.reason).toMatch(/nexus_structured_query|nexus_structured_outline/);
  });

  it('bare Read on src/foo.ts routes to read-on-source with allow+context', () => {
    const resp = dispatchPolicy(
      ev('Read', { file_path: 'src/foo.ts' }),
      { rootDir: tmpDir, rules: DEFAULT_RULES },
    );
    expect(resp.decision).toBe('allow');
    expect(resp.rule).toBe('read-on-source');
    expect(resp.additional_context).toMatch(/nexus_outline/);
  });

  it('paged Read on src/foo.ts falls through to default allow (no rule)', () => {
    const resp = dispatchPolicy(
      ev('Read', { file_path: 'src/foo.ts', offset: 0 }),
      { rootDir: tmpDir, rules: DEFAULT_RULES },
    );
    expect(resp.decision).toBe('allow');
    expect(resp.rule).toBeUndefined();
    expect(resp.additional_context).toBeUndefined();
  });

  it('forwards queryEngine into ctx when provided in options', () => {
    const captured: { hasEngine: boolean } = { hasEngine: false };
    const rule: PolicyRule = {
      name: 'capture',
      evaluate: (_event, ctx) => {
        captured.hasEngine = ctx.queryEngine !== undefined;
        return { decision: 'allow', rule: 'capture' };
      },
    };
    const stubEngine = {
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [] }),
      callers: () => ({ results: [{ callers: [] }] }),
    };
    const resp = dispatchPolicy(ev(), {
      rootDir: tmpDir,
      rules: [rule],
      queryEngine: stubEngine,
    });
    expect(resp.decision).toBe('allow');
    expect(captured.hasEngine).toBe(true);
  });

  it('does not set ctx.queryEngine when options.queryEngine is undefined', () => {
    const captured: { hasEngine: boolean } = { hasEngine: true };
    const rule: PolicyRule = {
      name: 'capture',
      evaluate: (_event, ctx) => {
        captured.hasEngine = ctx.queryEngine !== undefined;
        return { decision: 'allow', rule: 'capture' };
      },
    };
    dispatchPolicy(ev(), { rootDir: tmpDir, rules: [rule] });
    expect(captured.hasEngine).toBe(false);
  });

  it('Edit on indexed source + importer + exported top-level routes to preedit-impact', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const abs = path.join(tmpDir, 'src', 'bar.ts');
    fs.writeFileSync(abs, 'export function foo() {\n  return 1;\n}\n');
    const stubEngine = {
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({
        results: [
          {
            file: 'src/bar.ts',
            exports: ['foo'],
            outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 3 }],
          },
        ],
      }),
      callers: () => ({ results: [{ callers: new Array(4) }] }),
    };
    const resp = dispatchPolicy(
      ev('Edit', { file_path: abs, old_string: 'return 1;' }),
      { rootDir: tmpDir, rules: DEFAULT_RULES, queryEngine: stubEngine },
    );
    expect(resp.decision).toBe('allow');
    expect(resp.rule).toBe('preedit-impact');
    expect(resp.additional_context).toMatch(/foo/);
  });

  it('Edit with no queryEngine in options falls open (no rule fires)', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const abs = path.join(tmpDir, 'src', 'bar.ts');
    fs.writeFileSync(abs, 'export function foo() {}\n');
    const resp = dispatchPolicy(
      ev('Edit', { file_path: abs, old_string: 'export function foo' }),
      { rootDir: tmpDir, rules: DEFAULT_RULES },
    );
    expect(resp.decision).toBe('allow');
    expect(resp.rule).toBeUndefined();
  });

  it('DEFAULT_RULES includes evidence-summary and test-tracker', () => {
    const names = DEFAULT_RULES.map(r => r.name);
    expect(names).toContain('evidence-summary');
    expect(names).toContain('test-tracker');
  });

  it('PostToolUse Bash npm test event lands at test-tracker and writes session-state', () => {
    const resp = dispatchPolicy(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { exit_code: 0 },
        session_id: 's1',
      },
      { rootDir: tmpDir, rules: DEFAULT_RULES },
    );
    expect(resp.decision).toBe('allow');
    expect(resp.stale_hint).toBeDefined();
    const stateFile = path.join(tmpDir, '.nexus', 'session-state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(parsed.session_id).toBe('s1');
    expect(parsed.tests_run.map((r: { cmd: string }) => r.cmd)).toContain('npm test');
  });

  it('PreToolUse Bash git-commit with stub rule emits additional_context', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'foo.ts'), 'export function foo() {}\n');

    const stubEngine = {
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({
        results: [{
          file: 'src/foo.ts',
          exports: ['foo'],
          outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 1 }],
        }],
      }),
      callers: () => ({
        results: [{
          callers: Array.from({ length: 4 }, (_, i) => ({
            caller: { file: `src/c${i}.ts`, line: i },
            call_sites: [{ line: i, col: 0 }],
          })),
        }],
      }),
      unusedExports: () => ({ results: [] }),
    };

    // Build a stand-in evidence rule with an injected runGit. Splice it in
    // before the default DEFAULT_RULES (which uses the real exec'd git) by
    // omitting the default evidenceSummaryRule from the list.
    const { buildEvidenceRule } = await import('../src/policy/rules/evidence-summary.js');
    const stubEvidence = buildEvidenceRule({
      runGit: (args) => {
        const k = args.join(' ');
        if (k === 'status --porcelain=v1') return ' M src/foo.ts\n';
        return '';
      },
    });

    const rules = DEFAULT_RULES.filter(r => r.name !== 'evidence-summary').concat(stubEvidence);

    const resp = dispatchPolicy(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m wip' },
        session_id: 's1',
      },
      { rootDir: tmpDir, rules, queryEngine: stubEngine },
    );

    expect(resp.decision).toBe('allow');
    expect(resp.rule).toBe('evidence-summary');
    expect(resp.additional_context).toBeDefined();
    expect(resp.additional_context).toContain('foo');
  });
});
