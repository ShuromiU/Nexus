import { describe, it, expect } from 'vitest';
import { readOnStructuredRule } from '../src/policy/rules/read-on-structured.js';
import type { PolicyEvent, PolicyContext } from '../src/policy/types.js';

const ctx: PolicyContext = { rootDir: '/tmp', dbPath: '/tmp/.nexus/index.db' };

function ev(tool: string, input: Record<string, unknown>): PolicyEvent {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
}

describe('readOnStructuredRule', () => {
  const structuredCases: Array<[string, string, RegExp]> = [
    ['package.json', 'package_json', /nexus_structured_query|nexus_structured_outline/],
    ['tsconfig.json', 'tsconfig_json', /nexus_structured_query|nexus_structured_outline/],
    ['Cargo.toml', 'cargo_toml', /nexus_structured_query|nexus_structured_outline/],
    ['.github/workflows/ci.yml', 'gha_workflow', /nexus_structured_query|nexus_structured_outline/],
    ['some-config.json', 'json_generic', /nexus_structured_query|nexus_structured_outline/],
    ['some-config.yaml', 'yaml_generic', /nexus_structured_query|nexus_structured_outline/],
    ['some-config.toml', 'toml_generic', /nexus_structured_query|nexus_structured_outline/],
  ];

  for (const [filePath, , reasonPattern] of structuredCases) {
    it(`asks for ${filePath}`, () => {
      const d = readOnStructuredRule.evaluate(ev('Read', { file_path: filePath }), ctx);
      expect(d?.decision).toBe('ask');
      expect(d?.rule).toBe('read-on-structured');
      expect(d?.reason).toMatch(reasonPattern);
    });
  }

  const lockfileCases: Array<[string, string]> = [
    ['yarn.lock', 'yarn_lock'],
    ['package-lock.json', 'package_lock'],
    ['pnpm-lock.yaml', 'pnpm_lock'],
    ['Cargo.lock', 'cargo_lock'],
  ];

  for (const [filePath] of lockfileCases) {
    it(`asks for ${filePath} with nexus_lockfile_deps suggestion`, () => {
      const d = readOnStructuredRule.evaluate(ev('Read', { file_path: filePath }), ctx);
      expect(d?.decision).toBe('ask');
      expect(d?.rule).toBe('read-on-structured');
      expect(d?.reason).toMatch(/nexus_lockfile_deps/);
    });
  }

  it('returns null for source files', () => {
    const d = readOnStructuredRule.evaluate(ev('Read', { file_path: 'src/foo.ts' }), ctx);
    expect(d).toBeNull();
  });

  it('returns null for ignored kinds (e.g. README.md)', () => {
    const d = readOnStructuredRule.evaluate(ev('Read', { file_path: 'README.md' }), ctx);
    expect(d).toBeNull();
  });

  it('returns null for non-Read tools', () => {
    const d = readOnStructuredRule.evaluate(ev('Edit', { file_path: 'package.json' }), ctx);
    expect(d).toBeNull();
  });

  it('returns null when file_path is missing', () => {
    const d = readOnStructuredRule.evaluate(ev('Read', {}), ctx);
    expect(d).toBeNull();
  });

  it('returns null when file_path is not a string', () => {
    const d = readOnStructuredRule.evaluate(ev('Read', { file_path: 123 }), ctx);
    expect(d).toBeNull();
  });

  it('normalizes backslash paths (Windows)', () => {
    const d = readOnStructuredRule.evaluate(ev('Read', { file_path: 'src\\..\\package.json' }), ctx);
    // Path is not exact-basename `package.json` (it has `..`), but the basename
    // extraction should still find `package.json` as the final segment.
    expect(d?.decision).toBe('ask');
  });
});
