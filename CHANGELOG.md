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
