import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { preeditImpactRule } from '../src/policy/rules/preedit-impact.js';
import type {
  PolicyEvent,
  PolicyContext,
  QueryEngineLike,
  OutlineForImpact,
} from '../src/policy/types.js';

let tmpDir: string;

function ev(tool: string, input: Record<string, unknown>): PolicyEvent {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
}

function writeFile(rel: string, content: string): string {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function makeEngine(overrides: Partial<QueryEngineLike> = {}): QueryEngineLike {
  return {
    importers: () => ({ results: [], count: 0 }),
    outline: () => ({ results: [] }),
    callers: () => ({ results: [{ callers: [] }] }),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-preimpact-'));
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('preeditImpactRule — Edit path', () => {
  it('allows + summarizes an edit on an exported top-level symbol with importers', () => {
    const abs = writeFile(
      'src/bar.ts',
      'export function foo() {\n  return 1;\n}\n',
    );
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 3 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }, { file: 'src/b.ts' }], count: 2 }),
      outline: () => ({ results: [outline] }),
      callers: () => ({ results: [{ callers: new Array(6) }] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'return 1;' }),
      ctx,
    );
    expect(d?.decision).toBe('allow');
    expect(d?.rule).toBe('preedit-impact');
    expect(d?.additional_context).toMatch(/foo/);
    expect(d?.additional_context).toMatch(/medium/);
    expect(d?.additional_context).toMatch(/nexus_callers/);
  });

  it('returns null when file has 0 importers', () => {
    const abs = writeFile('src/bar.ts', 'export function foo() { return 1; }\n');
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 1 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'return 1;' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null when edited symbol is a private helper (not in exports)', () => {
    const abs = writeFile(
      'src/bar.ts',
      'export function foo() {}\n\nfunction helper() {\n  return 2;\n}\n',
    );
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [
        { name: 'foo', kind: 'function', line: 1, end_line: 1 },
        { name: 'helper', kind: 'function', line: 3, end_line: 5 },
      ],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'return 2;' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null when old_string is not present in file', () => {
    const abs = writeFile('src/bar.ts', 'export function foo() { return 1; }\n');
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 1 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'nonexistent string' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null when ctx.queryEngine is undefined', () => {
    const abs = writeFile('src/bar.ts', 'export function foo() { return 1; }\n');
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'return 1;' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for Edit on package.json (structured kind)', () => {
    const abs = writeFile('package.json', '{"name":"x"}\n');
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: '"name":"x"' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null when the file is over the 2 MB hot-path cap', () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const abs = writeFile('src/bar.ts', `export function foo() {}\n${huge}`);
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 1 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Edit', { file_path: abs, old_string: 'export function foo() {}' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for non-Edit/Write tool', () => {
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: makeEngine(),
    };
    expect(
      preeditImpactRule.evaluate(ev('Read', { file_path: 'src/bar.ts' }), ctx),
    ).toBeNull();
  });

  it('returns null when old_string is missing or non-string', () => {
    const abs = writeFile('src/bar.ts', 'export function foo() {}\n');
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    expect(
      preeditImpactRule.evaluate(ev('Edit', { file_path: abs }), ctx),
    ).toBeNull();
    expect(
      preeditImpactRule.evaluate(
        ev('Edit', { file_path: abs, old_string: 123 }),
        ctx,
      ),
    ).toBeNull();
  });

  it('returns null for missing file_path', () => {
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: makeEngine(),
    };
    expect(preeditImpactRule.evaluate(ev('Edit', {}), ctx)).toBeNull();
  });
});

describe('preeditImpactRule — Write path', () => {
  it('returns null for Write on a non-existent file (new file)', () => {
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: makeEngine({
        importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      }),
    };
    const d = preeditImpactRule.evaluate(
      ev('Write', { file_path: path.join(tmpDir, 'src/new.ts'), content: 'x' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('returns null for Write on existing file with 0 importers', () => {
    const abs = writeFile('src/bar.ts', 'export function foo() {}\n');
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo'],
      outline: [{ name: 'foo', kind: 'function', line: 1, end_line: 1 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [], count: 0 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Write', { file_path: abs, content: 'new content' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('allows + lists top symbols for Write on existing source with multiple exports', () => {
    const abs = writeFile(
      'src/bar.ts',
      'export function foo() {}\nexport function bar() {}\nexport function baz() {}\n',
    );
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo', 'bar', 'baz'],
      outline: [
        { name: 'foo', kind: 'function', line: 1, end_line: 1 },
        { name: 'bar', kind: 'function', line: 2, end_line: 2 },
        { name: 'baz', kind: 'function', line: 3, end_line: 3 },
      ],
    };
    const callerCounts: Record<string, number> = { foo: 6, bar: 2, baz: 14 };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }, { file: 'src/b.ts' }], count: 2 }),
      outline: () => ({ results: [outline] }),
      callers: (name) => ({ results: [{ callers: new Array(callerCounts[name] ?? 0) }] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Write', { file_path: abs, content: 'new content' }),
      ctx,
    );
    expect(d?.decision).toBe('allow');
    expect(d?.rule).toBe('preedit-impact');
    expect(d?.additional_context).toMatch(/3 exported/);
    expect(d?.additional_context).toMatch(/high/);
    expect(d?.additional_context).toMatch(/baz/);
    expect(d?.additional_context).toMatch(/14/);
  });

  it('returns null for Write on existing source with importers but no exports', () => {
    const abs = writeFile('src/bar.ts', 'function helper() {}\n');
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: [],
      outline: [{ name: 'helper', kind: 'function', line: 1, end_line: 1 }],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [outline] }),
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Write', { file_path: abs, content: 'new content' }),
      ctx,
    );
    expect(d).toBeNull();
  });

  it('treats caller() throw as 0 callers for that symbol on Write', () => {
    const abs = writeFile(
      'src/bar.ts',
      'export function foo() {}\nexport function bar() {}\n',
    );
    const outline: OutlineForImpact = {
      file: 'src/bar.ts',
      exports: ['foo', 'bar'],
      outline: [
        { name: 'foo', kind: 'function', line: 1, end_line: 1 },
        { name: 'bar', kind: 'function', line: 2, end_line: 2 },
      ],
    };
    const engine = makeEngine({
      importers: () => ({ results: [{ file: 'src/a.ts' }], count: 1 }),
      outline: () => ({ results: [outline] }),
      callers: (name) => {
        if (name === 'foo') throw new Error('boom');
        return { results: [{ callers: new Array(4) }] };
      },
    });
    const ctx: PolicyContext = {
      rootDir: tmpDir,
      dbPath: path.join(tmpDir, '.nexus/index.db'),
      queryEngine: engine,
    };
    const d = preeditImpactRule.evaluate(
      ev('Write', { file_path: abs, content: 'new content' }),
      ctx,
    );
    expect(d?.decision).toBe('allow');
    expect(d?.additional_context).toMatch(/bar/);
  });
});
