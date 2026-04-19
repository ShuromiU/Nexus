## [Unreleased] — ref_kind classification (B1)

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
