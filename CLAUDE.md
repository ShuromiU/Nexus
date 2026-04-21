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
  workspace/       — File discovery, ignore rules, change detection, file-kind classification
  analysis/        — Tree-sitter parsing + per-language symbol extractors
    languages/     — Adapters: typescript, python, go, rust, java, csharp, css
    documents/     — Structured-file parsers: package.json, tsconfig, Cargo.toml, GHA YAML, lockfiles (consumed by A3 tools)
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

**Core / discovery:** `nexus_find`, `nexus_refs`, `nexus_search`, `nexus_grep`, `nexus_exports`, `nexus_imports`, `nexus_importers`, `nexus_symbols`, `nexus_tree`, `nexus_stats`, `nexus_reindex`
- **`nexus_refs`** accepts `ref_kinds?: string[]` filter (TS/JS only) — e.g. `["call"]` to see only call sites, `["type-ref"]` for type usage. NULL ref_kind rows are returned only when the filter is absent.

**High-savings:** `nexus_outline`, `nexus_source`, `nexus_slice`, `nexus_deps`

**New token-savers:** `nexus_callers`, `nexus_pack`, `nexus_changed`, `nexus_diff_outline`, `nexus_signatures`, `nexus_definition_at`, `nexus_unused_exports`, `nexus_kind_index`, `nexus_doc`, `nexus_batch`

Every tool accepts an optional `compact: true` flag that returns a minimal-key envelope (~50% smaller payload) — drops `query`/`timing_ms`/`index_status` and renames result keys to single letters.

### High-Token-Savings Tools
- **`nexus_outline(file)`** — Structural summary: nested symbol tree with signatures + line ranges, import summary, export list. Replaces reading a file to understand its structure (~98% token savings). `file` accepts a single path or an array of paths (via `outlineMany`).
- **`nexus_source(name, file?)`** — Extract just one symbol's source code by name. Avoids reading the full file (~95% savings). Optional file filter for disambiguation.
- **`nexus_slice(name, file?, limit?)`** — Returns a symbol's source plus the source of any named symbols it references in its body. Name-based approximation — good when you want a function and its direct dependencies in one call.
  Supports `ref_kinds?: string[]` filter (TS/JS only) for call/read/write/type-ref/declaration precision.
- **`nexus_deps(file, direction?, depth?)`** — Transitive dependency tree in one call. `direction: 'imports'` (default) or `'importers'`. Depth 1-5 (default 2). Replaces chaining N import/importer calls.
- **`nexus_search(query, limit?, kind?, path?)`** — Fuzzy symbol search; optional `path` prefix narrows results to a subtree of the repo.

### New Token-Saver Tools
- **`nexus_callers(name, file?, depth?, limit?)`** — Inverse of `slice`: every function/class that calls this symbol, grouped by caller with one snippet per call site. `depth` (1-3) recurses upward through the call graph. Use for "what breaks if I change X?" analysis (replaces `refs` → for-each `outline` chains).
  Supports `ref_kinds?: string[]` filter (TS/JS only) for call/read/write/type-ref/declaration precision.
- **`nexus_pack(query, budget_tokens?, paths?)`** — Token-budget-aware context bundler. Given a question, assembles outlines + selected sources up to a budget. Phases: ranked-file outlines → top-symbol sources → directly-imported outlines. Replaces guessing what to feed an LLM. Default budget 4000 tokens.
- **`nexus_changed(ref?)`** — Files changed since a git ref (default `HEAD~1`) with their current outlines. Falls back to mtime-since-last-index when git is unavailable. PR/branch review without reading the diff.
- **`nexus_diff_outline(ref_a, ref_b?)`** — Semantic diff: which symbols were added/removed/modified between two git refs. Re-parses historical content via `git show` — does not require an updated index. ~90% smaller than textual diff for code review.
- **`nexus_signatures(names[], file?, kind?)`** — Batch signature lookup: name + signature + doc summary, no body. Use when comparing siblings or auditing an interface (replaces N `find` + `source` chains).
- **`nexus_definition_at(file, line, col?)`** — LSP-style go-to-definition. Resolves the identifier at a position to its definition source. Best-effort heuristic; column-precise when given.
- **`nexus_unused_exports(path?, limit?)`** — Dead-code finder. Exports with no importers and no external occurrences. Note: re-exports through index.ts may appear unused; use `path` to scope.
  Supports `mode: 'default' | 'runtime_only'`. Default behavior unchanged; `runtime_only` excludes type-only imports and type-ref occurrences (TS/JS only).
- **`nexus_kind_index(kind, path?, limit?)`** — Every symbol of a given kind (`interface`, `class`, `component`, `hook`, …) under an optional path prefix. Replaces grep/search chains for "show me every X in this folder".
- **`nexus_doc(name, file?)`** — Just the docstring(s). Tiny but hot path — avoids reading source bodies when you only need the comment block.
- **`nexus_batch(calls[])`** — Run several Nexus tools in a single MCP roundtrip. `calls` is an array of `{tool, args}`. Saves protocol/envelope overhead when you already know you need N related queries. Each sub-call's `args` may include its own `compact:true`; the top-level `compact:true` applies to all sub-results.
