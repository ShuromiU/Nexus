#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runIndex } from '../index/orchestrator.js';
import { openDatabase, applySchema } from '../db/schema.js';
import { QueryEngine } from '../query/engine.js';
import { repair } from '../db/integrity.js';
import { detectRoot, detectCaseSensitivity } from '../workspace/detector.js';
import type {
  SymbolResult, OccurrenceResult, ModuleEdgeResult,
  TreeEntry, IndexStats, NexusResult, ImporterResult, GrepResult,
  OutlineResult, BatchOutlineResult, SourceResult, SliceResult, DepsResult,
} from '../query/engine.js';

// Side-effect: register all language adapters
import '../analysis/languages/typescript.js';
import '../analysis/languages/python.js';
import '../analysis/languages/go.js';
import '../analysis/languages/rust.js';
import '../analysis/languages/java.js';
import '../analysis/languages/csharp.js';

// ── Output Formatting ─────────────────────────────────────────────────

function formatSymbols(results: SymbolResult[]): string {
  if (results.length === 0) return 'No symbols found.';

  const lines: string[] = [];
  for (const s of results) {
    const loc = `${s.file}:${s.line}:${s.col}`;
    const sig = s.signature ? ` ${s.signature}` : '';
    const scope = s.scope ? ` (in ${s.scope})` : '';
    lines.push(`  ${s.kind.padEnd(12)} ${s.name}${sig}${scope}`);
    lines.push(`               ${loc}`);
    if (s.doc) {
      lines.push(`               ${s.doc}`);
    }
  }
  return lines.join('\n');
}

function formatOccurrences(results: OccurrenceResult[]): string {
  if (results.length === 0) return 'No occurrences found.';

  const lines: string[] = [];
  for (const o of results) {
    const conf = o.confidence === 'exact' ? '*' : '~';
    lines.push(`  ${conf} ${o.file}:${o.line}:${o.col}`);
    if (o.context) {
      lines.push(`    ${o.context.trim()}`);
    }
  }
  lines.push('');
  lines.push('  * = exact, ~ = heuristic');
  return lines.join('\n');
}

function formatEdges(results: ModuleEdgeResult[], direction: 'exports' | 'imports'): string {
  if (results.length === 0) return `No ${direction} found.`;

  const lines: string[] = [];
  for (const e of results) {
    const flags: string[] = [];
    if (e.is_default) flags.push('default');
    if (e.is_star) flags.push('*');
    if (e.is_type) flags.push('type');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

    const name = e.name ?? (e.is_star ? '*' : '<unnamed>');
    const alias = e.alias ? ` as ${e.alias}` : '';
    const source = e.source ? ` from '${e.source}'` : '';

    lines.push(`  ${e.kind.padEnd(10)} ${name}${alias}${source}${flagStr}  :${e.line}`);
  }
  return lines.join('\n');
}

function formatImporters(results: ImporterResult[]): string {
  if (results.length === 0) return 'No files import from this source.';

  const lines: string[] = [];
  for (const r of results) {
    const flags: string[] = [];
    if (r.is_default) flags.push('default');
    if (r.is_star) flags.push('*');
    if (r.is_type) flags.push('type');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    const names = r.names.length > 0 ? r.names.join(', ') : '<side-effect>';
    lines.push(`  ${r.file}:${r.line}`);
    lines.push(`    imports { ${names} } from '${r.source}'${flagStr}`);
  }
  return lines.join('\n');
}

function formatTree(results: TreeEntry[]): string {
  if (results.length === 0) return 'No files found.';

  const lines: string[] = [];
  for (const f of results) {
    const status = f.status !== 'indexed' ? ` [${f.status}]` : '';
    const exports = f.exports.length > 0 ? ` → ${f.exports.join(', ')}` : '';
    lines.push(`  ${f.path}  (${f.language}, ${f.symbol_count} symbols)${exports}${status}`);
  }
  return lines.join('\n');
}

function formatGrepResults(results: GrepResult[]): string {
  if (results.length === 0) return 'No matches found.';

  const lines: string[] = [];
  for (const r of results) {
    lines.push(`  ${r.file}:${r.line}:${r.col}`);
    lines.push(`    ${r.context.trim()}`);
  }
  return lines.join('\n');
}

function formatStats(stats: IndexStats): string {
  const lines: string[] = [];

  lines.push(`  Root:      ${stats.root}`);
  lines.push(`  Status:    ${stats.index_status} | Health: ${stats.index_health}`);
  lines.push(`  Indexed:   ${stats.last_indexed_at || 'never'}`);
  lines.push(`  Schema:    v${stats.schema_version} | Extractor: v${stats.extractor_version}`);
  lines.push('');
  lines.push(`  Files:     ${stats.files.total} total, ${stats.files.indexed} indexed, ${stats.files.skipped} skipped, ${stats.files.errored} errored`);
  lines.push(`  Symbols:   ${stats.symbols_total}`);

  const langs = Object.entries(stats.languages);
  if (langs.length > 0) {
    lines.push('');
    lines.push('  Languages:');
    for (const [lang, info] of langs) {
      const caps = info.capabilities;
      const capList: string[] = ['defs'];
      if (caps.imports) capList.push('imports');
      if (caps.exports) capList.push('exports');
      if (caps.occurrences) capList.push(`refs(${caps.occurrenceQuality})`);
      if (caps.typeExports) capList.push('type-exports');
      if (caps.docstrings) capList.push('docs');
      if (caps.signatures) capList.push('sigs');
      lines.push(`    ${lang.padEnd(20)} ${info.files} files, ${info.symbols} symbols  [${capList.join(', ')}]`);
    }
  }

  return lines.join('\n');
}

function formatOutline(result: OutlineResult): string {
  const lines: string[] = [];
  lines.push(`  ${result.file}  (${result.language}, ${result.lines} lines)`);
  lines.push('');

  if (result.imports.length > 0) {
    lines.push('  Imports:');
    for (const imp of result.imports) {
      const typeFlag = imp.is_type ? ' [type]' : '';
      const names = imp.names.length > 0 ? `{ ${imp.names.join(', ')} }` : '<side-effect>';
      lines.push(`    ${names} from '${imp.source}'${typeFlag}`);
    }
    lines.push('');
  }

  if (result.exports.length > 0) {
    lines.push(`  Exports: ${result.exports.join(', ')}`);
    lines.push('');
  }

  const formatEntry = (entry: OutlineResult['outline'][0], indent: number) => {
    const pad = '  '.repeat(indent);
    const range = entry.end_line ? `:${entry.line}-${entry.end_line}` : `:${entry.line}`;
    const sig = entry.signature ? ` ${entry.signature}` : '';
    const doc = entry.doc_summary ? `  — ${entry.doc_summary}` : '';
    lines.push(`${pad}${entry.kind.padEnd(12)} ${entry.name}${sig}${range}${doc}`);
    if (entry.children) {
      for (const child of entry.children) {
        formatEntry(child, indent + 1);
      }
    }
  };

  for (const entry of result.outline) {
    formatEntry(entry, 1);
  }

  return lines.join('\n');
}

function formatBatchOutline(result: BatchOutlineResult): string {
  const lines: string[] = [];
  const entries = Object.entries(result.outlines);

  if (entries.length === 0) {
    lines.push('No matching files found.');
  } else {
    for (let i = 0; i < entries.length; i++) {
      const outline = entries[i][1];
      lines.push(`  -- ${outline.file} --`);
      lines.push(formatOutline(outline));
      if (i < entries.length - 1) {
        lines.push('');
      }
    }
  }

  if (result.missing && result.missing.length > 0) {
    lines.push('');
    lines.push('  Missing:');
    for (const file of result.missing) {
      lines.push(`    ${file}`);
    }
  }

  return lines.join('\n');
}

function formatSource(results: SourceResult[]): string {
  if (results.length === 0) return 'No matching symbols found.';

  const lines: string[] = [];
  for (const r of results) {
    const sig = r.signature ? ` ${r.signature}` : '';
    lines.push(`  ── ${r.kind} ${r.name}${sig}  ${r.file}:${r.line}-${r.end_line}`);
    if (r.doc) {
      lines.push(`  ${r.doc}`);
    }
    lines.push('');
    for (const srcLine of r.source.split('\n')) {
      lines.push(`  ${srcLine}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatSlice(result: SliceResult): string {
  const lines: string[] = [];
  lines.push(`  -- root: ${result.root.name}  ${result.root.file}:${result.root.line}-${result.root.end_line} --`);
  lines.push('');
  for (const srcLine of result.root.source.split('\n')) {
    lines.push(`  ${srcLine}`);
  }

  if (result.references.length > 0) {
    lines.push('');
    lines.push('  References:');
    for (const ref of result.references) {
      lines.push(`  -- ${ref.name}  ${ref.file}:${ref.line}-${ref.end_line} --`);
      for (const srcLine of ref.source.split('\n')) {
        lines.push(`  ${srcLine}`);
      }
      lines.push('');
    }
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
  } else {
    lines.push('');
    lines.push('  No referenced symbols found.');
  }

  if (result.disambiguation && result.disambiguation.length > 0) {
    lines.push('');
    lines.push('  Other matches:');
    for (const alt of result.disambiguation) {
      lines.push(`    ${alt.kind} ${alt.name}  ${alt.file}:${alt.line}:${alt.col}`);
    }
  }

  if (result.truncated) {
    lines.push('');
    lines.push('  Output truncated.');
  }

  return lines.join('\n');
}

function formatDeps(result: DepsResult): string {
  const lines: string[] = [];
  lines.push(`  ${result.direction === 'imports' ? 'Dependencies' : 'Dependents'} of ${result.root} (depth: ${result.depth})`);
  lines.push('');

  const formatNode = (node: DepsResult['tree'], indent: number, isLast: boolean, prefix: string) => {
    const connector = indent === 0 ? '' : (isLast ? '└── ' : '├── ');
    const exports = node.exports && node.exports.length > 0 ? ` → ${node.exports.join(', ')}` : '';
    lines.push(`${prefix}${connector}${node.file}  (${node.language})${exports}`);

    const childPrefix = indent === 0 ? '  ' : prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.deps.length; i++) {
      formatNode(node.deps[i], indent + 1, i === node.deps.length - 1, childPrefix);
    }
  };

  formatNode(result.tree, 0, true, '  ');
  return lines.join('\n');
}

function printEnvelope<T>(result: NexusResult<T>, body: string): void {
  console.log(body);
  console.log('');
  console.log(`  ${result.count} result(s) in ${result.timing_ms}ms | index: ${result.index_status}, health: ${result.index_health}`);
}

// ── DB Helpers ────────────────────────────────────────────────────────

function openQueryDb(startDir: string): { db: ReturnType<typeof openDatabase>; rootDir: string; dbPath: string } {
  const rootDir = detectRoot(startDir);
  const dbPath = path.join(rootDir, '.nexus', 'index.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`No index found at ${dbPath}. Run 'nexus build' first.`);
    process.exit(1);
  }

  const db = openDatabase(dbPath);
  applySchema(db);
  return { db, rootDir, dbPath };
}

// ── CLI Definition ────────────────────────────────────────────────────

export function createProgram(): Command {
  const program = new Command();

  program
    .name('nexus')
    .description('Codebase index & query tool — one query replaces five searches')
    .version('0.2.0');

  // ── build ─────────────────────────────────────────────────────────

  program
    .command('build')
    .description('Build or update the index')
    .option('--incremental', 'Run incremental update (default behavior)')
    .action((_opts) => {
      try {
        const result = runIndex(process.cwd());
        console.log(`Index ${result.mode} build complete:`);
        console.log(`  ${result.filesScanned} scanned, ${result.filesIndexed} indexed, ${result.filesSkipped} skipped, ${result.filesErrored} errored`);
        console.log(`  ${result.durationMs}ms`);
      } catch (err) {
        console.error(`Build failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ── rebuild ───────────────────────────────────────────────────────

  program
    .command('rebuild')
    .description('Force a full index rebuild')
    .option('--force', 'Force full rebuild (default for rebuild)')
    .action((_opts) => {
      try {
        const result = runIndex(process.cwd(), true);
        console.log(`Full rebuild complete:`);
        console.log(`  ${result.filesScanned} scanned, ${result.filesIndexed} indexed, ${result.filesSkipped} skipped, ${result.filesErrored} errored`);
        console.log(`  ${result.durationMs}ms`);
      } catch (err) {
        console.error(`Rebuild failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ── find ──────────────────────────────────────────────────────────

  program
    .command('find <name>')
    .description('Find where a symbol is defined')
    .option('-k, --kind <kind>', 'Filter by symbol kind (function, class, interface, etc.)')
    .action((name: string, opts: { kind?: string }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.find(name, opts.kind);
        printEnvelope(result, formatSymbols(result.results));
      } finally {
        db.close();
      }
    });

  // ── refs ──────────────────────────────────────────────────────────

  program
    .command('refs <name>')
    .description('Find all occurrences of an identifier')
    .option('--ref-kinds <kinds>', 'comma-separated: call,read,write,type-ref,declaration')
    .action((name: string, opts: { refKinds?: string }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.occurrences(name, {
          ref_kinds: opts.refKinds?.split(',').map(s => s.trim()),
        });
        printEnvelope(result, formatOccurrences(result.results));
      } finally {
        db.close();
      }
    });

  // ── exports ───────────────────────────────────────────────────────

  program
    .command('exports <file>')
    .description('List what a file exports')
    .action((file: string) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.exports(file);
        printEnvelope(result, formatEdges(result.results, 'exports'));
      } finally {
        db.close();
      }
    });

  // ── imports ───────────────────────────────────────────────────────

  program
    .command('imports <file>')
    .description('List what a file imports')
    .action((file: string) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.imports(file);
        printEnvelope(result, formatEdges(result.results, 'imports'));
      } finally {
        db.close();
      }
    });

  // ── importers ──────────────────────────────────────────────────────

  program
    .command('importers <source>')
    .description('Find all files that import from a source module')
    .action((source: string) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.importers(source);
        printEnvelope(result, formatImporters(result.results));
      } finally {
        db.close();
      }
    });

  // ── tree ──────────────────────────────────────────────────────────

  program
    .command('tree [path]')
    .description('List indexed files under a path prefix with export summaries')
    .action((pathPrefix?: string) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.tree(pathPrefix);
        printEnvelope(result, formatTree(result.results));
      } finally {
        db.close();
      }
    });

  // ── search ────────────────────────────────────────────────────────

  program
    .command('search <query>')
    .description('Fuzzy search across symbol names')
    .option('-l, --limit <n>', 'Max results', '20')
    .option('-p, --path <prefix>', 'Path prefix filter')
    .action((query: string, opts: { limit: string; path?: string }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const limit = parseInt(opts.limit, 10) || 20;
        const result = engine.search(query, limit, undefined, opts.path);
        // Format search results like find, but with score
        const lines: string[] = [];
        if (result.results.length === 0) {
          lines.push('No matches found.');
          if (result.suggestions && result.suggestions.length > 0) {
            lines.push('');
            lines.push('  Did you mean?');
            for (const s of result.suggestions) {
              lines.push(`    - ${s}`);
            }
          }
        } else {
          for (const s of result.results) {
            const score = (s._score * 100).toFixed(0);
            const loc = `${s.file}:${s.line}:${s.col}`;
            lines.push(`  ${score.padStart(3)}%  ${s.kind.padEnd(12)} ${s.name}`);
            lines.push(`               ${loc}`);
          }
        }
        printEnvelope(result, lines.join('\n'));
      } finally {
        db.close();
      }
    });

  // ── grep ──────────────────────────────────────────────────────────

  program
    .command('grep <pattern>')
    .description('Search file contents with regex across all indexed files')
    .option('-p, --path <prefix>', 'Path prefix filter')
    .option('--lang <language>', 'Language filter')
    .option('-l, --limit <n>', 'Max results', '50')
    .action((pattern: string, opts: { path?: string; lang?: string; limit: string }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const limit = parseInt(opts.limit, 10) || 50;
        const result = engine.grep(pattern, opts.path, opts.lang, limit);
        printEnvelope(result, formatGrepResults(result.results));
      } finally {
        db.close();
      }
    });

  // ── outline ───────────────────────────────────────────────────────

  program
    .command('outline <files...>')
    .description('Structural outline of a file — symbols, imports, exports')
    .action((files: string[]) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        if (files.length === 1) {
          const result = engine.outline(files[0]);
          if (result.results.length > 0) {
            printEnvelope(result, formatOutline(result.results[0]));
          } else {
            printEnvelope(result, 'File not found.');
          }
        } else {
          const result = engine.outlineMany(files);
          printEnvelope(result, formatBatchOutline(result.results[0]));
        }
      } finally {
        db.close();
      }
    });

  // ── source ───────────────────────────────────────────────────────

  program
    .command('source <name>')
    .description('Extract source code for a symbol')
    .option('-f, --file <file>', 'Narrow to a specific file')
    .action((name: string, opts: { file?: string }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.source(name, opts.file);
        printEnvelope(result, formatSource(result.results));
      } finally {
        db.close();
      }
    });

  program
    .command('slice <name>')
    .description('Extract a symbol and the named symbols it references')
    .option('-f, --file <file>', 'Narrow to a specific file')
    .option('-l, --limit <n>', 'Max referenced symbols', '20')
    .option('--ref-kinds <kinds>', 'comma-separated: call,read,write,type-ref,declaration')
    .action((name: string, opts: { file?: string; limit: string; refKinds?: string }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const limit = parseInt(opts.limit, 10) || 20;
        const result = engine.slice(name, {
          file: opts.file,
          limit,
          ref_kinds: opts.refKinds?.split(',').map(s => s.trim()),
        });
        if (result.results.length > 0) {
          printEnvelope(result, formatSlice(result.results[0]));
        } else {
          printEnvelope(result, 'No matching symbols found.');
        }
      } finally {
        db.close();
      }
    });

  // ── deps ─────────────────────────────────────────────────────────

  program
    .command('deps <file>')
    .description('Show transitive dependency tree')
    .option('-d, --direction <dir>', 'imports or importers', 'imports')
    .option('--depth <n>', 'Max depth (1-5)', '2')
    .action((file: string, opts: { direction: string; depth: string }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const direction = opts.direction === 'importers' ? 'importers' as const : 'imports' as const;
        const depth = Math.min(Math.max(parseInt(opts.depth, 10) || 2, 1), 5);
        const result = engine.deps(file, direction, depth);
        if (result.results.length > 0) {
          printEnvelope(result, formatDeps(result.results[0]));
        } else {
          printEnvelope(result, 'File not found.');
        }
      } finally {
        db.close();
      }
    });

  // ── stats ─────────────────────────────────────────────────────────

  program
    .command('stats')
    .description('Show index summary and per-language capabilities')
    .action(() => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.stats();
        printEnvelope(result, formatStats(result.results[0]));
      } finally {
        db.close();
      }
    });

  // ── repair ────────────────────────────────────────────────────────

  program
    .command('repair')
    .description('Run full integrity check, rebuild if corrupt')
    .action(() => {
      const rootDir = detectRoot(process.cwd());
      const dbPath = path.join(rootDir, '.nexus', 'index.db');

      if (!fs.existsSync(dbPath)) {
        console.log('No index found. Run \'nexus build\' to create one.');
        return;
      }

      const caseSensitive = detectCaseSensitivity(rootDir);
      const result = repair(dbPath, rootDir, caseSensitive);
      console.log(result.message);

      if (result.needsRebuild) {
        console.log('Running full rebuild...');
        const buildResult = runIndex(rootDir, true);
        console.log(`Rebuild complete: ${buildResult.filesIndexed} files indexed in ${buildResult.durationMs}ms`);
      }
    });

  // ── New token-saver commands ──────────────────────────────────────
  // These output JSON (use --pretty for indented). MCP-first tools — the
  // CLI is provided for scripting and quick local debugging.

  const printJson = (value: unknown, pretty: boolean): void => {
    console.log(pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
  };

  program
    .command('callers <name>')
    .description('Find functions/classes that call this symbol (inverse of slice)')
    .option('-f, --file <file>', 'Disambiguate when name is multi-defined')
    .option('-d, --depth <n>', 'Recursion depth, 1-3', '1')
    .option('-l, --limit <n>', 'Max callers per level', '30')
    .option('--ref-kinds <kinds>', 'comma-separated: call,read,write,type-ref,declaration')
    .option('--pretty', 'Pretty-print JSON')
    .action((name: string, opts: { file?: string; depth: string; limit: string; refKinds?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.callers(name, {
          file: opts.file,
          depth: parseInt(opts.depth, 10) || 1,
          limit: parseInt(opts.limit, 10) || 30,
          ref_kinds: opts.refKinds?.split(',').map(s => s.trim()),
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('pack <query>')
    .description('Token-budget-aware context bundle (outlines + sources up to budget)')
    .option('-b, --budget <n>', 'Token budget', '4000')
    .option('-p, --paths <paths>', 'Comma-separated path prefixes')
    .option('--pretty', 'Pretty-print JSON')
    .action((query: string, opts: { budget: string; paths?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.pack(query, {
          budget_tokens: parseInt(opts.budget, 10) || 4000,
          paths: opts.paths ? opts.paths.split(',').map(s => s.trim()) : undefined,
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('changed')
    .description('Files changed since a git ref with current outlines')
    .option('-r, --ref <ref>', 'Git ref to compare against', 'HEAD~1')
    .option('--pretty', 'Pretty-print JSON')
    .action((opts: { ref: string; pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.changed({ ref: opts.ref });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('diff-outline <refA> [refB]')
    .description('Semantic diff of symbols between two git refs')
    .option('--pretty', 'Pretty-print JSON')
    .action((refA: string, refB: string | undefined, opts: { pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.diffOutline(refA, refB);
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('signatures <names...>')
    .description('Batch signature lookup (no body) for multiple symbol names')
    .option('-f, --file <file>', 'Optional file scope')
    .option('-k, --kind <kind>', 'Optional kind filter')
    .option('--pretty', 'Pretty-print JSON')
    .action((names: string[], opts: { file?: string; kind?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.signatures(names, { file: opts.file, kind: opts.kind });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('definition-at <file> <line> [col]')
    .description('Resolve identifier at file:line[:col] to its definition source')
    .option('--pretty', 'Pretty-print JSON')
    .action((file: string, line: string, col: string | undefined, opts: { pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.definitionAt(file, parseInt(line, 10), col ? parseInt(col, 10) : undefined);
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('unused-exports')
    .description('Find exports with no importers and no external occurrences')
    .option('-p, --path <prefix>', 'Path prefix to scope (e.g. "src/")')
    .option('-l, --limit <n>', 'Max results', '100')
    .option('--mode <mode>', 'default|runtime_only', 'default')
    .option('--pretty', 'Pretty-print JSON')
    .action((opts: { path?: string; limit: string; mode?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.unusedExports({
          path: opts.path,
          limit: parseInt(opts.limit, 10) || 100,
          mode: opts.mode === 'runtime_only' ? 'runtime_only' : 'default',
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('kind-index <kind>')
    .description('List all symbols of a given kind, optionally under a path prefix')
    .option('-p, --path <prefix>', 'Path prefix')
    .option('-l, --limit <n>', 'Max results', '200')
    .option('--pretty', 'Pretty-print JSON')
    .action((kind: string, opts: { path?: string; limit: string; pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.kindIndex(kind, {
          path: opts.path,
          limit: parseInt(opts.limit, 10) || 200,
        });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('doc <name>')
    .description('Just the docstring(s) for a symbol — no body')
    .option('-f, --file <file>', 'Optional file scope')
    .option('--pretty', 'Pretty-print JSON')
    .action((name: string, opts: { file?: string; pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.doc(name, { file: opts.file });
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('structured-query <file> <path>')
    .description('Extract a value from a structured config file by dotted path (e.g. "compilerOptions.strict")')
    .option('--pretty', 'Pretty-print JSON')
    .action((file: string, queryPath: string, opts: { pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.structuredQuery(file, queryPath);
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  program
    .command('structured-outline <file>')
    .description('List top-level keys of a structured config file with value kinds')
    .option('--pretty', 'Pretty-print JSON')
    .action((file: string, opts: { pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.structuredOutline(file);
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  // ── lockfile-deps ──────────────────────────────────────────────────

  program
    .command('lockfile-deps <file> [name]')
    .description('List {name, version} entries from a lockfile (yarn.lock, package-lock.json, pnpm-lock.yaml, Cargo.lock)')
    .option('--pretty', 'Pretty-print JSON')
    .action((file: string, name: string | undefined, opts: { pretty?: boolean }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.lockfileDeps(file, name);
        printJson(result, !!opts.pretty);
      } finally {
        db.close();
      }
    });

  // ── serve ──────────────────────────────────────────────────────────

  program
    .command('serve')
    .description('Start MCP server (stdio transport)')
    .action(async () => {
      const { startServer } = await import('./mcp.js');
      await startServer(process.cwd());
    });

  return program;
}

// ── Exports for formatting (used by tests and future MCP) ───────────

export {
  formatSymbols,
  formatOccurrences,
  formatEdges,
  formatImporters,
  formatTree,
  formatGrepResults,
  formatStats,
  formatOutline,
  formatBatchOutline,
  formatSource,
  formatSlice,
  formatDeps,
};

// ── Main ──────────────────────────────────────────────────────────────

// Only parse when run directly (not imported by tests)
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('transports/cli.js')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('transports/cli.ts');

if (isDirectRun) {
  const program = createProgram();
  program.parse();
}
