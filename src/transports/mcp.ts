#!/usr/bin/env node

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase, applySchema } from '../db/schema.js';
import { QueryEngine } from '../query/engine.js';
import { runIndex } from '../index/orchestrator.js';
import { detectRoot } from '../workspace/detector.js';
import type Database from 'better-sqlite3';

// Side-effect: register all language adapters
import '../analysis/languages/typescript.js';
import '../analysis/languages/python.js';
import '../analysis/languages/go.js';
import '../analysis/languages/rust.js';
import '../analysis/languages/java.js';
import '../analysis/languages/csharp.js';

// ── Server Setup ──────────────────────────────────────────────────────

let db: Database.Database | null = null;
let engine: QueryEngine | null = null;
let indexRootDir: string | null = null;
let lastFreshnessCheck = 0;
const FRESHNESS_INTERVAL = parseInt(process.env.NEXUS_FRESHNESS_INTERVAL ?? '30000', 10); // ms, default 30s

function getEngine(): QueryEngine {
  if (engine) return engine;
  throw new Error('Index not initialized. Server is still starting up.');
}

/**
 * Ensure index is fresh before queries. If more than FRESHNESS_INTERVAL ms
 * since the last check, run an incremental reindex. The incremental mode
 * uses mtime/size/hash detection — if nothing changed, it's fast (~100ms).
 */
function ensureFresh(): void {
  if (!indexRootDir) return;
  const now = Date.now();
  if (now - lastFreshnessCheck < FRESHNESS_INTERVAL) return;

  try {
    runIndex(indexRootDir);
  } catch (err) {
    console.error(`Freshness check warning: ${err instanceof Error ? err.message : err}`);
  }
  lastFreshnessCheck = now;
}

/**
 * Initialize the index: detect root, open DB, run incremental reindex.
 * Called on server startup. Queries can proceed with stale data during reindex.
 */
function initializeIndex(startDir: string): void {
  const rootDir = detectRoot(startDir);
  indexRootDir = rootDir;
  const dbPath = path.join(rootDir, '.nexus', 'index.db');

  // Ensure .nexus directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Run incremental index (creates DB if needed)
  try {
    runIndex(rootDir);
  } catch (err) {
    // Log but don't crash — stale index is better than no server
    console.error(`Reindex warning: ${err instanceof Error ? err.message : err}`);
  }

  // Open DB for queries
  db = openDatabase(dbPath);
  applySchema(db);
  engine = new QueryEngine(db);
  lastFreshnessCheck = Date.now();
}

// ── MCP Server ────────────────────────────────────────────────────────

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'nexus', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ── List Tools ──────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'nexus_find',
          description: 'Find where a symbol is defined. Returns file path, line, kind, signature, and docs.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              name: { type: 'string', description: 'Symbol name to find' },
              kind: { type: 'string', description: 'Optional kind filter (function, class, interface, type, constant, enum, component, hook, method)' },
            },
            required: ['name'],
          },
        },
        {
          name: 'nexus_refs',
          description: 'Find all occurrences of an identifier across the codebase. Results include file, line, context, and confidence level (exact or heuristic).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              name: { type: 'string', description: 'Identifier name to search for' },
            },
            required: ['name'],
          },
        },
        {
          name: 'nexus_exports',
          description: 'List all exports and re-exports from a file. Shows name, kind, flags (default, star, type), and source for re-exports.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file: { type: 'string', description: 'File path (relative or absolute, supports partial/suffix match)' },
            },
            required: ['file'],
          },
        },
        {
          name: 'nexus_imports',
          description: 'List all imports for a file. Shows imported names, source modules, and flags (default, star, type).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file: { type: 'string', description: 'File path (relative or absolute, supports partial/suffix match)' },
            },
            required: ['file'],
          },
        },
        {
          name: 'nexus_importers',
          description: 'Find all files that import from a given source module. Answers "who depends on X?" — the inverse of nexus_imports. Supports exact and substring matching.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              source: { type: 'string', description: 'Module source to search for (e.g. "@dnd-kit/core", "react", "./utils")' },
            },
            required: ['source'],
          },
        },
        {
          name: 'nexus_tree',
          description: 'List indexed files under a path prefix with symbol counts and export summaries. Useful for understanding project structure.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              path: { type: 'string', description: 'Optional path prefix to filter (e.g. "src/components")' },
            },
          },
        },
        {
          name: 'nexus_search',
          description: 'Fuzzy search across all symbol names. Returns matches ranked by relevance with score percentage. Optional path filtering narrows results to part of the repo.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Search query (supports fuzzy matching)' },
              limit: { type: 'number', description: 'Max results (default: 20)' },
              kind: { type: 'string', description: 'Optional kind filter (function, class, interface, type, constant, enum, component, hook, method)' },
              path: { type: 'string', description: 'Optional path prefix to narrow results (e.g. "src/components")' },
            },
            required: ['query'],
          },
        },
        {
          name: 'nexus_symbols',
          description: 'List all symbols defined in a file (functions, classes, types, variables, etc.). Avoids reading the full file. Use to understand a module\'s internals.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file: { type: 'string', description: 'File path (relative or absolute, supports partial/suffix match)' },
              kind: { type: 'string', description: 'Optional kind filter (function, class, interface, type, constant, enum, component, hook, method, variable)' },
            },
            required: ['file'],
          },
        },
        {
          name: 'nexus_grep',
          description: 'Search file contents with regex. Searches indexed files only (respects ignore rules). Use for string literals, CSS values, comments, config values, regex patterns — anything that is not a symbol name.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              pattern: { type: 'string', description: 'Regex pattern to search for (JavaScript regex syntax)' },
              path: { type: 'string', description: 'Optional path prefix to narrow search (e.g. "src/components")' },
              language: { type: 'string', description: 'Optional language filter (typescript, python, go, rust, java, csharp, css)' },
              limit: { type: 'number', description: 'Max results (default: 50)' },
            },
            required: ['pattern'],
          },
        },
        {
          name: 'nexus_outline',
          description: 'Structural outline of one file or multiple files: all symbols organized by scope with signatures and line ranges. Replaces reading full files to understand structure.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file: {
                oneOf: [
                  { type: 'string' as const, description: 'File path (relative or absolute, supports partial/suffix match)' },
                  {
                    type: 'array' as const,
                    items: { type: 'string' as const },
                    description: 'Array of file paths (relative or absolute, supports partial/suffix match)',
                  },
                ],
              },
            },
            required: ['file'],
          },
        },
        {
          name: 'nexus_source',
          description: 'Extract the source code for a specific symbol (function, class, type, etc.) without reading the entire file. Returns just the relevant lines with file location.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              name: { type: 'string', description: 'Symbol name to extract source for' },
              file: { type: 'string', description: 'Optional file path to narrow results when the symbol exists in multiple files' },
            },
            required: ['name'],
          },
        },
        {
          name: 'nexus_slice',
          description: 'Extract a symbol\'s source plus the source of the named symbols it references inside its body. Name-based approximation: useful when you want a function and its direct dependencies without reading several files.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              name: { type: 'string', description: 'Symbol name to slice around' },
              file: { type: 'string', description: 'Optional file path to narrow ambiguous symbols' },
              limit: { type: 'number', description: 'Max referenced symbols to include (default: 20, max: 50)' },
            },
            required: ['name'],
          },
        },
        {
          name: 'nexus_deps',
          description: 'Transitive dependency graph from a file. Follows imports or reverse-imports up to a given depth, returning a tree with export summaries. Replaces multiple sequential nexus_imports/nexus_importers calls.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file: { type: 'string', description: 'File path (relative or absolute, supports partial/suffix match)' },
              direction: { type: 'string', enum: ['imports', 'importers'], description: 'Direction: "imports" (default) follows what the file imports; "importers" follows what imports the file' },
              depth: { type: 'number', description: 'Max traversal depth (default: 2, max: 5)' },
            },
            required: ['file'],
          },
        },
        {
          name: 'nexus_stats',
          description: 'Full index summary: file counts, symbol totals, per-language capabilities, index status and health.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
          },
        },
        {
          name: 'nexus_reindex',
          description: 'Trigger an incremental reindex. Detects changed/added/deleted files and re-parses only those. Use when files have been modified during a session and you need up-to-date results.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
          },
        },
      ],
    };
  });

  // ── Call Tool ───────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // nexus_reindex is handled before freshness check (it IS the freshness mechanism)
      if (name === 'nexus_reindex') {
        if (!indexRootDir) throw new Error('Index root not initialized');
        const result = runIndex(indexRootDir);
        lastFreshnessCheck = Date.now();
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      // Auto-refresh if stale (>30s since last check)
      ensureFresh();

      const qe = getEngine();

      switch (name) {
        case 'nexus_find': {
          const { name: symbolName, kind } = args as { name: string; kind?: string };
          const result = qe.find(symbolName, kind);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_refs': {
          const { name: identName } = args as { name: string };
          const result = qe.occurrences(identName);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_exports': {
          const { file } = args as { file: string };
          const result = qe.exports(file);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_imports': {
          const { file } = args as { file: string };
          const result = qe.imports(file);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_importers': {
          const { source } = args as { source: string };
          const result = qe.importers(source);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_tree': {
          const { path: pathPrefix } = (args ?? {}) as { path?: string };
          const result = qe.tree(pathPrefix);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_search': {
          const { query, limit, kind, path: pathPrefix } = args as {
            query: string; limit?: number; kind?: string; path?: string;
          };
          const result = qe.search(query, limit, kind, pathPrefix);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_symbols': {
          const { file, kind } = args as { file: string; kind?: string };
          const result = qe.symbols(file, kind);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_grep': {
          const { pattern, path: pathPrefix, language, limit } = args as {
            pattern: string; path?: string; language?: string; limit?: number;
          };
          const result = qe.grep(pattern, pathPrefix, language, limit);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_outline': {
          const { file } = args as { file: string | string[] };
          const result = Array.isArray(file) ? qe.outlineMany(file) : qe.outline(file);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_source': {
          const { name: symbolName, file } = args as { name: string; file?: string };
          const result = qe.source(symbolName, file);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_slice': {
          const { name: symbolName, file, limit } = args as {
            name: string; file?: string; limit?: number;
          };
          const result = qe.slice(symbolName, { file, limit });
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_deps': {
          const { file, direction, depth } = args as { file: string; direction?: 'imports' | 'importers'; depth?: number };
          const result = qe.deps(file, direction, depth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_stats': {
          const result = qe.stats();
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${errorMessage}` }], isError: true };
    }
  });

  return server;
}

// ── Main ──────────────────────────────────────────────────────────────

export async function startServer(startDir?: string): Promise<void> {
  // Initialize index before accepting queries
  initializeIndex(startDir ?? process.cwd());

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Nexus MCP server running on stdio');
}

// Run when executed directly
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('transports/mcp.js')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('transports/mcp.ts');

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start Nexus MCP server:', err);
    process.exit(1);
  });
}
