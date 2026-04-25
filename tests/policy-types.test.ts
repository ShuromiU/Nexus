import { describe, it, expect } from 'vitest';
import type {
  PolicyContext,
  PolicyEvent,
  PolicyDecision,
  PolicyResponse,
  PolicyRule,
  QueryEngineLike,
  OutlineForImpact,
  OutlineEntryForImpact,
} from '../src/policy/types.js';

describe('policy types', () => {
  it('PolicyDecision is one of allow|ask|deny|noop', () => {
    const decisions: PolicyDecision['decision'][] = ['allow', 'ask', 'deny', 'noop'];
    expect(decisions).toEqual(['allow', 'ask', 'deny', 'noop']);
  });

  it('PolicyEvent is structurally a Claude Code PreToolUse payload', () => {
    const event: PolicyEvent = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
      session_id: 'test',
      cwd: '/tmp',
    };
    expect(event.tool_name).toBe('Grep');
  });

  it('PolicyResponse carries stale_hint and optional decision', () => {
    const resp: PolicyResponse = {
      decision: 'allow',
      stale_hint: false,
    };
    expect(resp.stale_hint).toBe(false);
  });

  it('PolicyDecision and PolicyResponse accept optional additional_context', () => {
    const decision: PolicyDecision = {
      decision: 'allow',
      rule: 'x',
      additional_context: 'use nexus_outline',
    };
    const resp: PolicyResponse = {
      decision: 'allow',
      stale_hint: false,
      additional_context: 'use nexus_outline',
    };
    expect(decision.additional_context).toBe('use nexus_outline');
    expect(resp.additional_context).toBe('use nexus_outline');
  });

  it('PolicyRule has name + evaluate signature', () => {
    const rule: PolicyRule = {
      name: 'test-rule',
      evaluate: () => null,
    };
    expect(rule.name).toBe('test-rule');
  });

  it('PolicyContext accepts an optional QueryEngineLike', () => {
    const stubEngine: QueryEngineLike = {
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [] }),
      callers: () => ({ results: [{ callers: [] }] }),
    };
    const ctx: PolicyContext = {
      rootDir: '/tmp',
      dbPath: '/tmp/.nexus/index.db',
      queryEngine: stubEngine,
    };
    expect(ctx.queryEngine).toBeDefined();
  });

  it('OutlineForImpact and OutlineEntryForImpact compile as expected', () => {
    const entry: OutlineEntryForImpact = {
      name: 'foo',
      kind: 'function',
      line: 10,
      end_line: 20,
    };
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [entry],
    };
    expect(outline.outline[0].name).toBe('foo');
  });

  it('QueryEngineLike methods return the expected envelope shape', () => {
    const engine: QueryEngineLike = {
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [{ file: 'src/b.ts', exports: [], outline: [] }] }),
      callers: (_name, _opts) => ({ results: [{ callers: [] }] }),
      unusedExports: () => ({ results: [] }),
    };
    expect(engine.importers('src/b.ts').count).toBe(1);
    expect(engine.outline('src/b.ts').results.length).toBe(1);
    expect(engine.callers('foo', { file: 'src/b.ts', limit: 50 }).results[0].callers.length).toBe(0);
  });

  it('PolicyEvent accepts an optional tool_response', () => {
    const event: PolicyEvent = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0, stdout: '', stderr: '' },
      session_id: 's1',
    };
    expect(event.tool_response?.exit_code).toBe(0);
  });

  it('QueryEngineLike exposes unusedExports', () => {
    const engine: QueryEngineLike = {
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [] }),
      callers: () => ({ results: [{ callers: [] }] }),
      unusedExports: () => ({
        results: [{ name: 'foo', file: 'src/a.ts', kind: 'function', line: 1 }],
      }),
    };
    expect(engine.unusedExports().results[0].name).toBe('foo');
    expect(
      engine.unusedExports({ path: 'src/a.ts', limit: 5, mode: 'default' }).results.length,
    ).toBe(1);
  });

  it('QueryEngineLike.callers exposes the richer call_sites shape', () => {
    const engine: QueryEngineLike = {
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [] }),
      callers: () => ({
        results: [{
          callers: [{
            caller: { file: 'src/x.ts', line: 10 },
            call_sites: [{ line: 12, col: 4 }],
          }],
        }],
      }),
      unusedExports: () => ({ results: [] }),
    };
    const c = engine.callers('foo').results[0].callers[0];
    expect(c.caller?.file).toBe('src/x.ts');
    expect(c.call_sites?.[0].line).toBe(12);
  });
});
