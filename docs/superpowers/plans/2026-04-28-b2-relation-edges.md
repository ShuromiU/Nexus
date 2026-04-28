# B2 v1 Implementation Plan — Relation Edges (TS, declared)

**Spec:** [2026-04-28-b2-relation-edges-design.md](../specs/2026-04-28-b2-relation-edges-design.md)
**Approach:** TDD per the project pattern (`tests/*.test.ts` + `createTestDb()` / `seedTestData()` helpers). Each task lands as a separate commit. Build + vitest suite must stay green at every checkpoint.

## Tasks

### T1 — Schema + types
- Bump `SCHEMA_VERSION` from 2 → 3 in [src/db/schema.ts](../../../src/db/schema.ts).
- Add `relation_edges` table + 5 indexes to `TABLES` / `INDEXES`.
- Add `relation_edges` to the `DROP` list in `dropStaleTablesIfNeeded` so version bumps clear it.
- Add `RelationEdgeRow` to [src/db/store.ts](../../../src/db/store.ts).
- Test: `tests/relations-schema.test.ts` — open DB, verify table exists with expected columns, verify schema-version bump triggers full rebuild on existing DB.

### T2 — Capability + ExtractionResult shape
- Add `relationKinds: string[]` to `LanguageCapabilities` in [src/analysis/languages/registry.ts](../../../src/analysis/languages/registry.ts).
- Extend `ExtractionResult` with `relations: Omit<RelationEdgeRow, 'id' | 'file_id' | 'source_id' | 'target_id'>[]` — extractor produces by-name + a `source_symbol_index` field; orchestrator backfills ids.
- Update **all** existing adapters (typescript, python, go, rust, java, csharp, css) to add `relationKinds: []` and `relations: []` to extract output. Compile-only change for non-TS.
- Test: `tests/relations-capability.test.ts` — verify `getAllAdapters()` shape; non-TS adapters return empty `relations`.

### T3 — TS extractor: extends_class
- In [src/analysis/languages/typescript.ts](../../../src/analysis/languages/typescript.ts), add `extractRelationEdges(tree, source)` and call it from the main `extract`.
- Handle `class_declaration` + `abstract_class_declaration` → walk `class_heritage` → `extends_clause` → emit one `extends_class` edge.
- Strip generic args: `Base<T>` → `Base`.
- For non-identifier expressions (`Mixin(Base)`), emit textual node text as `target_name`.
- Test: `tests/relations-extractor.test.ts` — fixtures for plain extends, generic extends, mixin call, no-extends class.

### T4 — TS extractor: implements
- Same node walk, `implements_clause` → emit one `implements` edge per identifier.
- Test: extends-only, implements-only, both, multiple implements.

### T5 — TS extractor: interface extends
- `interface_declaration` → `extends_type_clause` → emit `extends_interface` per identifier.
- Test: single parent, multiple parents, no parents.

### T6 — Same-file resolution
- In [src/index/orchestrator.ts](../../../src/index/orchestrator.ts), after symbol insert: for each relation edge, if `target_name` matches a top-level symbol of kind `class` / `interface` / `type` in the same file, set `target_id`.
- Test: `tests/relations-resolver.test.ts` — `class A {}; class B extends A {}` → B.target_id = A.id.

### T7 — Cross-file resolution via imports
- After T6 leaves edges with NULL target_id, do a second pass: look up `target_name` in the file's `module_edges` (resolved imports). If the imported file has a top-level symbol with that name, link.
- Test: cross-file extends + cross-file implements; unresolved import stays NULL.

### T8 — Store query helpers
- Add `getRelationsBySource(name, kind?)` and `getRelationsByTarget(name, kind?)` to [src/db/store.ts](../../../src/db/store.ts).
- Both return joined rows: source symbol + target symbol (when resolved) + file paths.
- Test: `tests/relations-store.test.ts`.

### T9 — QueryEngine method
- Add `relations(params)` to [src/query/engine.ts](../../../src/query/engine.ts). Returns `NexusResult<RelationEdgeResult>`.
- Implement depth recursion via repeated calls (cap at 5).
- Test: `tests/relations-query.test.ts` — depth=1, depth=2 transitive, kind filter, parents/children/both.

### T10 — MCP tool
- Add `nexus_relations` to [src/transports/mcp.ts](../../../src/transports/mcp.ts) (schema in `ListToolsRequestSchema`, dispatch in `CallToolRequestSchema`).
- Compact mode inherited free.
- Test: `tests/relations-mcp.test.ts` — round-trip via MCP harness.

### T11 — CLI command + formatter
- Add `nexus relations` to [src/transports/cli.ts](../../../src/transports/cli.ts).
- Formatter prints a tree (depth>1) or flat list (depth=1).
- Test: extend `tests/cli.test.ts` or new `tests/relations-cli.test.ts` — `execFileSync` round-trip.

### T12 — Overlay support
- Add `relation_edges` table to [src/db/overlay.ts](../../../src/db/overlay.ts) — same shape minus `target_id` FK; uses `target_path_key`.
- Extend `attachOverlay` in [src/db/store.ts](../../../src/db/store.ts) to merge `relation_edges` view (parent ids positive, overlay ids negative).
- Test: `tests/relations-overlay.test.ts` — modified file's edges appear in merged query.

### T13 — Capability surface in stats
- Verify `nexus_stats` already pipes `relationKinds` through (capabilities are read whole). If not, extend.
- Test: stats response on TS-only fixture reports `relationKinds: ['extends_class','implements','extends_interface']`.

### T14 — Self-test on Nexus repo
- After full reindex, run `nexus relations LanguageAdapter --direction children`.
- Expect: each registered adapter file appears as `implements` edge.
- Run `nexus relations Database --direction children` against `better-sqlite3` types — expect resolved + unresolved depending on import context.
- No automated test (smoke). Captured in PR description.

### T15 — Documentation
- Update [CLAUDE.md](../../../CLAUDE.md):
  - "MCP Tools" section: add `nexus_relations` under "Core / discovery" or new "Relation intelligence" subsection.
  - "Database" section: mention `relation_edges` table.
  - Schema bump notice (v1 will reindex on first run).
- Update roadmap doc to mark B2 v1 in progress; carry the v1.5/v2 follow-ups.

## Sequencing notes

- T1 → T2 must land first (schema + capability are dependencies for everything else).
- T3 / T4 / T5 are independent; can land in any order, parallelizable.
- T6 / T7 (resolution) gate T8 / T9 (queries) only at semantic-correctness level — empty target_id values won't break tests, just yield best-effort verdicts.
- T12 (overlay) gates worktree correctness but not the v1 ship — it can be a fast-follow if blocking on schema review.
- T15 (docs) lands with the merge commit, not before.

## Verification gates

- After each task: `npm run build && npm test` must pass.
- T1: schema migration test passes; existing fixtures don't break.
- T6/T7: hand-curated fixture covering each resolution path.
- T9: `nexus_relations` round-trip on Nexus's own codebase produces non-empty results for known classes.
- Final: full suite green (~969 tests after additions); benchmark reindex on Nexus repo, expect no >20% slowdown.

## Risks during implementation

- **SCHEMA bump regression:** if we accidentally break column ordering / drops, existing users hit data loss on upgrade. Mitigation: T1 test verifies migration; manual smoke on a copy of `.nexus/index.db`.
- **Tree-sitter node names:** `class_heritage` / `extends_clause` exact names depend on the tree-sitter-typescript grammar version. Mitigation: T3 starts by inspecting actual AST via existing test scaffolding before writing the extractor.
- **Resolution loops:** `interface A extends B; interface B extends A` would loop on depth>1 query. Mitigation: visited-set in `relations()` recursion (mirror `nexus_deps` cycle handling).
- **Overlay merge:** the existing `module_edges` pattern already deals with this; copy faithfully rather than reinventing.

## Estimated scope

~12-15 new files, ~600-900 LoC across src + tests. Roughly the size of the C1 preedit-impact ship. Fits in a single PR; could split per task list if review prefers smaller diffs.
