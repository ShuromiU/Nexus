## [Unreleased] — D5 v1 telemetry

### Added
- **`.nexus/telemetry.db`** — append-only SQLite store separate from `index.db`. Records every policy event with `rule`, `decision`, `latency_us`, `session_id`, and a canonical `tool_input` hash. Schema versioned at `1`; corrupt files are quarantined and recreated.
- **Override correlation.** PreToolUse `ask` rows joined to PostToolUse rows on `(session_id, input_hash)` within a 5-minute window — feeds the V4 metrics-gate "override rate" signal.
- **Dispatcher instrumentation.** Per-rule timing in microseconds; `try/catch` wraps each `rule.evaluate` so a thrown rule cannot break dispatch. A single `noop` row is recorded when no rule fires (so override joins detect pass-through actions).
- **Opt-out.** `NEXUS_TELEMETRY=0|false` env var (highest priority) or `.nexus.json {"telemetry": false}`. Default: enabled. Transitions are themselves recorded as `opt_out` / `opt_in` rows, fulfilling V3's "explicit turn-it-off signal" requirement.
- **Retention.** 30 days OR 100,000 rows, whichever hits first. Pruned at policy-entry startup, gated to once per 24h via `meta.last_prune_ts`.
- **CLI surface.** `nexus telemetry stats|export|purge`:
  - `stats [--since=30d|7d|1h] [--json]` — decision counts, latency p50/p95/p99 per rule, override rate, opt-out transitions.
  - `export [--since] [--format=ndjson|csv]` — raw rows for offline analysis.
  - `purge --yes` — drops the DB; cleans up WAL/SHM siblings.
- `PolicyContext.telemetryDb?` and `PolicyContext.inputHash?` added; `DispatchOptions` widened to match.
- `NexusConfig.telemetry?: boolean` field.

### Notes
- No MCP tool in v1 (CLI sufficient for the V3→V4 gate review).
- No remote upload, ever. Everything stays in `.nexus/telemetry.db`.
- Hot-path overhead: one prepared INSERT per fired rule (~10-20µs); below the 150ms p95 latency target.
- Closes the V3 metrics-gate prerequisite.

---

## [Unreleased] — D3 v1 evidence summary (warning-first)

### Added
- **`evidence-summary` policy rule** — PreToolUse `Bash` events whose command matches `git commit`, `git push`, or `gh pr create` get an informational `additional_context` summary. Payload includes `tests_run_this_session`, `affected_callers` (top-level exports of the change set with caller counts + ≤3 sample sites each), `new_unused_exports`, `caller_risk` (`low|medium|high` from C1's `bucketRisk`), and `evidence_ok` (heuristic: tests_run AND risk ≠ high AND no new unused). Never blocks. Falls open when the DB is unavailable, no changed file is indexed, no exported top-level symbol is in the change set, or git is missing.
- **`test-tracker` policy rule** — PostToolUse `Bash` events whose command matches a configured allow-list (`npm test`, `pnpm test`, `yarn test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `nexus test`, …) and whose `tool_response.exit_code` is `0` are recorded to `.nexus/session-state.json`, keyed on `session_id`. Cross-session entries are isolated (file rewritten fresh on session change). FIFO-capped at 256 entries.
- **`hooks/nexus-post.sh`** — PostToolUse dispatcher for `Bash`. Pipes the event to `nexus-policy-check` and discards stdout. Install matcher: `"Bash"`.
- `hooks/nexus-first.sh` now handles `Bash` PreToolUse — install matcher updated to `"Grep|Glob|Agent|Read|Edit|Write|Bash"`.
- `PolicyEvent.tool_response?: Record<string, unknown>` — present on PostToolUse only; consumed by `test-tracker`.
- `QueryEngineLike` widens to add `unusedExports` plus a richer `callers` callsite shape so D3 can read sample-site `caller.file` / `call_sites[].line`.
- `nexus_policy_check` MCP schema declares `tool_response` and `session_id` on the event payload (the dispatch handler already passed them through).

### Notes
- Never hard-denies. Worst case is silent allow.
- `additional_context` capped at 1200 chars; `affected_callers` and `new_unused_exports` each capped at 10 entries with `…+N more` suffixes.
- Test-command allow-list is hard-coded in V3 — `.nexus.json` `testCommands` overrides land with the V4 long-lived policy worker (resolving config per event would dominate the latency budget).
- Closes V3 Tier 1.

---

## [Unreleased] — C1 preedit-impact (warning-first)

### Added
- **`preedit-impact` policy rule** — `Edit` or `Write` on an exported top-level symbol of an indexed source file with ≥1 known importer returns `permissionDecision: allow` with `additionalContext` summarizing the impact: symbol name (Edit) or top-3 symbols by callers (Write), importer count, caller count, and bucketed risk (`low` / `medium` / `high`; thresholds 0-2 / 3-10 / 11+). Never blocks. Falls open when the DB is unavailable.
- **`QueryEngineLike` abstraction** on `PolicyContext` — minimal surface (`importers`, `outline`, `callers`) so rules that need DB access can be tested without a real database. Exported from `src/policy/index.ts` alongside `OutlineForImpact` / `OutlineEntryForImpact`.
- **`DispatchOptions.queryEngine?`** — `dispatchPolicy` forwards the engine into `ctx` so DB-aware rules can reach it.
- `nexus-policy-check` bin opens a readonly `QueryEngine` at startup; MCP `executePolicyCheck` forwards the already-existing server-side engine.
- `hooks/nexus-first.sh` now handles `Edit` and `Write` events — install instructions updated to `"matcher": "Grep|Glob|Agent|Read|Edit|Write"`.

### Notes
- Never hard-denies. Worst case is silent allow.
- Rule triggers: Edit must map to a top-level exported symbol via `findSymbolAtEdit`; Write must target an existing file with ≥1 importer and ≥1 top-level export. New-file Writes and non-exported edits skip silently.
- `additional_context` capped at 600 chars; overflow truncated with `…`.
- Engine construction adds ~70-100 ms cold-start on the bin hot path (eager tree-sitter grammar load via `QueryEngine` → `parser.ts`). Deferred to a follow-up (split `QueryEngine` DB-only surface, or lazy grammar loading).

---

## [Unreleased] — A5/C2 read-redirect (warning-first)

### Added
- **`read-on-structured` policy rule** — `Read` on a structured config file (`package.json`, `tsconfig.json`, `Cargo.toml`, GHA workflow YAML, generic JSON/YAML/TOML) returns `permissionDecision: ask` with a suggestion to use `nexus_structured_query` or `nexus_structured_outline`. Lockfiles (`yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`) suggest `nexus_lockfile_deps`.
- **`read-on-source` policy rule** — `Read` on an indexed source file with neither `offset` nor `limit` returns `permissionDecision: allow` with `additionalContext` nudging toward `nexus_outline` / `nexus_source`. Paging (`offset` or `limit` present) skips the rule.
- **`additional_context?: string` field** on `PolicyDecision` and `PolicyResponse`. Dispatcher forwards it on `allow`/`ask` and drops it on `deny`/`noop`.
- `hooks/nexus-first.sh` now handles `Read` events — install instructions updated to `"matcher": "Grep|Glob|Agent|Read"`.

### Notes
- Never hard-denies `Read`. Worst case is silent allow.
- No DB access on the hot path — rules rely on `classifyPath()` plus existing `stale_hint`.
- `.nexus.json` language overrides are intentionally not loaded on the hot path (resolving config would cost disk I/O per event). Custom extensions won't trigger the source rule until V4 adds a long-lived policy worker.

---

## [Unreleased] — A3 P2 lockfile_deps

### Added
- `nexus_lockfile_deps(file, name?)` — list `{name, version}` entries from a lockfile. Supported: `yarn.lock`, `package-lock.json` (lockfileVersion 1/2/3), `pnpm-lock.yaml` (v6+ and legacy v5 keys, peer-dep suffixes stripped), `Cargo.lock`. Optional `name` filters to matching entries (multiple versions preserved).
- CLI: `nexus lockfile-deps <file> [name]`.
- Parsers: `parsePackageLock`, `parsePnpmLock`, `parseCargoLock` (plus existing `parseYarnLock`).
- Loaders: `loadPackageLock`, `loadPnpmLock`, `loadCargoLock` — each enforces a 20 MB size cap per the V3 spec. Reuse the A2 LRU cache.
- Public re-exports: `LockfileDepsResult`, `Parsed{PackageLock,PnpmLock,CargoLock}`.
- Compact-mode key: `version → ve`.

### Notes
- Query-time only. Lockfile data is not indexed.
- No transitive graph or dedupe — entries are the raw `{name, version}` pairs from the lockfile.
- Parse errors surface as `{ error, ... }` on the single result; `file_too_large` includes `limit` and `actual` bytes.
- Supported lockfile kinds derived from `classifyPath()` exact-basename rules; other lockfiles (Gemfile.lock, go.sum, poetry.lock, …) deferred.
- `pnpm-lock.yaml` key parser handles git-URL versions correctly (first `@` wins, not last) — real pnpm output for git deps works without corruption.

---

## [Unreleased] — structured document MCP tools (A3 P0+P1)

### Added
- `nexus_structured_query(file, path)` — extract a single value from a structured config file. Dotted path syntax; numeric segments index arrays. Supported kinds: `package.json`, `tsconfig*.json`, `Cargo.toml`, GHA workflows (P0), generic JSON/YAML/TOML (P1).
- `nexus_structured_outline(file)` — list top-level keys with value kinds (string / number / boolean / null / array / object), short previews for scalars, array lengths for arrays. Same supported kinds as `structured_query`.
- CLI: `nexus structured-query <file> <path>` and `nexus structured-outline <file>`.
- Public re-exports: `StructuredQueryResult`, `StructuredOutlineEntry`, `StructuredOutlineFileResult`, `StructuredValueKind`.
- **Policy transport** — new `nexus-policy-check` bin and `src/policy/` layer. PreToolUse hooks can consult Nexus policy without spawning the full CLI. Every response carries `stale_hint: boolean`; the entry does not reindex.
- **`nexus_policy_check` MCP tool** — hook-less fallback that evaluates policy against a Claude Code hook event. Does not trigger `ensureFresh()`.
- **First reference rule** — `grep-on-code`: ports the Grep allow-list from `hooks/nexus-first.sh` to TypeScript.

### Changed
- `hooks/nexus-first.sh` Grep branch now delegates to `nexus-policy-check`; Agent and Glob branches unchanged.

### Notes
- No line anchors — V3 defers anchor support until a location-preserving parser set is chosen.
- `nexus_lockfile_deps` (P2) deferred per the V3 spec's "may defer" clause.
- Structured file lookup is by exact path (relative to `root_path` or absolute). Structured files are not indexed; no fuzzy matching.
- Parse and fs errors surface as `{ error, ... }` on the single result; `file_too_large` errors include `limit` and `actual` bytes.
- Compact-mode keys added for the new shapes (`fd`, `v`, `es`, `ke`, `vk`, `pr`, `ln`, `lm`, `ac`).

---

## [Unreleased] — document cache + per-format size caps (A2)

### Added
- `src/analysis/documents/cache.ts` — `DocumentCache` LRU (64 entries / 8 MB), module singleton via `getDocumentCache()`. Keyed on `(absPath, mtimeMs, size)`; no content hashing on the fast path.
- `src/analysis/documents/loaders.ts` — `loadPackageJson`, `loadTsconfig`, `loadGenericJson`, `loadGhaWorkflow`, `loadGenericYaml`, `loadCargoToml`, `loadGenericToml`, `loadYarnLock`. Each enforces a per-format byte cap before parse; over-cap returns `{ error: 'file_too_large', limit, actual }`.
- Per-format size caps (`SIZE_CAPS`): 1 MB for `package.json` / `tsconfig.json` / `Cargo.toml` / GHA workflows; 5 MB for generic JSON/YAML/TOML; 20 MB for `yarn.lock`.

### Notes
- Pure infrastructure for A3. No new MCP tools, no CLI surface. Parsers themselves are unchanged.
- Parse errors are cached alongside successes — same malformed input yields the same error without re-parsing.

---

## [Unreleased] — classifyPath + document parsers (A1)

### Added
- `classifyPath()` + `FileKind` discriminated union in `src/workspace/classify.ts` — unified classification for source and structured files. Honors `.nexus.json` `languages` overrides. Precedence: exact basename → `tsconfig*.json` → `.github/workflows/*.{yml,yaml}` direct children → source extension (config override > default map) → generic extension → ignored.
- Document parser helpers under `src/analysis/documents/`: `parsePackageJson`, `parseTsconfig`, `parseGenericJson`, `parseGhaWorkflow`, `parseGenericYaml`, `parseCargoToml`, `parseGenericToml`, `parseYarnLock`. Each returns a narrow typed shape or `{ error }`; never throws. Consumed by A3's upcoming MCP tools.
- New runtime deps: `jsonc-parser` (tsconfig + generic JSONC), `yaml` (GHA workflows + generic YAML), `smol-toml` (Cargo.toml + generic TOML).

### Changed
- Scanner consumes `classifyPath()` instead of ad-hoc `path.extname` lookups. `ScanOptions.extraExtensions` replaced with `languages: Record<string, { extensions: string[] }>` — same shape as `config.languages`.
- `buildExtraExtensions()` removed — `classifyPath()` consumes `config.languages` directly.

### Notes
- Pure refactor plus groundwork. No new MCP tools (A3 owns those). No cache / size caps (A2 owns those). No indexed storage. Parsers sit unused in V3 Tier 1 until A3 lands.

---

## Previous Unreleased — ref_kind classification (B1)

### Added
- `ref_kind` column on `occurrences` — `call | read | write | type-ref | declaration` for TypeScript/JavaScript files, NULL for other languages.
- `LanguageCapabilities.refKinds` — per-language declaration of which kinds an adapter emits. Surfaced in `nexus_stats`.
- `ref_kinds?: string[]` filter on `nexus_callers`, `nexus_slice`, `nexus_refs`. NULL rows are returned only when the filter is absent.
- `nexus_unused_exports` gains `mode: 'default' | 'runtime_only'`. Default behavior unchanged; `runtime_only` excludes type-only imports and type-ref occurrences.

### Changed
- `SCHEMA_VERSION` bumped to 2 — existing indexes will be rebuilt on next run.
- `EXTRACTOR_VERSION` bumped to 3.

### Notes
- TypeScript/JavaScript precision (on the labeled fixture): call 100%, type-ref 100%, declaration 100%, write 100%.
- Other languages still emit NULL `ref_kind`. Consumers should use `nexus_stats` to check `languages[lang].capabilities.refKinds` before assuming repo-wide precision.
