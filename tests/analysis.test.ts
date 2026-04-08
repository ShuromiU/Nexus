import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { getParser, parseSource, resolveGrammar, hasGrammar, supportedGrammars } from '../src/analysis/parser.js';
import { getAdapter, hasAdapter, getAllAdapters } from '../src/analysis/languages/registry.js';
import { extractFile, extractSource } from '../src/analysis/extractor.js';

// ── Parser Tests ────────────────────────────────────────────────────────

describe('parser', () => {
  it('has grammars for all supported languages', () => {
    expect(hasGrammar('typescript')).toBe(true);
    expect(hasGrammar('tsx')).toBe(true);
    expect(hasGrammar('javascript')).toBe(true);
    expect(hasGrammar('jsx')).toBe(true);
    expect(hasGrammar('python')).toBe(true);
    expect(hasGrammar('go')).toBe(true);
    expect(hasGrammar('rust')).toBe(true);
    expect(hasGrammar('java')).toBe(true);
    expect(hasGrammar('csharp')).toBe(true);
    expect(hasGrammar('cobol')).toBe(false);
  });

  it('lists supported grammars', () => {
    const grammars = supportedGrammars();
    expect(grammars).toContain('typescript');
    expect(grammars).toContain('tsx');
    expect(grammars).toContain('javascript');
    expect(grammars).toContain('jsx');
  });

  it('resolves grammar based on language + extension', () => {
    expect(resolveGrammar('typescript', 'foo.ts')).toBe('typescript');
    expect(resolveGrammar('typescript', 'foo.tsx')).toBe('tsx');
    expect(resolveGrammar('javascript', 'bar.js')).toBe('javascript');
    expect(resolveGrammar('javascript', 'bar.jsx')).toBe('jsx');
    expect(resolveGrammar('python', 'baz.py')).toBe('python');
    expect(resolveGrammar('go', 'baz.go')).toBe('go');
    expect(resolveGrammar('rust', 'baz.rs')).toBe('rust');
    expect(resolveGrammar('java', 'Baz.java')).toBe('java');
    expect(resolveGrammar('csharp', 'Baz.cs')).toBe('csharp');
    expect(resolveGrammar('cobol', 'baz.cob')).toBe(null);
  });

  it('returns a parser for typescript', () => {
    const parser = getParser('typescript');
    expect(parser).not.toBeNull();
  });

  it('parses TypeScript source code', () => {
    const tree = parseSource('const x = 42;', 'typescript');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('program');
    expect(tree!.rootNode.childCount).toBeGreaterThan(0);
  });

  it('returns null for unsupported language', () => {
    const parser = getParser('cobol');
    expect(parser).toBeNull();
  });
});

// ── Registry Tests ──────────────────────────────────────────────────────

describe('registry', () => {
  it('has adapters for all supported languages', () => {
    expect(hasAdapter('typescript')).toBe(true);
    expect(hasAdapter('javascript')).toBe(true);
    expect(hasAdapter('python')).toBe(true);
    expect(hasAdapter('go')).toBe(true);
    expect(hasAdapter('rust')).toBe(true);
    expect(hasAdapter('java')).toBe(true);
    expect(hasAdapter('csharp')).toBe(true);
    expect(hasAdapter('cobol')).toBe(false);
  });

  it('returns adapter with correct capabilities', () => {
    const adapter = getAdapter('typescript')!;
    expect(adapter).not.toBeNull();
    expect(adapter.capabilities).toEqual({
      definitions: true,
      imports: true,
      exports: true,
      occurrences: true,
      occurrenceQuality: 'heuristic',
      typeExports: true,
      docstrings: true,
      signatures: true,
    });
  });

  it('lists all registered adapters', () => {
    const adapters = getAllAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(2);
    const languages = adapters.map(a => a.language);
    expect(languages).toContain('typescript');
    expect(languages).toContain('javascript');
  });
});

// ── Symbol Extraction Tests ─────────────────────────────────────────────

describe('symbol extraction', () => {
  const fixtureFile = path.resolve(__dirname, 'fixtures/sample.ts');

  it('extracts from golden fixture file', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    expect(result.parsed).toBe(true);
    if (!result.parsed) return;

    const symbolNames = result.symbols.map(s => s.name);
    expect(symbolNames).toContain('MAX_RETRIES');
    expect(symbolNames).toContain('counter');
    expect(symbolNames).toContain('greet');
    expect(symbolNames).toContain('User');
    expect(symbolNames).toContain('Result');
    expect(symbolNames).toContain('Status');
    expect(symbolNames).toContain('UserService');
    expect(symbolNames).toContain('useAuth');
    expect(symbolNames).toContain('fetchData');
    expect(symbolNames).toContain('INTERNAL_CONSTANT');
  });

  it('classifies symbol kinds correctly', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const byName = new Map(result.symbols.map(s => [s.name, s]));

    expect(byName.get('MAX_RETRIES')?.kind).toBe('constant');
    expect(byName.get('counter')?.kind).toBe('variable');
    expect(byName.get('greet')?.kind).toBe('function');
    expect(byName.get('User')?.kind).toBe('interface');
    expect(byName.get('Result')?.kind).toBe('type');
    expect(byName.get('Status')?.kind).toBe('enum');
    expect(byName.get('UserService')?.kind).toBe('class');
    expect(byName.get('useAuth')?.kind).toBe('hook');
    expect(byName.get('fetchData')?.kind).toBe('function');
    expect(byName.get('INTERNAL_CONSTANT')?.kind).toBe('constant');
  });

  it('extracts class methods with scope', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const methods = result.symbols.filter(s => s.kind === 'method');
    expect(methods.length).toBe(2); // create, findUser
    expect(methods.map(m => m.name).sort()).toEqual(['create', 'findUser']);
    expect(methods.every(m => m.scope === 'UserService')).toBe(true);
  });

  it('extracts JSDoc comments', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const byName = new Map(result.symbols.map(s => [s.name, s]));

    expect(byName.get('MAX_RETRIES')?.doc).toContain('Maximum retry count');
    expect(byName.get('greet')?.doc).toContain('Greets a person');
    expect(byName.get('User')?.doc).toContain('A user in the system');
    expect(byName.get('useAuth')?.doc).toContain('Custom hook for authentication');
    expect(byName.get('create')?.doc).toContain('Creates a new service instance');
    expect(byName.get('findUser')?.doc).toContain('Find a user by ID');
  });

  it('extracts function signatures', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const byName = new Map(result.symbols.map(s => [s.name, s]));

    expect(byName.get('greet')?.signature).toBe('(name: string): string');
    expect(byName.get('fetchData')?.signature).toContain('(url: string)');
    expect(byName.get('create')?.signature).toContain('(): UserService');
    expect(byName.get('findUser')?.signature).toContain('(id: string)');
  });

  it('sets line and col correctly (1-based lines, 0-based cols)', () => {
    const result = extractSource(
      'const x = 1;\nfunction foo() {}',
      'test.ts',
      'typescript',
    );
    if (!result.parsed) return;

    const x = result.symbols.find(s => s.name === 'x')!;
    expect(x.line).toBe(1);
    expect(x.col).toBe(0);

    const foo = result.symbols.find(s => s.name === 'foo')!;
    expect(foo.line).toBe(2);
    expect(foo.col).toBe(0);
  });

  it('detects React components (PascalCase + JSX)', () => {
    const componentFile = path.resolve(__dirname, 'fixtures/component.tsx');
    const result = extractFile(componentFile, 'fixtures/component.tsx', 'typescript');
    if (!result.parsed) return;

    const greeting = result.symbols.find(s => s.name === 'Greeting');
    expect(greeting).toBeDefined();
    expect(greeting!.kind).toBe('component');
  });

  it('extracts symbols nested inside variable-assigned component bodies', () => {
    const componentFile = path.resolve(__dirname, 'fixtures/component-local.tsx');
    const result = extractFile(componentFile, 'fixtures/component-local.tsx', 'typescript');
    if (!result.parsed) return;

    const byName = new Map(result.symbols.map(s => [s.name, s]));

    expect(byName.get('KanbanBoard')?.kind).toBe('component');
    expect(byName.get('activeTask')?.kind).toBe('variable');
    expect(byName.get('activeTask')?.scope).toBe('KanbanBoard');
    expect(byName.get('handleDragStart')?.kind).toBe('function');
    expect(byName.get('handleDragStart')?.scope).toBe('KanbanBoard');
    expect(byName.get('handleDragEnd')?.kind).toBe('function');
    expect(byName.get('handleDragEnd')?.scope).toBe('KanbanBoard');
  });

  it('extracts inner symbols from realistic component patterns (useCallback, useMemo, nested functions)', () => {
    const componentFile = path.resolve(__dirname, 'fixtures/component-realistic.tsx');
    const result = extractFile(componentFile, 'fixtures/component-realistic.tsx', 'typescript');
    if (!result.parsed) return;

    const byName = new Map(result.symbols.map(s => [s.name, s]));
    const allNames = result.symbols.map(s => s.name);

    // Component itself
    expect(byName.get('KanbanBoard')?.kind).toBe('function');

    // Plain arrow function inside function body
    expect(allNames).toContain('getTasksByStatus');
    expect(byName.get('getTasksByStatus')?.scope).toBe('KanbanBoard');

    // useCallback-wrapped handlers — the const is the symbol, not the callback
    expect(allNames).toContain('handleDragStart');
    expect(byName.get('handleDragStart')?.scope).toBe('KanbanBoard');

    expect(allNames).toContain('handleDragEnd');
    expect(byName.get('handleDragEnd')?.scope).toBe('KanbanBoard');

    expect(allNames).toContain('handleDragOver');
    expect(byName.get('handleDragOver')?.scope).toBe('KanbanBoard');

    // useMemo-wrapped derived value
    expect(allNames).toContain('taskCounts');
    expect(byName.get('taskCounts')?.scope).toBe('KanbanBoard');

    // Nested function declaration inside component body
    expect(allNames).toContain('renderColumn');
    expect(byName.get('renderColumn')?.scope).toBe('KanbanBoard');

    // useState destructured — activeTask, isDragging
    // These are array destructured, not simple identifiers
    expect(allNames).toContain('activeTask');
    expect(allNames).toContain('setActiveTask');
    expect(allNames).toContain('isDragging');
    expect(allNames).toContain('setIsDragging');
  });

  it('extracts class field definitions (arrow functions, state, etc.)', () => {
    const componentFile = path.resolve(__dirname, 'fixtures/component-class.tsx');
    const result = extractFile(componentFile, 'fixtures/component-class.tsx', 'typescript');
    if (!result.parsed) return;

    const byName = new Map(result.symbols.map(s => [s.name, s]));

    expect(byName.get('Counter')?.kind).toBe('class');

    // Class field arrow functions
    expect(byName.get('handleIncrement')?.kind).toBe('function');
    expect(byName.get('handleIncrement')?.scope).toBe('Counter');
    expect(byName.get('handleIncrement')?.doc).toContain('Increment');

    expect(byName.get('handleDecrement')?.kind).toBe('function');
    expect(byName.get('handleDecrement')?.scope).toBe('Counter');

    expect(byName.get('validate')?.kind).toBe('function');
    expect(byName.get('validate')?.scope).toBe('Counter');

    // Plain class field (state = {...})
    expect(byName.get('state')?.kind).toBe('variable');
    expect(byName.get('state')?.scope).toBe('Counter');

    // Regular method still works
    expect(byName.get('render')?.kind).toBe('method');
    expect(byName.get('render')?.scope).toBe('Counter');
  });

  it('extracts enum members as scoped constants', () => {
    const result = extractSource(
      `enum Status {\n  Pending = 'pending',\n  Active = 'active',\n  Inactive = 'inactive',\n}`,
      'test.ts',
      'typescript',
    );
    if (!result.parsed) return;

    const byName = new Map(result.symbols.map(s => [s.name, s]));

    expect(byName.get('Status')?.kind).toBe('enum');
    expect(byName.get('Pending')?.kind).toBe('constant');
    expect(byName.get('Pending')?.scope).toBe('Status');
    expect(byName.get('Active')?.kind).toBe('constant');
    expect(byName.get('Active')?.scope).toBe('Status');
    expect(byName.get('Inactive')?.kind).toBe('constant');
    expect(byName.get('Inactive')?.scope).toBe('Status');
  });

  it('extracts object literal methods and function-valued properties', () => {
    const result = extractSource(
      `const handlers = {\n  onClick() {},\n  onSubmit() {},\n  validate: (x) => x > 0,\n  name: 'foo',\n};`,
      'test.ts',
      'typescript',
    );
    if (!result.parsed) return;

    const byName = new Map(result.symbols.map(s => [s.name, s]));

    expect(byName.get('handlers')?.kind).toBe('variable');
    expect(byName.get('onClick')?.kind).toBe('method');
    expect(byName.get('onClick')?.scope).toBe('handlers');
    expect(byName.get('onSubmit')?.kind).toBe('method');
    expect(byName.get('onSubmit')?.scope).toBe('handlers');
    expect(byName.get('validate')?.kind).toBe('function');
    expect(byName.get('validate')?.scope).toBe('handlers');
    // Plain string property should NOT be extracted as a symbol
    expect(byName.has('name')).toBe(false);
  });
});

// ── Module Edge (Import) Tests ──────────────────────────────────────────

describe('import extraction', () => {
  const fixtureFile = path.resolve(__dirname, 'fixtures/sample.ts');

  it('extracts named imports', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const readFileImport = result.edges.find(e => e.kind === 'import' && e.name === 'readFile');
    expect(readFileImport).toBeDefined();
    expect(readFileImport!.source).toBe('node:fs/promises');
    expect(readFileImport!.is_default).toBe(false);
    expect(readFileImport!.is_star).toBe(false);
    expect(readFileImport!.is_type).toBe(false);
  });

  it('extracts type-only imports', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const configImport = result.edges.find(e => e.kind === 'import' && e.name === 'Config');
    expect(configImport).toBeDefined();
    expect(configImport!.source).toBe('./config');
    expect(configImport!.is_type).toBe(true);
  });

  it('extracts star imports', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const starImport = result.edges.find(e => e.kind === 'import' && e.is_star);
    expect(starImport).toBeDefined();
    expect(starImport!.alias).toBe('path');
    expect(starImport!.source).toBe('node:path');
  });

  it('extracts default imports', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const defaultImport = result.edges.find(e => e.kind === 'import' && e.name === 'defaultExport');
    expect(defaultImport).toBeDefined();
    expect(defaultImport!.is_default).toBe(true);
    expect(defaultImport!.source).toBe('./default-mod');
  });

  it('extracts mixed default + named imports', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    // Default part
    const defImport = result.edges.find(e => e.kind === 'import' && e.name === 'def');
    expect(defImport).toBeDefined();
    expect(defImport!.is_default).toBe(true);
    expect(defImport!.source).toBe('./mixed');

    // Named + aliased part
    const aliasedImport = result.edges.find(e => e.kind === 'import' && e.name === 'named');
    expect(aliasedImport).toBeDefined();
    expect(aliasedImport!.alias).toBe('aliased');

    // Inline type import
    const typeImport = result.edges.find(e => e.kind === 'import' && e.name === 'TypeImport');
    expect(typeImport).toBeDefined();
    expect(typeImport!.is_type).toBe(true);
  });
});

// ── Module Edge (Export) Tests ──────────────────────────────────────────

describe('export extraction', () => {
  const fixtureFile = path.resolve(__dirname, 'fixtures/sample.ts');

  it('extracts declaration exports', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const exports = result.edges.filter(e => e.kind === 'export');
    const exportNames = exports.map(e => e.name);

    expect(exportNames).toContain('MAX_RETRIES');
    expect(exportNames).toContain('greet');
    expect(exportNames).toContain('User');
    expect(exportNames).toContain('Result');
    expect(exportNames).toContain('Status');
    expect(exportNames).toContain('useAuth');
    expect(exportNames).toContain('fetchData');
  });

  it('extracts default export', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const defaultExport = result.edges.find(e => e.kind === 'export' && e.is_default);
    expect(defaultExport).toBeDefined();
    expect(defaultExport!.name).toBe('UserService');
  });

  it('extracts re-exports with alias', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const reExport = result.edges.find(e => e.kind === 're-export' && e.name === 'greet');
    expect(reExport).toBeDefined();
    expect(reExport!.alias).toBe('hello');
    expect(reExport!.source).toBe('./re-export');
  });

  it('extracts star re-exports', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const starExport = result.edges.find(e => e.kind === 're-export' && e.is_star);
    expect(starExport).toBeDefined();
    expect(starExport!.source).toBe('./star-export');
  });

  it('extracts type re-exports', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const typeExport = result.edges.find(e => e.kind === 're-export' && e.name === 'Config');
    expect(typeExport).toBeDefined();
    expect(typeExport!.alias).toBe('AppConfig');
    expect(typeExport!.is_type).toBe(true);
    expect(typeExport!.source).toBe('./types');
  });

  it('marks interface and type exports as is_type', () => {
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    if (!result.parsed) return;

    const userExport = result.edges.find(e => e.kind === 'export' && e.name === 'User');
    expect(userExport!.is_type).toBe(true);

    const resultExport = result.edges.find(e => e.kind === 'export' && e.name === 'Result');
    expect(resultExport!.is_type).toBe(true);

    // Non-type exports should not be is_type
    const greetExport = result.edges.find(e => e.kind === 'export' && e.name === 'greet');
    expect(greetExport!.is_type).toBe(false);
  });
});

// ── Dynamic Import Tests ───────────────────────────────────────────────

describe('dynamic import extraction', () => {
  it('extracts standard dynamic import()', () => {
    const result = extractSource(
      `const mod = await import('./module');`,
      'test.ts',
      'typescript',
    );
    if (!result.parsed) return;

    const dynImport = result.edges.find(e => e.kind === 'dynamic-import');
    expect(dynImport).toBeDefined();
    expect(dynImport!.source).toBe('./module');
    expect(dynImport!.is_default).toBe(false);
    expect(dynImport!.is_type).toBe(false);
  });

  it('extracts Next.js dynamic(() => import(...))', () => {
    const result = extractSource(
      `const Foo = dynamic(() => import("@/components/Foo").then(m => ({ default: m.Foo })), { ssr: false });`,
      'test.ts',
      'typescript',
    );
    if (!result.parsed) return;

    const dynImport = result.edges.find(e => e.kind === 'dynamic-import');
    expect(dynImport).toBeDefined();
    expect(dynImport!.source).toBe('@/components/Foo');
  });

  it('extracts bare import() for side effects', () => {
    const result = extractSource(
      `import('./side-effect');`,
      'test.ts',
      'typescript',
    );
    if (!result.parsed) return;

    const dynImport = result.edges.find(e => e.kind === 'dynamic-import');
    expect(dynImport).toBeDefined();
    expect(dynImport!.source).toBe('./side-effect');
  });

  it('extracts conditional dynamic imports', () => {
    const result = extractSource(
      `if (condition) { const m = await import('./lazy'); }`,
      'test.ts',
      'typescript',
    );
    if (!result.parsed) return;

    const dynImport = result.edges.find(e => e.kind === 'dynamic-import');
    expect(dynImport).toBeDefined();
    expect(dynImport!.source).toBe('./lazy');
  });

  it('does not duplicate static imports as dynamic', () => {
    const result = extractSource(
      `import { foo } from './bar';\nconst x = await import('./baz');`,
      'test.ts',
      'typescript',
    );
    if (!result.parsed) return;

    const staticImports = result.edges.filter(e => e.kind === 'import');
    const dynamicImports = result.edges.filter(e => e.kind === 'dynamic-import');
    expect(staticImports).toHaveLength(1);
    expect(staticImports[0].source).toBe('./bar');
    expect(dynamicImports).toHaveLength(1);
    expect(dynamicImports[0].source).toBe('./baz');
  });
});

// ── Require Tests ──────────────────────────────────────────────────────

describe('require() extraction', () => {
  it('extracts basic require()', () => {
    const result = extractSource(
      `const path = require('path');`,
      'test.js',
      'javascript',
    );
    if (!result.parsed) return;

    const req = result.edges.find(e => e.kind === 'require');
    expect(req).toBeDefined();
    expect(req!.source).toBe('path');
  });

  it('extracts destructured require()', () => {
    const result = extractSource(
      `const { app, BrowserWindow } = require('electron');`,
      'test.js',
      'javascript',
    );
    if (!result.parsed) return;

    const req = result.edges.find(e => e.kind === 'require');
    expect(req).toBeDefined();
    expect(req!.source).toBe('electron');
  });

  it('extracts relative require()', () => {
    const result = extractSource(
      `const utils = require('./utils');`,
      'test.js',
      'javascript',
    );
    if (!result.parsed) return;

    const req = result.edges.find(e => e.kind === 'require');
    expect(req).toBeDefined();
    expect(req!.source).toBe('./utils');
  });

  it('does not confuse require with other function calls', () => {
    const result = extractSource(
      `const x = someFunc('path');\nconst y = require('fs');`,
      'test.js',
      'javascript',
    );
    if (!result.parsed) return;

    const reqs = result.edges.filter(e => e.kind === 'require');
    expect(reqs).toHaveLength(1);
    expect(reqs[0].source).toBe('fs');
  });

  it('extracts require.resolve()', () => {
    const result = extractSource(
      `const p = require.resolve('./plugin');\nconst q = require.resolve('eslint');`,
      'test.js',
      'javascript',
    );
    if (!result.parsed) return;

    const reqs = result.edges.filter(e => e.kind === 'require');
    expect(reqs).toHaveLength(2);
    expect(reqs[0].source).toBe('./plugin');
    expect(reqs[1].source).toBe('eslint');
  });
});

// ── Occurrence Tests ────────────────────────────────────────────────────

describe('occurrence extraction', () => {
  it('extracts identifier occurrences', () => {
    const result = extractSource(
      'const greeting = greet(userName);\nconsole.log(greeting);',
      'test.ts',
      'typescript',
    );
    if (!result.parsed) return;

    const names = result.occurrences.map(o => o.name);
    expect(names).toContain('greeting');
    expect(names).toContain('greet');
    expect(names).toContain('userName');
  });

  it('skips keywords and short identifiers', () => {
    const result = extractSource(
      'const x = true;\nif (x) { return null; }',
      'test.ts',
      'typescript',
    );
    if (!result.parsed) return;

    const names = result.occurrences.map(o => o.name);
    // 'x' is 1 char — should be skipped
    expect(names).not.toContain('x');
    // 'true', 'null' are keywords — should be skipped
    expect(names).not.toContain('true');
    expect(names).not.toContain('null');
  });

  it('includes context for each occurrence', () => {
    const result = extractSource(
      'function process(data: string) {\n  return data.trim();\n}',
      'test.ts',
      'typescript',
    );
    if (!result.parsed) return;

    const dataOccs = result.occurrences.filter(o => o.name === 'data');
    expect(dataOccs.length).toBeGreaterThan(0);
    // Each occurrence should have context
    for (const occ of dataOccs) {
      expect(occ.context).toBeTruthy();
      expect(occ.context!.length).toBeLessThanOrEqual(200);
    }
  });

  it('uses heuristic confidence', () => {
    const result = extractSource('const foo = bar;', 'test.ts', 'typescript');
    if (!result.parsed) return;

    for (const occ of result.occurrences) {
      expect(occ.confidence).toBe('heuristic');
    }
  });

  it('deduplicates same name at same position', () => {
    const result = extractSource('const abc = abc;', 'test.ts', 'typescript');
    if (!result.parsed) return;

    const abcOccs = result.occurrences.filter(o => o.name === 'abc');
    // Two occurrences at different columns
    const positions = abcOccs.map(o => `${o.line}:${o.col}`);
    const unique = new Set(positions);
    expect(unique.size).toBe(positions.length);
  });
});

// ── Extractor Integration Tests ─────────────────────────────────────────

describe('extractor', () => {
  it('extracts from source string', () => {
    const result = extractSource(
      'export function hello() { return "world"; }',
      'test.ts',
      'typescript',
    );
    expect(result.parsed).toBe(true);
    if (!result.parsed) return;

    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].name).toBe('hello');
    expect(result.symbols[0].kind).toBe('function');

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].kind).toBe('export');
    expect(result.edges[0].name).toBe('hello');
  });

  it('returns error for unsupported language', () => {
    const result = extractSource('main', 'test.cob', 'cobol');
    expect(result.parsed).toBe(false);
    if (result.parsed) return;
    expect(result.error).toContain('No grammar');
  });

  it('successfully parses Python', () => {
    const result = extractSource('def greet(name): pass', 'test.py', 'python');
    expect(result.parsed).toBe(true);
  });

  it('handles empty files', () => {
    const result = extractSource('', 'empty.ts', 'typescript');
    expect(result.parsed).toBe(true);
    if (!result.parsed) return;
    expect(result.symbols).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.occurrences).toHaveLength(0);
  });

  it('handles files with only comments', () => {
    const result = extractSource('// just a comment\n/* block comment */', 'comment.ts', 'typescript');
    expect(result.parsed).toBe(true);
    if (!result.parsed) return;
    expect(result.symbols).toHaveLength(0);
  });

  it('extracts from real file on disk', () => {
    const fixtureFile = path.resolve(__dirname, 'fixtures/sample.ts');
    const result = extractFile(fixtureFile, 'fixtures/sample.ts', 'typescript');
    expect(result.parsed).toBe(true);
    if (!result.parsed) return;

    // Should have symbols, edges, and occurrences
    expect(result.symbols.length).toBeGreaterThan(5);
    expect(result.edges.length).toBeGreaterThan(5);
    expect(result.occurrences.length).toBeGreaterThan(5);
  });

  it('returns error for non-existent file', () => {
    const result = extractFile('/nonexistent/file.ts', 'file.ts', 'typescript');
    expect(result.parsed).toBe(false);
    if (result.parsed) return;
    expect(result.error).toContain('Failed to read');
  });

  it('handles JavaScript files the same as TypeScript', () => {
    const result = extractSource(
      'export function add(a, b) { return a + b; }',
      'math.js',
      'javascript',
    );
    expect(result.parsed).toBe(true);
    if (!result.parsed) return;
    expect(result.symbols[0].name).toBe('add');
    expect(result.symbols[0].kind).toBe('function');
  });

  it('handles TSX files with JSX', () => {
    const componentFile = path.resolve(__dirname, 'fixtures/component.tsx');
    const result = extractFile(componentFile, 'fixtures/component.tsx', 'typescript');
    expect(result.parsed).toBe(true);
    if (!result.parsed) return;

    const symbolNames = result.symbols.map(s => s.name);
    expect(symbolNames).toContain('Greeting');
    expect(symbolNames).toContain('GreetingProps');
  });
});
