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

function getEngine(): QueryEngine {
  if (engine) return engine;
  throw new Error('Index not initialized. Server is still starting up.');
}

/**
 * Initialize the index: detect root, open DB, run incremental reindex.
 * Called on server startup. Queries can proceed with stale data during reindex.
 */
function initializeIndex(startDir: string): void {
  const rootDir = detectRoot(startDir);
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
          description: 'Fuzzy search across all symbol names. Returns matches ranked by relevance with score percentage.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Search query (supports fuzzy matching)' },
              limit: { type: 'number', description: 'Max results (default: 20)' },
              kind: { type: 'string', description: 'Optional kind filter (function, class, interface, type, constant, enum, component, hook, method)' },
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
          name: 'nexus_stats',
          description: 'Full index summary: file counts, symbol totals, per-language capabilities, index status and health.',
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
          const { query, limit, kind } = args as { query: string; limit?: number; kind?: string };
          const result = qe.search(query, limit, kind);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'nexus_symbols': {
          const { file, kind } = args as { file: string; kind?: string };
          const result = qe.symbols(file, kind);
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
