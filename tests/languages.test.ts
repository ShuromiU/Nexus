import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { extractFile, extractSource } from '../src/analysis/extractor.js';

const FIXTURES = path.resolve(__dirname, 'fixtures');

// ── Python ────────────────────────────────────────────────────────────

describe('Python adapter', () => {
  const result = extractFile(
    path.join(FIXTURES, 'sample.py'),
    'tests/fixtures/sample.py',
    'python',
  );

  it('parses successfully', () => {
    expect(result.parsed).toBe(true);
  });

  if (!result.parsed) return;

  describe('symbols', () => {
    it('extracts classes', () => {
      const classes = result.symbols.filter(s => s.kind === 'class');
      const names = classes.map(s => s.name);
      expect(names).toContain('User');
      expect(names).toContain('UserService');
      expect(names).toContain('Status');
    });

    it('extracts functions', () => {
      const fns = result.symbols.filter(s => s.kind === 'function');
      const names = fns.map(s => s.name);
      expect(names).toContain('greet');
      expect(names).toContain('fetch_data');
    });

    it('extracts methods with class scope', () => {
      const methods = result.symbols.filter(s => s.scope === 'UserService');
      const names = methods.map(s => s.name);
      expect(names).toContain('__init__');
      expect(names).toContain('find_user');
      expect(names).toContain('create');
    });

    it('extracts constants', () => {
      const consts = result.symbols.filter(s => s.kind === 'constant');
      expect(consts.map(s => s.name)).toContain('MAX_RETRIES');
      expect(consts.map(s => s.name)).toContain('CONSTANT_VALUE');
    });

    it('extracts docstrings', () => {
      const userClass = result.symbols.find(s => s.name === 'User' && s.kind === 'class');
      expect(userClass?.doc).toContain('user in the system');
    });

    it('extracts signatures', () => {
      const greet = result.symbols.find(s => s.name === 'greet');
      expect(greet?.signature).toContain('name: str');
      expect(greet?.signature).toContain('str');
    });
  });

  describe('edges', () => {
    it('extracts imports', () => {
      const imports = result.edges.filter(e => e.kind === 'import');
      const sources = imports.map(e => e.source);
      expect(sources).toContain('os');
      expect(sources).toContain('pathlib');
      expect(sources).toContain('typing');
    });

    it('extracts aliased imports', () => {
      const aliased = result.edges.find(e => e.alias === 'j');
      expect(aliased).toBeDefined();
      expect(aliased!.name).toBe('json');
    });

    it('exports public names', () => {
      const exports = result.edges.filter(e => e.kind === 'export');
      const names = exports.map(e => e.name);
      expect(names).toContain('User');
      expect(names).toContain('greet');
      expect(names).toContain('MAX_RETRIES');
      // Private names should NOT be exported
      expect(names).not.toContain('_internal_var');
      expect(names).not.toContain('_private_helper');
    });
  });

  describe('occurrences', () => {
    it('finds identifier occurrences', () => {
      const nameOccs = result.occurrences.filter(o => o.name === 'greet');
      expect(nameOccs.length).toBeGreaterThanOrEqual(1);
    });

    it('includes context', () => {
      const occ = result.occurrences.find(o => o.name === 'greet');
      expect(occ?.context).toBeTruthy();
    });
  });
});

// ── Go ────────────────────────────────────────────────────────────────

describe('Go adapter', () => {
  const result = extractFile(
    path.join(FIXTURES, 'sample.go'),
    'tests/fixtures/sample.go',
    'go',
  );

  it('parses successfully', () => {
    expect(result.parsed).toBe(true);
  });

  if (!result.parsed) return;

  describe('symbols', () => {
    it('extracts structs as classes', () => {
      const structs = result.symbols.filter(s => s.kind === 'class');
      const names = structs.map(s => s.name);
      expect(names).toContain('User');
      expect(names).toContain('UserService');
    });

    it('extracts interfaces', () => {
      const ifaces = result.symbols.filter(s => s.kind === 'interface');
      expect(ifaces.map(s => s.name)).toContain('Result');
    });

    it('extracts functions', () => {
      const fns = result.symbols.filter(s => s.kind === 'function');
      const names = fns.map(s => s.name);
      expect(names).toContain('NewUserService');
      expect(names).toContain('Greet');
      expect(names).toContain('FetchData');
    });

    it('extracts methods with receiver scope', () => {
      const methods = result.symbols.filter(s => s.kind === 'method');
      const findUser = methods.find(s => s.name === 'FindUser');
      expect(findUser).toBeDefined();
      expect(findUser!.scope).toBe('UserService');
    });

    it('extracts constants', () => {
      const consts = result.symbols.filter(s => s.kind === 'constant');
      const names = consts.map(s => s.name);
      expect(names).toContain('MaxRetries');
      expect(names).toContain('StatusActive');
    });

    it('extracts doc comments', () => {
      const user = result.symbols.find(s => s.name === 'User' && s.kind === 'class');
      expect(user?.doc).toContain('user in the system');
    });

    it('extracts function signatures', () => {
      const greet = result.symbols.find(s => s.name === 'Greet');
      expect(greet?.signature).toContain('name string');
    });
  });

  describe('edges', () => {
    it('extracts imports', () => {
      const imports = result.edges.filter(e => e.kind === 'import');
      const sources = imports.map(e => e.source);
      expect(sources).toContain('context');
      expect(sources).toContain('fmt');
      expect(sources).toContain('encoding/json');
    });

    it('exports capitalized names', () => {
      const exports = result.edges.filter(e => e.kind === 'export');
      const names = exports.map(e => e.name);
      expect(names).toContain('User');
      expect(names).toContain('Greet');
      expect(names).toContain('MaxRetries');
      // Unexported names should not appear
      expect(names).not.toContain('counter');
    });
  });
});

// ── Rust ──────────────────────────────────────────────────────────────

describe('Rust adapter', () => {
  const result = extractFile(
    path.join(FIXTURES, 'sample.rs'),
    'tests/fixtures/sample.rs',
    'rust',
  );

  it('parses successfully', () => {
    expect(result.parsed).toBe(true);
  });

  if (!result.parsed) return;

  describe('symbols', () => {
    it('extracts structs as classes', () => {
      const structs = result.symbols.filter(s => s.kind === 'class');
      expect(structs.map(s => s.name)).toContain('User');
    });

    it('extracts enums', () => {
      const enums = result.symbols.filter(s => s.kind === 'enum');
      expect(enums.map(s => s.name)).toContain('Status');
    });

    it('extracts traits as interfaces', () => {
      const traits = result.symbols.filter(s => s.kind === 'interface');
      expect(traits.map(s => s.name)).toContain('Service');
    });

    it('extracts functions', () => {
      const fns = result.symbols.filter(s => s.kind === 'function' && s.scope === null);
      const names = fns.map(s => s.name);
      expect(names).toContain('greet');
      expect(names).toContain('fetch_data');
      expect(names).toContain('private_helper');
    });

    it('extracts impl methods with scope', () => {
      const methods = result.symbols.filter(s => s.kind === 'method' && s.scope === 'User');
      expect(methods.map(s => s.name)).toContain('new');
    });

    it('extracts constants', () => {
      const consts = result.symbols.filter(s => s.kind === 'constant');
      expect(consts.map(s => s.name)).toContain('MAX_RETRIES');
    });

    it('extracts type aliases', () => {
      const types = result.symbols.filter(s => s.kind === 'type');
      expect(types.map(s => s.name)).toContain('Result');
    });

    it('extracts doc comments', () => {
      const user = result.symbols.find(s => s.name === 'User' && s.kind === 'class');
      expect(user?.doc).toContain('user in the system');
    });
  });

  describe('edges', () => {
    it('extracts use declarations as imports', () => {
      const imports = result.edges.filter(e => e.kind === 'import');
      const names = imports.map(e => e.name);
      expect(names).toContain('fmt');
      expect(names).toContain('HashMap');
    });

    it('exports pub items', () => {
      const exports = result.edges.filter(e => e.kind === 'export');
      const names = exports.map(e => e.name);
      expect(names).toContain('User');
      expect(names).toContain('greet');
      expect(names).toContain('MAX_RETRIES');
    });
  });
});

// ── Java ──────────────────────────────────────────────────────────────

describe('Java adapter', () => {
  const result = extractFile(
    path.join(FIXTURES, 'Sample.java'),
    'tests/fixtures/Sample.java',
    'java',
  );

  it('parses successfully', () => {
    expect(result.parsed).toBe(true);
  });

  if (!result.parsed) return;

  describe('symbols', () => {
    it('extracts classes', () => {
      const classes = result.symbols.filter(s => s.kind === 'class');
      const names = classes.map(s => s.name);
      expect(names).toContain('Sample');
      expect(names).toContain('User');
    });

    it('extracts nested classes with scope', () => {
      const user = result.symbols.find(s => s.name === 'User' && s.kind === 'class');
      expect(user?.scope).toBe('Sample');
    });

    it('extracts enums', () => {
      const enums = result.symbols.filter(s => s.kind === 'enum');
      expect(enums.map(s => s.name)).toContain('Status');
    });

    it('extracts interfaces', () => {
      const ifaces = result.symbols.filter(s => s.kind === 'interface');
      expect(ifaces.map(s => s.name)).toContain('Service');
    });

    it('extracts methods', () => {
      const methods = result.symbols.filter(s => s.kind === 'method');
      const names = methods.map(s => s.name);
      expect(names).toContain('greet');
      expect(names).toContain('fetchData');
    });

    it('extracts constants (static final)', () => {
      const consts = result.symbols.filter(s => s.kind === 'constant');
      expect(consts.map(s => s.name)).toContain('MAX_RETRIES');
    });

    it('extracts doc comments', () => {
      const greet = result.symbols.find(s => s.name === 'greet');
      expect(greet?.doc).toContain('Greet a person');
    });

    it('extracts method signatures', () => {
      const greet = result.symbols.find(s => s.name === 'greet');
      expect(greet?.signature).toContain('String name');
    });
  });

  describe('edges', () => {
    it('extracts imports', () => {
      const imports = result.edges.filter(e => e.kind === 'import');
      const names = imports.map(e => e.name);
      expect(names).toContain('List');
      expect(names).toContain('Optional');
      expect(names).toContain('Map');
    });

    it('exports top-level class', () => {
      const exports = result.edges.filter(e => e.kind === 'export');
      const names = exports.map(e => e.name);
      expect(names).toContain('Sample');
    });
  });
});

// ── LanguageCapabilities.refKinds ─────────────────────────────────────

describe('LanguageCapabilities.refKinds', () => {
  it('typescript and javascript declare refKinds', async () => {
    await import('../src/analysis/languages/typescript.js');
    const { getAdapter } = await import('../src/analysis/languages/registry.js');
    const ts = getAdapter('typescript');
    const js = getAdapter('javascript');
    expect(ts?.capabilities.refKinds).toEqual(
      expect.arrayContaining(['call', 'read', 'write', 'type-ref', 'declaration']),
    );
    expect(js?.capabilities.refKinds).toEqual(ts?.capabilities.refKinds);
  });

  it('python declares empty refKinds', async () => {
    await import('../src/analysis/languages/python.js');
    const { getAdapter } = await import('../src/analysis/languages/registry.js');
    const py = getAdapter('python');
    expect(py?.capabilities.refKinds).toEqual([]);
  });
});

// ── C# ───────────────────────────────────────────────────────────────

describe('C# adapter', () => {
  const result = extractFile(
    path.join(FIXTURES, 'Sample.cs'),
    'tests/fixtures/Sample.cs',
    'csharp',
  );

  it('parses successfully', () => {
    expect(result.parsed).toBe(true);
  });

  if (!result.parsed) return;

  describe('symbols', () => {
    it('extracts classes', () => {
      const classes = result.symbols.filter(s => s.kind === 'class');
      const names = classes.map(s => s.name);
      expect(names).toContain('Constants');
      expect(names).toContain('User');
      expect(names).toContain('UserService');
    });

    it('extracts enums', () => {
      const enums = result.symbols.filter(s => s.kind === 'enum');
      expect(enums.map(s => s.name)).toContain('Status');
    });

    it('extracts interfaces', () => {
      const ifaces = result.symbols.filter(s => s.kind === 'interface');
      expect(ifaces.map(s => s.name)).toContain('IService');
    });

    it('extracts methods', () => {
      const methods = result.symbols.filter(s => s.kind === 'method');
      const names = methods.map(s => s.name);
      expect(names).toContain('Init');
      expect(names).toContain('FindUser');
      expect(names).toContain('Greet');
      expect(names).toContain('FetchData');
    });

    it('extracts methods with class scope', () => {
      const greet = result.symbols.find(s => s.name === 'Greet' && s.kind === 'method');
      expect(greet?.scope).toBe('UserService');
    });

    it('extracts method signatures', () => {
      const greet = result.symbols.find(s => s.name === 'Greet');
      expect(greet?.signature).toContain('string name');
    });
  });

  describe('edges', () => {
    it('extracts using directives as imports', () => {
      const imports = result.edges.filter(e => e.kind === 'import');
      const names = imports.map(e => e.name);
      expect(names).toContain('System');
      expect(names).toContain('Generic');
      expect(names).toContain('Tasks');
    });

    it('exports top-level types', () => {
      const exports = result.edges.filter(e => e.kind === 'export');
      const names = exports.map(e => e.name);
      expect(names).toContain('Constants');
      expect(names).toContain('User');
      expect(names).toContain('UserService');
      expect(names).toContain('IService');
      expect(names).toContain('Status');
    });
  });
});

// ── TypeScript ref_kind classification ────────────────────────────────

describe('typescript adapter — ref_kind classification', () => {
  it('emits declaration for top-level function name', async () => {
    const { extractOccurrencesForTest } = await import('../src/analysis/languages/typescript.js');
    const src = 'export function greet(name: string): string { return name; }';
    const occs = extractOccurrencesForTest(src);
    const greet = occs.find(o => o.name === 'greet');
    expect(greet?.ref_kind).toBe('declaration');
  });

  it('emits call for function invocation', async () => {
    const { extractOccurrencesForTest } = await import('../src/analysis/languages/typescript.js');
    // Use a multi-char name — single-char identifiers are filtered by the
    // occurrence walker's `name.length > 1` guard.
    const src = 'function fn() {} fn();';
    const occs = extractOccurrencesForTest(src);
    const calls = occs.filter(o => o.name === 'fn' && o.ref_kind === 'call');
    expect(calls.length).toBe(1);
  });

  it('emits type-ref for type position', async () => {
    const { extractOccurrencesForTest } = await import('../src/analysis/languages/typescript.js');
    const src = 'type Foo = number; const x: Foo = 1 as Foo;';
    const occs = extractOccurrencesForTest(src);
    const typeRefs = occs.filter(o => o.name === 'Foo' && o.ref_kind === 'type-ref');
    expect(typeRefs.length).toBe(2);
  });

  it('emits write for LHS of assignment', async () => {
    const { extractOccurrencesForTest } = await import('../src/analysis/languages/typescript.js');
    const src = 'let xs = 0; xs = 1;';
    const occs = extractOccurrencesForTest(src);
    const writes = occs.filter(o => o.name === 'xs' && o.ref_kind === 'write');
    expect(writes.length).toBeGreaterThanOrEqual(1);
  });

  it('emits read by default', async () => {
    const { extractOccurrencesForTest } = await import('../src/analysis/languages/typescript.js');
    const src = 'let xs = 0; const ys = xs + 1;';
    const occs = extractOccurrencesForTest(src);
    const reads = occs.filter(o => o.name === 'xs' && o.ref_kind === 'read');
    expect(reads.length).toBeGreaterThanOrEqual(1);
  });
});
