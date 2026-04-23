import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { dispatchPolicy } from '../src/policy/dispatcher.js';
import { openDatabase, applySchema } from '../src/db/schema.js';
import { NexusStore } from '../src/db/store.js';
import type { PolicyRule, PolicyEvent } from '../src/policy/types.js';

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
});
