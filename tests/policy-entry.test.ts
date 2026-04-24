import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const ENTRY = path.resolve('dist/transports/policy-entry.js');

beforeAll(() => {
  // Make sure the build output exists. If not, fail fast with a clear message.
  if (!fs.existsSync(ENTRY)) {
    throw new Error(`policy-entry not built. Run "npm run build" before this test.`);
  }
});

function run(stdinJson: unknown, cwd = process.cwd()) {
  return spawnSync('node', [ENTRY], {
    input: JSON.stringify(stdinJson),
    encoding: 'utf-8',
    cwd,
  });
}

describe('policy-entry', () => {
  it('denies Grep on a code file with reason text', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('deny');
    expect(typeof parsed.reason).toBe('string');
    expect(parsed.reason).toMatch(/NEXUS ONLY/);
    expect(typeof parsed.stale_hint).toBe('boolean');
  });

  it('allows Grep on a non-code glob', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'foo', glob: '*.md' },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
  });

  it('defaults to allow on unmatched tools', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
  });

  it('exits 0 with decision=allow on malformed stdin', () => {
    const result = run('not-json-at-all');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
    expect(parsed.rule).toBe('parse-error');
  });

  it('asks for Read on package.json with structured-tool suggestion', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'package.json' },
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('ask');
    expect(parsed.rule).toBe('read-on-structured');
    expect(parsed.reason).toMatch(/nexus_structured_query|nexus_structured_outline/);
  });

  it('asks for Read on yarn.lock with lockfile suggestion', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'yarn.lock' },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('ask');
    expect(parsed.reason).toMatch(/nexus_lockfile_deps/);
  });

  it('allows bare Read on a source file with additional_context', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/index.ts' },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
    expect(parsed.rule).toBe('read-on-source');
    expect(parsed.additional_context).toMatch(/nexus_outline/);
  });

  it('allows paged Read without additional_context', () => {
    const result = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/index.ts', offset: 0, limit: 100 },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('allow');
    expect(parsed.additional_context).toBeUndefined();
  });
});
