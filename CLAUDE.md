# Nexus — Codebase Index & Query Tool

Tree-sitter AST parser + SQLite index. Parses symbols, imports, exports, occurrences from source files. Exposes queries via CLI (`nexus`) and MCP server (`nexus serve`).

## Commands
- `npm run build` — TypeScript compile (must pass before any work is done)
- `npm run test` — Vitest suite (~2s)
- `npm run dev` — Watch mode compile
- `npm run lint` — Type-check only (`tsc --noEmit`)

## Architecture

```
src/
  workspace/       — File discovery, ignore rules, change detection
  analysis/        — Tree-sitter parsing + per-language symbol extractors
    languages/     — Adapters: typescript, python, go, rust, java, csharp, css
    registry.ts    — Adapter registration (side-effect imports in entry points)
  db/              — SQLite schema, store (all DB ops), integrity checks
  index/           — Two-phase orchestrator (scan+parse → atomic publish), lock
  query/           — QueryEngine (all query methods), fuzzy ranking
  transports/      — CLI (commander) and MCP server (stdio)
  index.ts         — Public API re-exports
```

## Key Patterns

**Data flow:** Files on disk → scanner → change detector → tree-sitter → language extractor → memory buffer → atomic SQLite transaction → query engine → CLI/MCP output

**Two-phase indexing:** Phase 1 scans+parses with no DB lock. Phase 2 publishes in a short atomic transaction. Readers never see partial state.

**QueryEngine methods** all follow: start timer → query store → map to result type → wrap in `NexusResult<T>` envelope. Add new queries by following this pattern.

**MCP tools** are defined in `transports/mcp.ts`: tool schema in `ListToolsRequestSchema` handler, execution in `CallToolRequestSchema` switch. Each tool delegates to a QueryEngine method.

**CLI commands** mirror MCP tools with formatters. Not all tools need both — `nexus_symbols` and `nexus_reindex` are MCP-only; `repair` and `rebuild` are CLI-only.

**Language adapters** register via side-effect imports. Each adapter declares capabilities and maps tree-sitter node types to Nexus symbol kinds. Add new languages by copying an existing adapter and registering it.

## Database

SQLite with WAL mode. Tables: `files`, `symbols`, `module_edges`, `occurrences`, `meta`, `index_runs`, `index_lock`. All child rows CASCADE on file delete. Schema versioned — bumping `SCHEMA_VERSION` or `EXTRACTOR_VERSION` in `db/schema.ts` triggers full rebuild.

## Adding a New Query Tool

1. Add store method in `db/store.ts` (SQL query, typed return)
2. Add result interface + method in `query/engine.ts`
3. Add tool definition + handler in `transports/mcp.ts`
4. Add CLI command + formatter in `transports/cli.ts`
5. Export types from `index.ts`
6. Add tests in `tests/query.test.ts`

## Testing

Tests use in-memory SQLite (`:memory:`) with `createTestDb()` + `seedTestData()` helpers. Methods that read from disk (`grep()`, `source()`, `outline()` line count) need temp files with `root_path` meta pointing to the temp directory.

## Conventions
- Strict TypeScript, no `any`
- POSIX paths internally (forward slashes), Windows paths normalized on input
- Optional result fields omitted (not null) via spread: `...(row.doc ? { doc: row.doc } : {})`
- Prepared statements for all SQL — never string interpolation
- Errors caught per-file during indexing — one bad file doesn't break the index

## Supported Languages
TypeScript/JavaScript (.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs), Python, Go, Rust, Java, C#, CSS

## MCP Tools
`nexus_find`, `nexus_refs`, `nexus_search`, `nexus_grep`, `nexus_exports`, `nexus_imports`, `nexus_importers`, `nexus_symbols`, `nexus_tree`, `nexus_stats`, `nexus_reindex`, `nexus_outline`, `nexus_source`, `nexus_slice`, `nexus_deps`

### High-Token-Savings Tools
- **`nexus_outline(file)`** — Structural summary: nested symbol tree with signatures + line ranges, import summary, export list. Replaces reading a file to understand its structure (~98% token savings). `file` accepts a single path or an array of paths (via `outlineMany`).
- **`nexus_source(name, file?)`** — Extract just one symbol's source code by name. Avoids reading the full file (~95% savings). Optional file filter for disambiguation.
- **`nexus_slice(name, file?, limit?)`** — Returns a symbol's source plus the source of any named symbols it references in its body. Name-based approximation — good when you want a function and its direct dependencies in one call.
- **`nexus_deps(file, direction?, depth?)`** — Transitive dependency tree in one call. `direction: 'imports'` (default) or `'importers'`. Depth 1-5 (default 2). Replaces chaining N import/importer calls.
- **`nexus_search(query, limit?, kind?, path?)`** — Fuzzy symbol search; optional `path` prefix narrows results to a subtree of the repo.
