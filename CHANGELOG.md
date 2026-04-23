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
