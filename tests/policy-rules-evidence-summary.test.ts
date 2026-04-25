import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evidenceSummaryRule } from '../src/policy/rules/evidence-summary.js';
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
