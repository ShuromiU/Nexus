import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  createProgram,
  formatSymbols,
  formatOccurrences,
  formatEdges,
  formatTree,
  formatStats,
  formatBatchOutline,
  formatSlice,
} from '../src/transports/cli.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
import type {
  SymbolResult,
  OccurrenceResult,
  ModuleEdgeResult,
  TreeEntry,
  IndexStats,
  BatchOutlineResult,
  SliceResult,
} from '../src/query/engine.js';

// ── CLI Argument Parsing ──────────────────────────────────────────────

describe('CLI argument parsing', () => {
  it('registers all expected commands', () => {
    const program = createProgram();
    const commandNames = program.commands.map(c => c.name());
    expect(commandNames).toContain('build');
    expect(commandNames).toContain('rebuild');
    expect(commandNames).toContain('find');
    expect(commandNames).toContain('refs');
    expect(commandNames).toContain('exports');
    expect(commandNames).toContain('imports');
    expect(commandNames).toContain('tree');
    expect(commandNames).toContain('search');
    expect(commandNames).toContain('outline');
    expect(commandNames).toContain('source');
    expect(commandNames).toContain('slice');
    expect(commandNames).toContain('deps');
    expect(commandNames).toContain('stats');
    expect(commandNames).toContain('repair');
    expect(commandNames).toContain('serve');
  });

  it('find command accepts --kind option', () => {
    const program = createProgram();
    const findCmd = program.commands.find(c => c.name() === 'find')!;
    const kindOpt = findCmd.options.find(o => o.long === '--kind');
    expect(kindOpt).toBeDefined();
  });

  it('search command accepts --limit option', () => {
    const program = createProgram();
    const searchCmd = program.commands.find(c => c.name() === 'search')!;
    const limitOpt = searchCmd.options.find(o => o.long === '--limit');
    expect(limitOpt).toBeDefined();
  });

  it('search command accepts --path option', () => {
    const program = createProgram();
    const searchCmd = program.commands.find(c => c.name() === 'search')!;
    const pathOpt = searchCmd.options.find(o => o.long === '--path');
    expect(pathOpt).toBeDefined();
  });

  it('has correct name and version', () => {
    const program = createProgram();
    expect(program.name()).toBe('nexus');
    expect(program.version()).toBe(pkg.version);
  });
});

// ── Output Formatting ─────────────────────────────────────────────────

describe('formatSymbols', () => {
  it('returns empty message for no results', () => {
    expect(formatSymbols([])).toBe('No symbols found.');
  });

  it('formats a symbol with all fields', () => {
    const symbols: SymbolResult[] = [{
      name: 'greet',
      kind: 'function',
      file: 'src/utils.ts',
      line: 5,
      col: 0,
      signature: '(name: string) => string',
      doc: 'Greets a person',
      language: 'typescript',
    }];
    const output = formatSymbols(symbols);
    expect(output).toContain('function');
    expect(output).toContain('greet');
    expect(output).toContain('(name: string) => string');
    expect(output).toContain('src/utils.ts:5:0');
    expect(output).toContain('Greets a person');
  });

  it('formats a symbol without optional fields', () => {
    const symbols: SymbolResult[] = [{
      name: 'MAX',
      kind: 'constant',
      file: 'src/config.ts',
      line: 1,
      col: 0,
      language: 'typescript',
    }];
    const output = formatSymbols(symbols);
    expect(output).toContain('constant');
    expect(output).toContain('MAX');
    expect(output).toContain('src/config.ts:1:0');
  });

  it('shows scope when present', () => {
    const symbols: SymbolResult[] = [{
      name: 'useButtonState',
      kind: 'hook',
      file: 'src/Button.tsx',
      line: 35,
      col: 0,
      scope: 'Button',
      language: 'typescriptreact',
    }];
    const output = formatSymbols(symbols);
    expect(output).toContain('(in Button)');
  });

  it('formats multiple symbols', () => {
    const symbols: SymbolResult[] = [
      { name: 'foo', kind: 'function', file: 'a.ts', line: 1, col: 0, language: 'typescript' },
      { name: 'bar', kind: 'function', file: 'b.ts', line: 2, col: 0, language: 'typescript' },
    ];
    const output = formatSymbols(symbols);
    expect(output).toContain('foo');
    expect(output).toContain('bar');
  });
});

describe('formatOccurrences', () => {
  it('returns empty message for no results', () => {
    expect(formatOccurrences([])).toBe('No occurrences found.');
  });

  it('shows exact vs heuristic markers', () => {
    const occs: OccurrenceResult[] = [
      { name: 'x', file: 'a.ts', line: 1, col: 0, context: 'const x = 1', confidence: 'exact' },
      { name: 'x', file: 'b.ts', line: 5, col: 2, context: 'use(x)', confidence: 'heuristic' },
    ];
    const output = formatOccurrences(occs);
    expect(output).toContain('* a.ts:1:0');
    expect(output).toContain('~ b.ts:5:2');
    expect(output).toContain('const x = 1');
    expect(output).toContain('use(x)');
    expect(output).toContain('* = exact, ~ = heuristic');
  });
});

describe('formatEdges', () => {
  it('returns empty message for no exports', () => {
    expect(formatEdges([], 'exports')).toBe('No exports found.');
  });

  it('returns empty message for no imports', () => {
    expect(formatEdges([], 'imports')).toBe('No imports found.');
  });

  it('formats an import edge', () => {
    const edges: ModuleEdgeResult[] = [{
      kind: 'import',
      name: 'readFile',
      source: 'node:fs/promises',
      line: 1,
      is_default: false,
      is_star: false,
      is_type: false,
    }];
    const output = formatEdges(edges, 'imports');
    expect(output).toContain('import');
    expect(output).toContain('readFile');
    expect(output).toContain("from 'node:fs/promises'");
  });

  it('shows flags for default/star/type', () => {
    const edges: ModuleEdgeResult[] = [{
      kind: 'export',
      name: 'Config',
      line: 10,
      is_default: true,
      is_star: false,
      is_type: true,
    }];
    const output = formatEdges(edges, 'exports');
    expect(output).toContain('[default, type]');
  });

  it('shows alias', () => {
    const edges: ModuleEdgeResult[] = [{
      kind: 're-export',
      name: 'greet',
      alias: 'hello',
      source: './re-export',
      line: 59,
      is_default: false,
      is_star: false,
      is_type: false,
    }];
    const output = formatEdges(edges, 'exports');
    expect(output).toContain('as hello');
    expect(output).toContain("from './re-export'");
  });

  it('handles star export', () => {
    const edges: ModuleEdgeResult[] = [{
      kind: 're-export',
      name: null,
      source: './star-export',
      line: 60,
      is_default: false,
      is_star: true,
      is_type: false,
    }];
    const output = formatEdges(edges, 'exports');
    expect(output).toContain('*');
    expect(output).toContain('[*]');
  });
});

describe('formatTree', () => {
  it('returns empty message for no files', () => {
    expect(formatTree([])).toBe('No files found.');
  });

  it('formats file entries', () => {
    const entries: TreeEntry[] = [{
      path: 'src/utils.ts',
      language: 'typescript',
      symbol_count: 5,
      exports: ['formatDate', 'parseDate'],
      status: 'indexed',
    }];
    const output = formatTree(entries);
    expect(output).toContain('src/utils.ts');
    expect(output).toContain('typescript');
    expect(output).toContain('5 symbols');
    expect(output).toContain('formatDate, parseDate');
  });

  it('shows error status', () => {
    const entries: TreeEntry[] = [{
      path: 'src/broken.ts',
      language: 'typescript',
      symbol_count: 0,
      exports: [],
      status: 'error',
    }];
    const output = formatTree(entries);
    expect(output).toContain('[error]');
  });

  it('handles files with no exports', () => {
    const entries: TreeEntry[] = [{
      path: 'src/internal.ts',
      language: 'typescript',
      symbol_count: 2,
      exports: [],
      status: 'indexed',
    }];
    const output = formatTree(entries);
    expect(output).not.toContain('→');
  });
});

describe('formatStats', () => {
  it('formats full stats output', () => {
    const stats: IndexStats = {
      root: '/my/project',
      files: { total: 100, indexed: 95, skipped: 3, errored: 2 },
      symbols_total: 1500,
      languages: {
        typescript: {
          files: 80,
          symbols: 1200,
          capabilities: {
            definitions: true,
            imports: true,
            exports: true,
            occurrences: true,
            occurrenceQuality: 'heuristic',
            typeExports: true,
            docstrings: true,
            signatures: true,
          },
        },
      },
      index_status: 'current',
      index_health: 'partial',
      last_indexed_at: '2026-04-07T12:00:00Z',
      schema_version: 1,
      extractor_version: 1,
    };

    const output = formatStats(stats);
    expect(output).toContain('/my/project');
    expect(output).toContain('current');
    expect(output).toContain('partial');
    expect(output).toContain('100 total');
    expect(output).toContain('95 indexed');
    expect(output).toContain('1500');
    expect(output).toContain('typescript');
    expect(output).toContain('80 files');
    expect(output).toContain('1200 symbols');
    expect(output).toContain('refs(heuristic)');
    expect(output).toContain('type-exports');
  });

  it('shows never when not indexed', () => {
    const stats: IndexStats = {
      root: '/test',
      files: { total: 0, indexed: 0, skipped: 0, errored: 0 },
      symbols_total: 0,
      languages: {},
      index_status: 'stale',
      index_health: 'ok',
      last_indexed_at: '',
      schema_version: 1,
      extractor_version: 1,
    };

    const output = formatStats(stats);
    expect(output).toContain('never');
  });
});

describe('formatBatchOutline', () => {
  it('formats multiple outlines and missing files', () => {
    const batch: BatchOutlineResult = {
      outlines: {
        'src/a.ts': {
          file: 'src/a.ts',
          language: 'typescript',
          lines: 10,
          imports: [],
          exports: ['foo'],
          outline: [],
        },
        'src/b.ts': {
          file: 'src/b.ts',
          language: 'typescript',
          lines: 20,
          imports: [],
          exports: [],
          outline: [],
        },
      },
      missing: ['src/missing.ts'],
    };

    const output = formatBatchOutline(batch);
    expect(output).toContain('-- src/a.ts --');
    expect(output).toContain('-- src/b.ts --');
    expect(output).toContain('Missing:');
    expect(output).toContain('src/missing.ts');
  });
});

describe('formatSlice', () => {
  it('formats root, references, disambiguation, and truncation', () => {
    const slice: SliceResult = {
      root: {
        name: 'runIndex',
        kind: 'function',
        file: 'src/index/orchestrator.ts',
        line: 10,
        end_line: 20,
        language: 'typescript',
        source: 'function runIndex() {}',
      },
      references: [{
        name: 'extractAndBuffer',
        kind: 'function',
        file: 'src/index/orchestrator.ts',
        line: 30,
        end_line: 40,
        language: 'typescript',
        source: 'function extractAndBuffer() {}',
      }],
      disambiguation: [{
        name: 'runIndex',
        kind: 'function',
        file: 'src/other.ts',
        line: 5,
        col: 0,
        language: 'typescript',
      }],
      truncated: true,
    };

    const output = formatSlice(slice);
    expect(output).toContain('-- root: runIndex');
    expect(output).toContain('References:');
    expect(output).toContain('extractAndBuffer');
    expect(output).toContain('Other matches:');
    expect(output).toContain('src/other.ts:5:0');
    expect(output).toContain('Output truncated.');
  });
});
