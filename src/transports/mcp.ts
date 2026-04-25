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
import type { NexusResult } from '../query/engine.js';
import { compactify } from '../query/compact.js';
import { runIndex } from '../index/orchestrator.js';
import { buildWorktreeIndex } from '../index/overlay-orchestrator.js';
import { detectRoot, detectWorkspace, resolveRoot, type WorkspaceInfo } from '../workspace/detector.js';
import { NexusStore } from '../db/store.js';
import type Database from 'better-sqlite3';
import { dispatchPolicy } from '../policy/dispatcher.js';
import { DEFAULT_RULES } from '../policy/index.js';
import type { PolicyEvent } from '../policy/types.js';

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
let workspaceInfo: WorkspaceInfo | null = null;
let effectiveIndexMode: 'full' | 'overlay-on-parent' | 'worktree-isolated' = 'full';
let indexRootDir: string | null = null;
let lastFreshnessCheck = 0;
const FRESHNESS_INTERVAL = parseInt(process.env.NEXUS_FRESHNESS_INTERVAL ?? '30000', 10); // ms, default 30s

function getEngine(): QueryEngine {
  if (engine) return engine;
  throw new Error('Index not initialized. Server is still starting up.');
}

/**
 * Open the query engine for the current workspace, using the merged TEMP
 * views when in worktree+overlay mode. Caller must close the previous handle
 * via `closeEngine()` before calling.
 */
function openEngine(info: WorkspaceInfo, indexMode: typeof effectiveIndexMode): void {
  if (info.mode === 'worktree' && indexMode === 'overlay-on-parent') {
    // Parent index opened read-only; overlay attached read-only via URI mode=ro.
    db = openDatabase(info.baseIndexPath, { readonly: true });
    const store = new NexusStore(db);
    store.attachOverlay(info.overlayPath);
    engine = new QueryEngine(db, { sourceRoot: info.sourceRoot });
  } else {
    // Standalone, main, or worktree-isolated: single self-contained index.
    const dbPath = info.mode === 'worktree'
      ? path.join(info.root, '.nexus', 'index.db')
      : path.join(info.root, '.nexus', 'index.db');
    db = openDatabase(dbPath);
    applySchema(db);
    engine = new QueryEngine(db, { sourceRoot: info.sourceRoot });
  }
  effectiveIndexMode = indexMode;
}

function closeEngine(): void {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
  engine = null;
}

/**
 * Ensure index is fresh before queries. Routes via effective index mode:
 *   - overlay-on-parent → rebuild overlay against parent_git_head
 *   - full / worktree-isolated → existing runIndex on the worktree's own root
 */
function ensureFresh(): void {
  if (!workspaceInfo) return;
  const now = Date.now();
  if (now - lastFreshnessCheck < FRESHNESS_INTERVAL) return;

  try {
    if (workspaceInfo.mode === 'worktree' && effectiveIndexMode === 'overlay-on-parent') {
      const outcome = buildWorktreeIndex(workspaceInfo);
      // Re-open engine handle to pick up the freshly-published overlay
      // (Windows-safe: builder writes to .tmp + atomic rename; we close
      // before the next-attach implicit re-read).
      closeEngine();
      openEngine(workspaceInfo, outcome.kind === 'overlay' ? 'overlay-on-parent' : 'worktree-isolated');
    } else if (indexRootDir) {
      runIndex(indexRootDir);
    }
  } catch (err) {
    console.error(`Freshness check warning: ${err instanceof Error ? err.message : err}`);
  }
  lastFreshnessCheck = now;
}

/**
 * Initialize the index: detect workspace, run incremental reindex (or
 * overlay build for worktrees), open DB for queries.
 */
function initializeIndex(startDir: string): void {
  const info = detectWorkspace(startDir);
  workspaceInfo = info;
  indexRootDir = info.root;

  // Ensure .nexus directory exists at the worktree root (overlay or isolated lives here)
  fs.mkdirSync(path.join(info.root, '.nexus'), { recursive: true });

  // Build the appropriate index. Worktree mode chooses overlay vs isolated
  // based on compat gates; standalone/main always go through runIndex.
  let mode: typeof effectiveIndexMode = 'full';
  try {
    if (info.mode === 'worktree') {
      const outcome = buildWorktreeIndex(info);
      mode = outcome.kind === 'overlay' ? 'overlay-on-parent' : 'worktree-isolated';
      emitStartupBanner(info, mode, outcome.kind === 'isolated' ? outcome.reason : null);
    } else {
      runIndex(info.root);
      mode = 'full';
      emitStartupBanner(info, mode, null);
    }
  } catch (err) {
    console.error(`Reindex warning: ${err instanceof Error ? err.message : err}`);
  }

  openEngine(info, mode);
  lastFreshnessCheck = Date.now();
}

function emitStartupBanner(
  info: WorkspaceInfo,
  mode: typeof effectiveIndexMode,
  degradedReason: string | null,
): void {
  const resolved = resolveRoot();
  const rootSrc = resolved.source;
  const fs = info.mode;
  if (fs === 'worktree') {
    if (mode === 'overlay-on-parent') {
      console.error(`[nexus] fs=worktree index=overlay-on-parent root=${info.root} parent=${info.parentRoot} root_src=${rootSrc}`);
    } else {
      console.error(`[nexus] fs=worktree index=worktree-isolated reason=${degradedReason ?? 'unknown'} root=${info.root} root_src=${rootSrc}`);
    }
  } else {
    console.error(`[nexus] fs=${fs} index=${mode} root=${info.root} root_src=${rootSrc}`);
  }
}

// ── MCP Server ────────────────────────────────────────────────────────

/** Reusable schema fragment: every tool accepts an optional `compact` flag. */
const COMPACT_PROP = {
  compact: {
    type: 'boolean' as const,
    description: 'When true, return a minimal-key envelope (~50% smaller payload).',
  },
};

/** Build the standard MCP text response, applying compactify when requested. */
function respond<T>(result: NexusResult<T>, compact?: boolean): { content: { type: 'text'; text: string }[] } {
  const payload = compact ? compactify(result) : result;
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

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
              ...COMPACT_PROP,
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
              ref_kinds: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['call', 'read', 'write', 'type-ref', 'declaration'],
                },
                description:
                  'Optional filter: restrict to occurrences with these ref_kinds. ' +
                  'Only TypeScript/JavaScript files currently populate ref_kind — other ' +
                  'languages return no results under this filter.',
              },
              ...COMPACT_PROP,
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
              ...COMPACT_PROP,
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
              ...COMPACT_PROP,
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
              ...COMPACT_PROP,
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
              ...COMPACT_PROP,
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
              ...COMPACT_PROP,
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
              ...COMPACT_PROP,
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
              ...COMPACT_PROP,
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
              ...COMPACT_PROP,
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
              ...COMPACT_PROP,
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
              ref_kinds: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['call', 'read', 'write', 'type-ref', 'declaration'],
                },
                description:
                  'Optional filter: restrict to occurrences with these ref_kinds. ' +
                  'Only TypeScript/JavaScript files currently populate ref_kind — other ' +
                  'languages return no results under this filter.',
              },
              ...COMPACT_PROP,
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
              ...COMPACT_PROP,
            },
            required: ['file'],
          },
        },
        {
          name: 'nexus_stats',
          description: 'Full index summary: file counts, symbol totals, per-language capabilities, index status and health.',
          inputSchema: {
            type: 'object' as const,
            properties: { ...COMPACT_PROP },
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

        // ── New token-saver tools ─────────────────────────────────────

        {
          name: 'nexus_callers',
          description: 'Find every function/class that calls a symbol — the inverse of nexus_slice. Groups by caller with one snippet per call site. Optional depth recurses upward through the call graph (heuristic precision, occurrence-based).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              name: { type: 'string', description: 'Symbol name to find callers of' },
              file: { type: 'string', description: 'Optional file path to disambiguate when the name has multiple defs' },
              depth: { type: 'number', description: 'Recursion depth, 1-3 (default 1)' },
              limit: { type: 'number', description: 'Max callers per level (default 30, max 100)' },
              ref_kinds: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['call', 'read', 'write', 'type-ref', 'declaration'],
                },
                description:
                  'Optional filter: restrict to occurrences with these ref_kinds. ' +
                  'Only TypeScript/JavaScript files currently populate ref_kind — other ' +
                  'languages return no results under this filter.',
              },
              ...COMPACT_PROP,
            },
            required: ['name'],
          },
        },
        {
          name: 'nexus_pack',
          description: 'Token-budget-aware context bundler. Given a query and a token budget, assembles outlines + selected sources up to the budget. Replaces guessing what files to feed in for an LLM question.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Search query that drives ranking' },
              budget_tokens: { type: 'number', description: 'Token budget (default 4000, min 200, max 50000)' },
              paths: { type: 'array', items: { type: 'string' }, description: 'Optional path prefixes to scope ranking' },
              ...COMPACT_PROP,
            },
            required: ['query'],
          },
        },
        {
          name: 'nexus_changed',
          description: 'Files changed since a git ref (default HEAD~1) with their current outlines. Falls back to mtime-since-last-index when git is unavailable. Replaces reading full diffs for PR/branch review.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              ref: { type: 'string', description: 'Git ref to compare against (default "HEAD~1")' },
              ...COMPACT_PROP,
            },
          },
        },
        {
          name: 'nexus_diff_outline',
          description: 'Semantic diff: which symbols were added, removed, or modified between two git refs. Re-parses historical content via git show — does not require updating the index.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              ref_a: { type: 'string', description: 'Base git ref' },
              ref_b: { type: 'string', description: 'Target git ref (default "HEAD")' },
              ...COMPACT_PROP,
            },
            required: ['ref_a'],
          },
        },
        {
          name: 'nexus_signatures',
          description: 'Batch signature lookup: name + signature + doc summary for each input name, no body. Use when comparing siblings or auditing an interface — replaces N nexus_find/nexus_source calls.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              names: { type: 'array', items: { type: 'string' }, description: 'Symbol names to look up' },
              file: { type: 'string', description: 'Optional file path to scope results' },
              kind: { type: 'string', description: 'Optional kind filter' },
              ...COMPACT_PROP,
            },
            required: ['names'],
          },
        },
        {
          name: 'nexus_definition_at',
          description: 'LSP-style go-to-definition. Resolves the identifier at (file, line, col?) to its definition source. Best-effort heuristic.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file: { type: 'string', description: 'File path' },
              line: { type: 'number', description: 'Line number (1-based)' },
              col: { type: 'number', description: 'Optional column (1-based). When omitted, picks the first identifier on the line.' },
              ...COMPACT_PROP,
            },
            required: ['file', 'line'],
          },
        },
        {
          name: 'nexus_unused_exports',
          description: 'Find exports with no importers and no external occurrences — best-effort dead-code finder. Note: re-exports through index.ts may appear unused; filter by path to scope.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              path: { type: 'string', description: 'Optional path prefix to scope (e.g. "src/")' },
              limit: { type: 'number', description: 'Max results (default 100, max 500)' },
              mode: {
                type: 'string',
                enum: ['default', 'runtime_only'],
                description:
                  'default (unchanged): any use counts. runtime_only: type-only ' +
                  'imports and type-ref occurrences are ignored — flags runtime-dead ' +
                  'exports while preserving type-only-used exports under default mode.',
              },
              ...COMPACT_PROP,
            },
          },
        },
        {
          name: 'nexus_kind_index',
          description: 'List every symbol of a given kind (interface, class, component, hook, etc.) under an optional path prefix. Replaces grep/search chains for "show me every <kind> in this folder".',
          inputSchema: {
            type: 'object' as const,
            properties: {
              kind: { type: 'string', description: 'Symbol kind (function, class, interface, type, component, hook, method, …)' },
              path: { type: 'string', description: 'Optional path prefix' },
              limit: { type: 'number', description: 'Max results (default 200, max 1000)' },
              ...COMPACT_PROP,
            },
            required: ['kind'],
          },
        },
        {
          name: 'nexus_doc',
          description: 'Just the docstring(s) for a symbol — no body, no source. Tiny but hot path: avoids reading source bodies when you only need the comment block.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              name: { type: 'string', description: 'Symbol name' },
              file: { type: 'string', description: 'Optional file path to disambiguate' },
              ...COMPACT_PROP,
            },
            required: ['name'],
          },
        },
        {
          name: 'nexus_batch',
          description: 'Run several Nexus tools in a single MCP roundtrip. Saves protocol/envelope overhead when you already know you need N related queries.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              calls: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    tool: { type: 'string', description: 'Tool name (e.g. "nexus_find")' },
                    args: { type: 'object', description: 'Arguments for the tool' },
                  },
                  required: ['tool'],
                },
                description: 'Array of {tool, args} pairs to execute',
              },
              ...COMPACT_PROP,
            },
            required: ['calls'],
          },
        },
        {
          name: 'nexus_structured_query',
          description: 'Extract a single value from a structured config file (package.json, tsconfig, Cargo.toml, GHA workflow, generic JSON/YAML/TOML). Path uses dotted keys with numeric array indices: "scripts.test", "jobs.test.steps.0.run". Avoids reading the whole file.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file: { type: 'string', description: 'Path to the structured file (relative to repo root or absolute).' },
              path: { type: 'string', description: 'Dotted path into the parsed value. Numeric segments index into arrays.' },
              ...COMPACT_PROP,
            },
            required: ['file', 'path'],
          },
        },
        {
          name: 'nexus_structured_outline',
          description: 'List top-level keys of a structured file with their value kinds (string, number, boolean, null, array, object). Short previews for scalars; array length for arrays. Avoids reading the whole file.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file: { type: 'string', description: 'Path to the structured file (relative to repo root or absolute).' },
              ...COMPACT_PROP,
            },
            required: ['file'],
          },
        },
        {
          name: 'nexus_lockfile_deps',
          description: 'List {name, version} entries from a lockfile. Supported: yarn.lock, package-lock.json (v1/v2/v3), pnpm-lock.yaml, Cargo.lock. Optional name filter returns all versions of that package.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file: { type: 'string', description: 'Path to the lockfile (relative to repo root or absolute).' },
              name: { type: 'string', description: 'Optional: filter to entries with this exact package name.' },
              ...COMPACT_PROP,
            },
            required: ['file'],
          },
        },
        {
          name: 'nexus_policy_check',
          description:
            'Evaluate the Nexus policy layer against a hook event. Fallback for platforms without PreToolUse hook support; otherwise hook dispatchers should call the nexus-policy-check bin directly. Does NOT trigger a reindex — responses carry stale_hint.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              event: {
                type: 'object',
                description: 'Claude Code hook event payload',
                properties: {
                  hook_event_name: { type: 'string' },
                  tool_name: { type: 'string' },
                  tool_input: { type: 'object' },
                  tool_response: {
                    type: 'object',
                    description: 'Present on PostToolUse only',
                  },
                  session_id: { type: 'string' },
                  cwd: { type: 'string' },
                },
                required: ['tool_name', 'tool_input'],
              },
              ...COMPACT_PROP,
            },
            required: ['event'],
          },
        },
      ],
    };
  });

  // ── Call Tool ───────────────────────────────────────────────────────

  function executePolicyCheck(args: Record<string, unknown>): NexusResult<unknown> {
    const event = args.event;
    if (!event || typeof event !== 'object') {
      throw new Error('nexus_policy_check: event argument is required and must be an object');
    }
    const typedEvent = event as PolicyEvent;
    const rootDir = indexRootDir ?? process.cwd();
    const t0 = Date.now();
    let queryEngine: import('../policy/types.js').QueryEngineLike | undefined;
    try {
      queryEngine = getEngine() as unknown as import('../policy/types.js').QueryEngineLike;
    } catch {
      // Engine not yet initialized (e.g., in tests). Policy dispatch will work without it, but
      // some rules that require the engine may return 'noop'. This is acceptable.
    }
    const response = dispatchPolicy(typedEvent, { rootDir, rules: DEFAULT_RULES, queryEngine });
    const timing_ms = Date.now() - t0;
    return {
      type: 'policy_check',
      query: `policy_check ${typedEvent.tool_name ?? 'unknown'}`,
      results: [response],
      count: 1,
      index_status: response.stale_hint ? 'stale' : 'current',
      index_health: 'ok',
      timing_ms,
    };
  }

  /**
   * Dispatch a single tool call to its engine method. Returns the verbose
   * NexusResult — the caller decides whether to compactify. Used by both the
   * top-level CallToolRequest handler and the nexus_batch sub-dispatcher.
   */
  function dispatch(toolName: string, args: Record<string, unknown>): NexusResult<unknown> {
    if (toolName === 'nexus_policy_check') return executePolicyCheck(args);
    const qe = getEngine();
    switch (toolName) {
      case 'nexus_find':
        return qe.find(args.name as string, args.kind as string | undefined);
      case 'nexus_refs':
        return qe.occurrences(args.name as string, {
          ref_kinds: args.ref_kinds as string[] | undefined,
        });
      case 'nexus_exports':
        return qe.exports(args.file as string);
      case 'nexus_imports':
        return qe.imports(args.file as string);
      case 'nexus_importers':
        return qe.importers(args.source as string);
      case 'nexus_tree':
        return qe.tree(args.path as string | undefined);
      case 'nexus_search':
        return qe.search(args.query as string, args.limit as number | undefined, args.kind as string | undefined, args.path as string | undefined);
      case 'nexus_symbols':
        return qe.symbols(args.file as string, args.kind as string | undefined);
      case 'nexus_grep':
        return qe.grep(args.pattern as string, args.path as string | undefined, args.language as string | undefined, args.limit as number | undefined);
      case 'nexus_outline': {
        const f = args.file as string | string[];
        return Array.isArray(f) ? qe.outlineMany(f) : qe.outline(f);
      }
      case 'nexus_source':
        return qe.source(args.name as string, args.file as string | undefined);
      case 'nexus_slice':
        return qe.slice(args.name as string, {
          file: args.file as string | undefined,
          limit: args.limit as number | undefined,
          ref_kinds: args.ref_kinds as string[] | undefined,
        });
      case 'nexus_deps':
        return qe.deps(args.file as string, args.direction as 'imports' | 'importers' | undefined, args.depth as number | undefined);
      case 'nexus_stats':
        return qe.stats();
      case 'nexus_callers':
        return qe.callers(args.name as string, {
          file: args.file as string | undefined,
          depth: args.depth as number | undefined,
          limit: args.limit as number | undefined,
          ref_kinds: args.ref_kinds as string[] | undefined,
        });
      case 'nexus_pack':
        return qe.pack(args.query as string, {
          budget_tokens: args.budget_tokens as number | undefined,
          paths: args.paths as string[] | undefined,
        });
      case 'nexus_changed':
        return qe.changed({ ref: args.ref as string | undefined });
      case 'nexus_diff_outline':
        return qe.diffOutline(args.ref_a as string, args.ref_b as string | undefined);
      case 'nexus_signatures':
        return qe.signatures(args.names as string[], {
          file: args.file as string | undefined,
          kind: args.kind as string | undefined,
        });
      case 'nexus_definition_at':
        return qe.definitionAt(args.file as string, args.line as number, args.col as number | undefined);
      case 'nexus_unused_exports':
        return qe.unusedExports({
          path: args.path as string | undefined,
          limit: args.limit as number | undefined,
          mode: args.mode as 'default' | 'runtime_only' | undefined,
        });
      case 'nexus_kind_index':
        return qe.kindIndex(args.kind as string, {
          path: args.path as string | undefined,
          limit: args.limit as number | undefined,
        });
      case 'nexus_doc':
        return qe.doc(args.name as string, { file: args.file as string | undefined });
      case 'nexus_structured_query':
        return qe.structuredQuery(args.file as string, args.path as string);
      case 'nexus_structured_outline':
        return qe.structuredOutline(args.file as string);
      case 'nexus_lockfile_deps':
        return qe.lockfileDeps(args.file as string, args.name as string | undefined);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const compact = args.compact === true;

    try {
      // nexus_reindex is handled before freshness check (it IS the freshness mechanism)
      if (name === 'nexus_reindex') {
        if (!indexRootDir) throw new Error('Index root not initialized');
        const result = runIndex(indexRootDir);
        lastFreshnessCheck = Date.now();
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      if (name === 'nexus_policy_check') {
        const result = executePolicyCheck(args);
        return respond(result, compact);
      }

      // Auto-refresh if stale (>30s since last check)
      ensureFresh();

      // nexus_batch: run multiple sub-tools in one roundtrip
      if (name === 'nexus_batch') {
        const calls = (args.calls ?? []) as { tool: string; args?: Record<string, unknown> }[];
        const subResults = calls.map(call => {
          try {
            const subArgs = (call.args ?? {}) as Record<string, unknown>;
            const subCompact = compact || subArgs.compact === true;
            const sub = dispatch(call.tool, subArgs);
            return {
              tool: call.tool,
              ok: true as const,
              result: subCompact ? compactify(sub) : sub,
            };
          } catch (err) {
            return {
              tool: call.tool,
              ok: false as const,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        });
        const payload = compact
          ? { ty: 'batch', r: subResults }
          : { type: 'batch', results: subResults, count: subResults.length };
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      }

      const result = dispatch(name, args);
      return respond(result, compact);
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
  initializeIndex(startDir ?? resolveRoot().startDir);

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
