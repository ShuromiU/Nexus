import { describe, it, expect } from 'vitest';
import { readOnSourceRule } from '../src/policy/rules/read-on-source.js';
import type { PolicyEvent, PolicyContext } from '../src/policy/types.js';

const ctx: PolicyContext = { rootDir: '/tmp', dbPath: '/tmp/.nexus/index.db' };

function ev(tool: string, input: Record<string, unknown>): PolicyEvent {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
}

describe('readOnSourceRule', () => {
  it('allows + adds additional_context for a bare Read on a .ts file', () => {
    const d = readOnSourceRule.evaluate(ev('Read', { file_path: 'src/foo.ts' }), ctx);
    expect(d?.decision).toBe('allow');
    expect(d?.rule).toBe('read-on-source');
    expect(d?.additional_context).toMatch(/nexus_outline/);
    expect(d?.additional_context).toMatch(/nexus_source/);
    expect(d?.additional_context).toMatch(/stale_hint/);
  });

  it('returns null when offset is present', () => {
    const d = readOnSourceRule.evaluate(ev('Read', { file_path: 'src/foo.ts', offset: 0 }), ctx);
    expect(d).toBeNull();
  });

  it('returns null when limit is present', () => {
    const d = readOnSourceRule.evaluate(ev('Read', { file_path: 'src/foo.ts', limit: 100 }), ctx);
    expect(d).toBeNull();
  });

  it('returns null when both offset and limit are present', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'src/foo.ts', offset: 10, limit: 100 }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for node_modules paths', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'node_modules/react/index.ts' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for docs/ paths', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'docs/example.ts' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for .nexus/ paths', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: '.nexus/index.db' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for README.md (ignored kind)', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'README.md' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for package.json (structured kind)', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'package.json' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for non-Read tools', () => {
    const d = readOnSourceRule.evaluate(
      ev('Edit', { file_path: 'src/foo.ts' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null when file_path is missing', () => {
    const d = readOnSourceRule.evaluate(ev('Read', {}), ctx);
    expect(d).toBeNull();
  });

  it('returns null when file_path is not a string', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 123 }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('matches .py, .go, .rs, .java, .cs sources', () => {
    for (const ext of ['py', 'go', 'rs', 'java', 'cs']) {
      const d = readOnSourceRule.evaluate(
        ev('Read', { file_path: `src/x.${ext}` }),
        ctx,
      );
      expect(d?.decision).toBe('allow');
    }
  });

  it('normalizes backslash paths (Windows)', () => {
    const d = readOnSourceRule.evaluate(
      ev('Read', { file_path: 'src\\foo.ts' }),
      ctx,
    );
    expect(d?.decision).toBe('allow');
  });
});
