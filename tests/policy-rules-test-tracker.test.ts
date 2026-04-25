import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { testTrackerRule } from '../src/policy/rules/test-tracker.js';
import type { PolicyContext, PolicyEvent } from '../src/policy/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-d3-tracker-'));
});

function ctx(): PolicyContext {
  return { rootDir: tmpDir, dbPath: path.join(tmpDir, '.nexus', 'index.db') };
}

function ev(over: Partial<PolicyEvent> = {}): PolicyEvent {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { exit_code: 0 },
    session_id: 's1',
    ...over,
  };
}

function stateFile(): string {
  return path.join(tmpDir, '.nexus', 'session-state.json');
}

describe('testTrackerRule', () => {
  it('records a successful npm test', () => {
    const decision = testTrackerRule.evaluate(ev(), ctx());
    expect(decision).toEqual({ decision: 'noop', rule: 'test-tracker' });
    expect(fs.existsSync(stateFile())).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
    expect(parsed.session_id).toBe('s1');
    expect(parsed.tests_run).toHaveLength(1);
    expect(parsed.tests_run[0].cmd).toBe('npm test');
  });

  it('skips when exit_code is non-zero', () => {
    const decision = testTrackerRule.evaluate(
      ev({ tool_response: { exit_code: 1 } }),
      ctx(),
    );
    expect(decision).toBeNull();
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it('skips non-test commands', () => {
    const decision = testTrackerRule.evaluate(
      ev({ tool_input: { command: 'npm install' } }),
      ctx(),
    );
    expect(decision).toBeNull();
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it('skips when tool_response is missing', () => {
    const decision = testTrackerRule.evaluate(
      ev({ tool_response: undefined }),
      ctx(),
    );
    expect(decision).toBeNull();
  });

  it('skips when session_id is missing', () => {
    const decision = testTrackerRule.evaluate(
      ev({ session_id: undefined }),
      ctx(),
    );
    expect(decision).toBeNull();
  });

  it('skips PreToolUse events', () => {
    const decision = testTrackerRule.evaluate(
      ev({ hook_event_name: 'PreToolUse' }),
      ctx(),
    );
    expect(decision).toBeNull();
  });

  it('skips non-Bash tools', () => {
    const decision = testTrackerRule.evaluate(
      ev({ tool_name: 'Edit', tool_input: { command: 'npm test' } }),
      ctx(),
    );
    expect(decision).toBeNull();
  });

  it('skips when tool_input.command is not a string', () => {
    const decision = testTrackerRule.evaluate(
      ev({ tool_input: { command: 123 as unknown as string } }),
      ctx(),
    );
    expect(decision).toBeNull();
  });

  it('does not throw when the file write fails (rootDir parent is a file)', () => {
    // Create a regular file and use it as rootDir — appendTestRun's
    // mkdirSync(.nexus, recursive) will fail with ENOTDIR.
    const fakeRoot = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(fakeRoot, 'sentinel');
    const fakeCtx: PolicyContext = {
      rootDir: fakeRoot,
      dbPath: path.join(fakeRoot, '.nexus', 'index.db'),
    };
    const decision = testTrackerRule.evaluate(ev(), fakeCtx);
    expect(decision).toEqual({ decision: 'noop', rule: 'test-tracker' });
  });

  it('matches a chained "npm test && git push" on the first segment', () => {
    const decision = testTrackerRule.evaluate(
      ev({ tool_input: { command: 'npm test && git push' } }),
      ctx(),
    );
    expect(decision).toEqual({ decision: 'noop', rule: 'test-tracker' });
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
    expect(parsed.tests_run[0].cmd).toBe('npm test');
  });

  it('matches pytest', () => {
    const decision = testTrackerRule.evaluate(
      ev({ tool_input: { command: 'pytest -x' } }),
      ctx(),
    );
    expect(decision).toEqual({ decision: 'noop', rule: 'test-tracker' });
  });
});
