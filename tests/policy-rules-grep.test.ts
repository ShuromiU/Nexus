import { describe, it, expect } from 'vitest';
import { grepOnCodeRule } from '../src/policy/rules/grep-on-code.js';
import type { PolicyEvent, PolicyContext } from '../src/policy/types.js';

const ctx: PolicyContext = { rootDir: '/tmp', dbPath: '/tmp/.nexus/index.db' };

function ev(tool: string, input: Record<string, unknown>): PolicyEvent {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
}

describe('grepOnCodeRule', () => {
  it('denies bare Grep (no allowlist match)', () => {
    const d = grepOnCodeRule.evaluate(ev('Grep', { pattern: 'foo' }), ctx);
    expect(d?.decision).toBe('deny');
    expect(d?.rule).toBe('grep-on-code');
  });

  it('allows Grep when glob filter is a non-code extension', () => {
    const d = grepOnCodeRule.evaluate(ev('Grep', { pattern: 'foo', glob: '*.md' }), ctx);
    expect(d?.decision).toBe('allow');
  });

  it('allows Grep when type is a non-code type', () => {
    const d = grepOnCodeRule.evaluate(ev('Grep', { pattern: 'foo', type: 'md' }), ctx);
    expect(d?.decision).toBe('allow');
  });

  it('allows Grep on node_modules', () => {
    const d = grepOnCodeRule.evaluate(ev('Grep', { pattern: 'foo', path: 'node_modules/react' }), ctx);
    expect(d?.decision).toBe('allow');
  });

  it('allows Grep on docs/', () => {
    const d = grepOnCodeRule.evaluate(ev('Grep', { pattern: 'foo', path: 'docs/whatever.md' }), ctx);
    expect(d?.decision).toBe('allow');
  });

  it('ignores non-Grep tools', () => {
    const d = grepOnCodeRule.evaluate(ev('Glob', { pattern: '*.ts' }), ctx);
    expect(d).toBeNull();
  });

  it('ignores Grep with non-string input (defensive)', () => {
    const d = grepOnCodeRule.evaluate(
      { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 123 } },
      ctx,
    );
    expect(d?.decision).toBe('deny');
  });
});
