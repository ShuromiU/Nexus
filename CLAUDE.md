# Nexus — Codebase Index & Query Tool

Tree-sitter AST parser + SQLite index. Parses symbols, imports, exports, occurrences from source files. Exposes queries via CLI (`nexus`) and MCP server (`nexus serve`).

## Commands
- `npm run build` — TypeScript compile (must pass before any work is done)
- `npm run test` — Vitest suite (~2s)
- `npm run dev` — Watch mode compile
- `npm run lint` — Type-check only (`tsc --noEmit`)
- `nexus install [--dry-run] [--project] [--mcp] [--bake-root]` — register hooks (PreToolUse, PostToolUse, SessionStart) + optionally `.mcp.json` with **absolute paths** in `~/.claude/settings.json`. JSONC-preserving via `jsonc-parser`. Idempotent.
- `nexus uninstall [--dry-run] [--project]` — remove only Nexus-owned hook entries.
- `nexus doctor [--json]` — diagnose workspace mode, index health, MCP wiring, hook installation, telemetry.

## Worktrees (Claude Desktop integration)

Claude Desktop's worktree feature lands at `<project>/.claude/worktrees/<name>/`. Three platform constraints shape the design:
- MCP `cwd` field in `.mcp.json` is **ignored** ([anthropics/claude-code#17565](https://github.com/anthropics/claude-code/issues/17565), closed not-planned). Defense: `nexus install` writes absolute paths and `nexus serve` falls back through `--root` → `NEXUS_ROOT` → `CLAUDE_PROJECT_DIR` → MCP roots → cwd.
- `WorktreeCreate`/`WorktreeRemove` hooks **don't fire in Desktop** ([#29716](https://github.com/anthropics/claude-code/issues/29716)). Only `SessionStart` does — that's our bootstrap lever.
- In a worktree, `.git` is a *file* (gitdir pointer), not a directory.

**Two independent concepts:** `WorkspaceMode = standalone | main | worktree` (filesystem) vs `IndexMode = full | overlay-on-parent | worktree-isolated` (effective query strategy). Both reported by `nexus doctor`.

**Hybrid overlay** is used in worktrees only when **all** compat gates pass; otherwise we fall back to a full per-worktree index (`worktree-isolated`) and stamp `meta.degraded_reason`. Coverage is never silently partial. Gates:
- Parent `meta.clean_at_index_time === true` (computed before any `.nexus/` writes; only `.nexus/` excluded — `.nexus.json`/`.nexusignore` count).
- Parent `meta.git_head` is set and `git merge-base --is-ancestor parent_git_head HEAD` succeeds in the worktree.
- Parent `SCHEMA_VERSION`/`EXTRACTOR_VERSION` match current.
- No tracked or untracked changes to `.nexus.json`, `.nexusignore`, `.gitignore`, `package.json`, root `tsconfig.json`.
- Change-set size ≤ `MAX_OVERLAY_FILES` (default 500). The change set unions four diff sources: committed (`<base>...HEAD`), staged (`--cached`), unstaged, and untracked (`ls-files --others --exclude-standard`).

**Overlay storage** ([src/db/overlay.ts](src/db/overlay.ts)): a small SQLite file at `<worktree>/.nexus/overlay.db` containing only changed/added/deleted files. Schema mirrors the parent except `module_edges.resolved_file_id` is replaced by `resolved_path` + `resolved_path_key`, and `relation_edges.target_id` is replaced by `target_path_key` + `target_name` (cross-boundary FKs are paths, resolved at query time). Cross-file overlay→parent relations are pre-resolved at overlay build time by [src/index/overlay-orchestrator.ts](src/index/overlay-orchestrator.ts) `resolvePendingRelations`, which reads parent path_keys and reuses the orchestrator's `resolveModulePath` trial-extension logic.

**Query merge** ([src/db/store.ts](src/db/store.ts) `attachOverlay`): on attach, we `ATTACH DATABASE` the overlay, build temp lookup tables (`overlay_path_index`, `changed_or_deleted`), and create TEMP VIEWS named `files`/`symbols`/`module_edges`/`occurrences`/`relation_edges`/`meta`/`index_runs` that **shadow** the unqualified table names. Direct SQL like `engine.ts:562 'SELECT * FROM symbols'` resolves to the merged view automatically. Parent ids stay positive; overlay ids become negative. The `relation_edges` view redirects parent rows whose target file is now in the overlay (or deleted) to the overlay version, and resolves overlay-side `target_path_key` against either `overlay.symbols` or `main.symbols` depending on which side owns the path.

**Three bins** in `package.json`:
- `nexus` — full CLI (Commander, formatters, indexing). Human commands.
- `nexus-hook` (NEW) — slim hot-path bin at `dist/transports/hook-entry.js`. Static imports limited to `policy/dispatch-hook` + `workspace/detector`. QueryEngine + extractor adapters loaded via `await import(...)` only when a context-needing rule fires. Used by all hooks installed by `nexus install`.
- `nexus-policy-check` — back-compat bin; shares `runPolicyHook` with `nexus-hook`.

**Known v1 limitation:** parent's stored `module_edges.symbol_id` references the parent's symbols table. If a now-modified overlay file renamed the bound symbol, callers/importers queries crossing that boundary may show best-effort results. File-level resolution is correct; symbol-level cross-boundary is best-effort.

## Architecture

```
src/
  workspace/       — File discovery, ignore rules, change detection, file-kind classification
  analysis/        — Tree-sitter parsing + per-language symbol extractors
    languages/     — Adapters: typescript, python, go, rust, java, csharp, css
    documents/     — Structured-file parsers + fs-aware loaders (size caps + LRU cache). Consumed by A3.
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

**Core / discovery:** `nexus_find`, `nexus_refs`, `nexus_search`, `nexus_grep`, `nexus_exports`, `nexus_imports`, `nexus_importers`, `nexus_symbols`, `nexus_tree`, `nexus_stats` (with optional `session: true` for D4 budget accountant), `nexus_reindex`
- **`nexus_refs`** accepts `ref_kinds?: string[]` filter (TS/JS only) — e.g. `["call"]` to see only call sites, `["type-ref"]` for type usage. NULL ref_kind rows are returned only when the filter is absent.

**High-savings:** `nexus_outline`, `nexus_source`, `nexus_slice`, `nexus_deps`

**New token-savers:** `nexus_callers`, `nexus_pack`, `nexus_changed`, `nexus_diff_outline`, `nexus_signatures`, `nexus_definition_at`, `nexus_unused_exports`, `nexus_private_dead`, `nexus_tests_for`, `nexus_stale_docs`, `nexus_kind_index`, `nexus_doc`, `nexus_batch`

**Structured files (A3):** `nexus_structured_query`, `nexus_structured_outline`, `nexus_lockfile_deps`

**Relation intelligence (B2 v1/v2):** `nexus_relations` (TS/JS/Java/C# with `extends_class`, `implements`, `extends_interface`, `overrides_method`)

**Composed workflows (B6, D2):** `nexus_rename_safety`, `nexus_refactor_preview`, `nexus_clarify`

**Budget accountant (D4):** `nexus_stats { session: true, recent_limit?: number }` returns a per-process ring buffer of recent `pack()` calls plus a summary block (`pack_runs`, `total_tokens_used`, `total_budget_allocated`, `hit_budget_count`, `avg_utilization`, `total_timing_ms`). The ledger is in-memory — MCP servers (long-lived) accumulate across calls; CLI runs (one-shot) report a single-call session. Capacity defaults to 50 entries; oldest are overwritten. Source: [src/query/budget-ledger.ts](src/query/budget-ledger.ts) (pure, exported for unit testing).

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
- **`nexus_private_dead(path?, limit?, kinds?)`** — Sister tool to `nexus_unused_exports` (B4). Finds *private* dead code: top-level symbols that are NOT exported and have zero in-file references beyond the declaration line. Default `kinds`: `function`, `class`, `interface`, `type`, `enum`, `constant`, `variable`, `hook`, `component`. Skips files containing `export *` (would let any symbol escape — analysis would be unsound). Heuristic: an occurrence on the symbol's declaration line is treated as the declaration itself; any occurrence on a different line counts as a use. Cross-file occurrences are ignored — a non-exported symbol cannot be referenced from another file by import. Source: [src/query/engine.ts](src/query/engine.ts) `privateDeadCode` + [src/db/store.ts](src/db/store.ts) `getNonExportedTopLevelSymbols`.
- **`nexus_stale_docs(path?, kinds?, limit?)`** — Stale-doc detection (B3 v1). Flags functions/methods/hooks/components whose JSDoc `@param` tags don't agree with the actual signature. Each result carries an `issues[]` of `{ kind: 'unknown_param' | 'undocumented_param', detail: <param-name> }`. Only flags symbols that have *some* `@param` tags (fully undocumented things are out of scope; that's `nexus_unused_exports` / human review territory). Pure post-hoc analysis: reuses the extractor's already-stored `doc` and `signature` columns — no schema bump. Composes [src/query/stale-docs.ts](src/query/stale-docs.ts) `diffDocAgainstSignature` (pure, exported for unit testing) + [src/db/store.ts](src/db/store.ts) `getDocumentedSymbols`. Default `kinds`: `function`, `method`, `hook`, `component`.
- **`nexus_tests_for(name?, file?, limit?)`** — Test-to-source linkage (B5 v1). Given a source symbol `name` or `file`, returns test files that import it. Computed at query time from existing import edges plus a path-based test classifier — no schema bump. Each row carries `confidence: 'declared' | 'derived'`: `declared` = filename matches `*.test.*`/`*.spec.*` or sits under a `__tests__/` ancestor (universal Jest/Vitest/Mocha convention); `derived` = file lives under a top-level `tests/` or `test/` directory but lacks the filename pattern (Vitest convention; weaker because helpers/fixtures live there too). Non-test importers are filtered out. Source: [src/query/engine.ts](src/query/engine.ts) `testsFor` + [src/workspace/classify.ts](src/workspace/classify.ts) `classifyTestPath`.
- **`nexus_kind_index(kind, path?, limit?)`** — Every symbol of a given kind (`interface`, `class`, `component`, `hook`, …) under an optional path prefix. Replaces grep/search chains for "show me every X in this folder".

### Composed Workflow Tools (B6, D2)
- **`nexus_rename_safety(name, file?, new_name?)`** — Composed risk verdict for renaming a symbol. Aggregates B1 ref_kinds + importers + B2 relations + collision detection (when `new_name` is supplied) and emits `risk: 'low'|'medium'|'high'` with machine-readable `reasons[]` and a numeric `blast_radius`. **Risk model:** `high` when there are children edges (subclasses break) OR ≥1 importer (cross-module surface) OR `new_name` collides in the same module; `medium` when there are local callers/type-refs/parents/same-file collisions; `low` otherwise. Use before renaming an exported symbol — replaces chains of `nexus_callers` + `nexus_importers` + `nexus_relations`. Source: [src/query/engine.ts](src/query/engine.ts) `renameSafety` + `classifyRenameRisk` (pure, exported for unit testing).
- **`nexus_refactor_preview(name, file?, new_name?)`** — Dry-run rename preview (B6 v2). Returns every concrete edit site grouped by file (definition + callers + importers + subclasses + implementers + method overrides) with `line`/`col`/`role`/`context`/`ref_kind?`, plus the same risk verdict as `nexus_rename_safety` (no double work). `role` is one of `'definition' | 'caller' | 'importer' | 'subclass' | 'implementer' | 'override'`. Files are returned alphabetically; edits within a file are sorted by `(line, col)` for deterministic preview output. Use to plan a rename without performing it — e.g. to render a "what will change?" panel or to estimate effort before committing. Composes existing store queries (no new SQL). Source: [src/query/engine.ts](src/query/engine.ts) `refactorPreview`.
- **`nexus_clarify(name)`** — Disambiguate an ambiguous name (D2). Returns every definition with file + line + kind + scope + signature + `is_export` + `importer_count` + `relation_summary`, plus heuristic `suggested_picks` ranked by usage and structural prominence ("most-used" by importer_count, "base type for the hierarchy" by children edges). Use when `nexus_find` returns multiple results and you need to pick the right one without reading every candidate file. Composes existing store helpers (no new SQL).

### Relation Intelligence (B2 v1 / v2)
- **`nexus_relations(name, direction?, kind?, depth?, limit?)`** — Declared structural relationships: `extends_class`, `implements`, `extends_interface`, `overrides_method`. `direction: 'parents'` (default) answers "what does X extend/implement/override?", `'children'` answers "who extends/implements/overrides X?", `'both'` unions. `kind` filters to one edge kind. `depth` 1-5 (cycle-safe). Cross-file targets resolve through the importer's resolved imports + the target file's top-level type declarations; unresolved targets (external modules, mixins, dynamic) carry `target.resolved: false`. **Worktree parity (T12):** in worktree-overlay sessions, relations crossing the overlay→parent boundary resolve correctly — overlay rows store `target_path_key` resolved against the merged overlay+parent file set at build time, and the `relation_edges` TEMP view redirects parent rows whose target now lives in the overlay (or was deleted). Source: [src/db/schema.ts](src/db/schema.ts) `relation_edges` table; storage: [src/db/store.ts](src/db/store.ts) joined query helpers + merged TEMP view; overlay schema: [src/db/overlay.ts](src/db/overlay.ts); overlay resolver: [src/index/overlay-orchestrator.ts](src/index/overlay-orchestrator.ts) `resolvePendingRelations`; extractor: [src/analysis/languages/typescript.ts](src/analysis/languages/typescript.ts) `extractRelationEdges`.

  **Language coverage:**
  - **TypeScript** (v1): all four kinds (`extends_class`, `implements`, `extends_interface`, `overrides_method`).
  - **JavaScript** (v1.5 + v2): runtime-only kinds — `extends_class`, `overrides_method`. `implements` / `extends_interface` are TS-syntax-only.
  - **Java** (v2): `extends_class`, `implements`, `extends_interface`. Generic type parameters are stripped (`Base<T>` → `Base`). **Same-file resolution only** — Java imports use package paths (`com.example.Foo`), which the v2 import resolver does not yet map to files; cross-package targets carry `target.resolved: false`.
  - **C#** (v2): `extends_class`, `implements`, `extends_interface`. C# uses a single `: Base, IFoo` syntax for both extension and implementation; the extractor uses the canonical `IPascal` interface naming convention to classify the first base entry — a class named `Identity` with no other heritage would be misclassified as an interface (best-effort, false-positive < false-negative). Same-file resolution only (`using` directives are package-level like Java).

  **`overrides_method` (B2 v2):** when a class extends another class, every method in the body emits one `overrides_method` edge per parent class. `target_name` encodes the compound key `ParentClass.methodName`; `target.resolved` is `true` only when both the parent class and a same-named method are found. Constructors (`constructor`) and private methods (`#x`) are skipped. Cross-file resolution honors `import { Foo as Bar }` aliasing.

  **Known gaps:** structural-typing edges (object literal `LanguageAdapter` shapes implementing the interface implicitly) are not captured — declared `class X implements I` only. Java/C# cross-package resolution and TypeScript namespace-qualified imports remain v3 work.
- **`nexus_doc(name, file?)`** — Just the docstring(s). Tiny but hot path — avoids reading source bodies when you only need the comment block.
- **`nexus_batch(calls[])`** — Run several Nexus tools in a single MCP roundtrip. `calls` is an array of `{tool, args}`. Saves protocol/envelope overhead when you already know you need N related queries. Each sub-call's `args` may include its own `compact:true`; the top-level `compact:true` applies to all sub-results.

### Structured File Tools (A3)
- **`nexus_structured_query(file, path)`** — Extract one value from a structured config file (package.json, tsconfig, Cargo.toml, GHA workflow, generic JSON/YAML/TOML) by dotted path. Numeric segments index arrays: `jobs.test.steps.0.run`. Returns `{ found, value, ... }`. Errors surface with `error`; oversized files return `error: 'file_too_large'` with `limit`/`actual`.
- **`nexus_structured_outline(file)`** — Shallow top-level view of a structured config file: each entry has `key`, `value_kind`, short `preview` for scalars, `length` for arrays. No line anchors in V3.
- **`nexus_lockfile_deps(file, name?)`** — List `{name, version}` entries from a lockfile. Supported: `yarn.lock`, `package-lock.json` (v1/v2/v3), `pnpm-lock.yaml` (v6+ and legacy keys, peer-dep suffixes stripped), `Cargo.lock`. Optional `name` filters to all versions of one package. Over-cap → `error: 'file_too_large'` with 20 MB limit.

**Policy transport:** `nexus_policy_check` — evaluate a Claude Code hook event against the Nexus policy layer. Dedicated `nexus-policy-check` bin for the PreToolUse hot path (no CLI spin-up, no reindex). Every response carries `stale_hint`. See `src/policy/` for rules.

Shipped rules:
- `grep-on-code` — denies `Grep` on code paths; allows `Grep` on docs/lockfiles/node_modules.
- `read-on-structured` — asks before `Read` on structured configs and lockfiles; suggests `nexus_structured_query`/`nexus_structured_outline` or `nexus_lockfile_deps`.
- `read-on-source` — allows bare `Read` on indexed source files but adds `additionalContext` nudging `nexus_outline`/`nexus_source`.
- `preedit-impact` — on `Edit`/`Write` events against an exported top-level symbol of an indexed source file with ≥1 known importer, emits `allow + additionalContext` summarizing importer count, caller count, and risk (`low`/`medium`/`high`). **B6 v1.5:** when the engine exposes `renameSafety`, the verdict comes from the composed classifier (subclasses/implementers force `high` independently of caller count); otherwise it falls back to the legacy `bucketRisk(callerCount)`. The advisory now points at `nexus_rename_safety` for the full breakdown. Never blocks. Falls open when the DB is unavailable.
- `evidence-summary` — on `Bash` PreToolUse events whose command matches `git commit|push|gh pr create`, emits `allow + additionalContext` summarizing affected callers, new unused exports, `tests_run_this_session`, and risk. Never blocks. Falls open when no changed file is indexed.
- `test-tracker` — on `Bash` PostToolUse events matching a test allow-list with `exit_code: 0`, records the run to `.nexus/session-state.json` keyed on `session_id`. Read by `evidence-summary`.

The PostToolUse hook is installed separately as `hooks/nexus-post.sh` with matcher `"Bash"`; the PreToolUse install matcher widens to `"Grep|Glob|Agent|Read|Edit|Write|Bash"`.

**Telemetry (D5):** every policy event is recorded to `.nexus/telemetry.db` (decision, rule, latency_us, session_id, canonical input_hash). Disabled via `NEXUS_TELEMETRY=0|false` (env, highest priority) or `.nexus.json {"telemetry": false}`; opt-in/opt-out transitions are themselves logged. Retention: 30 days OR 100k rows, pruned at startup (24h gate). CLI: `nexus telemetry stats|analyze|export|purge`. No MCP tool in v1; no network I/O ever.

**V4 metrics gate** ([src/policy/metrics-gate.ts](src/policy/metrics-gate.ts)): `nexus telemetry analyze [--since 30d] [--json] [--strict]` evaluates the V3-roadmap thresholds (p50 ≤ 50ms, p95 ≤ 150ms, override_rate ≤ 10%, min 30 events/rule) per rule and emits an overall `pass | warn | fail | insufficient_data` verdict. Exits non-zero on `fail` (or `warn` under `--strict`) so it's CI-friendly. Latency breaches downgrade to `warn` only — override-rate breaches `fail` because the roadmap blocks V4 promotion on FP signal, not raw latency. Threshold flags: `--p50-us`, `--p95-us`, `--override-rate`, `--min-events`.

**D1 gate — pack-utilization analyzer** ([src/policy/pack-metrics-gate.ts](src/policy/pack-metrics-gate.ts)): `nexus telemetry analyze --pack [--since 30d] [--json] [--strict]` reads the `pack_runs` table (populated automatically by every `nexus_pack` call via the MCP server and CLI) and emits a verdict on whether D1 (`nexus_next`) is justified. Verdicts use the same `pass | warn | fail | insufficient_data` vocabulary but with **inverted intent vs. the policy gate** — here `fail` means "pack is failing, so D1 is justified". Defaults: hit_budget warn ≥ 20% / fail ≥ 40%, avg_util warn ≥ 85% / fail ≥ 90%, min 30 runs. Threshold flags: `--hit-budget-warn`, `--hit-budget-fail`, `--avg-util-warn`, `--avg-util-fail`, `--min-runs`. The `pack_runs` table is added to `.nexus/telemetry.db` on next open via `CREATE TABLE IF NOT EXISTS` — no schema-version bump, no migration. Recording honours the existing `NEXUS_TELEMETRY=0|false` opt-out.
