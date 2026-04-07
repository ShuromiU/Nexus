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
  TreeEntry, IndexStats, NexusResult, ImporterResult,
} from '../query/engine.js';

// Side-effect: register language adapters
import '../analysis/languages/typescript.js';

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
    .version('0.1.0');

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
    .action((name: string) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const result = engine.occurrences(name);
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
    .action((query: string, opts: { limit: string }) => {
      const { db } = openQueryDb(process.cwd());
      try {
        const engine = new QueryEngine(db);
        const limit = parseInt(opts.limit, 10) || 20;
        const result = engine.search(query, limit);
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
  formatStats,
};

// ── Main ──────────────────────────────────────────────────────────────

// Only parse when run directly (not imported by tests)
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('transports/cli.js')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('transports/cli.ts');

if (isDirectRun) {
  const program = createProgram();
  program.parse();
}
