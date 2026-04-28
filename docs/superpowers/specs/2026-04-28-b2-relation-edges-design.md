# B2 v1 — Relation Edges (declared, TS-only)

**Status:** Design draft. Next: implementation plan.
**Spec reference:** V3 roadmap — B2 under "Tier 2 — V4 (gated on V3 metrics)" / B-track.
**Depends on (all shipped):** B1 ref_kind (TS/JS), `LanguageCapabilities` model, schema versioning, indexer + overlay merge.
**Unblocks:** B6 rename safety, future "find all implementations" queries, type-hierarchy navigation.

---

## Problem

Nexus indexes definitions, imports, exports, and occurrences. It does not record **declared structural relationships** between symbols:

- `class Foo extends Base` → no link from `Foo` to `Base`
- `class Foo implements IUser` → no link from `Foo` to `IUser`
- `interface A extends B` → no link from `A` to `B`
- `method override() {}` → no link from override to parent slot

These are the queries developers reach for during refactoring ("what classes implement `IUserStore`?", "what overrides `BaseHandler.handle`?", "show me everyone in the `Result<T>` hierarchy"). Today users have to grep for `extends Base` / `implements IUser`, which is fragile (renames, formatting, line breaks across `extends A,\n  B`) and language-dependent.

This is the smallest non-controversial primitive in the B-track. It enables B6 rename-safety (which needs to know the override hierarchy to verify a rename is consistent) and is itself useful day one.

## Scope (v1)

**In:**
- TypeScript only (`.ts` / `.tsx`).
- **Declared** edges only — taken directly from AST node types, no inference. `class Foo extends Base` produces an edge regardless of whether `Base` resolves to a known symbol; resolution is best-effort and captured separately.
- Three edge kinds:
  - `extends_class` — class/interface declares an `extends` clause
  - `implements` — class declares an `implements` clause
  - `extends_interface` — interface declares an `extends` clause (multiple parents allowed)
- Resolution to a target `symbol_id` when the parent name resolves to a top-level symbol in the same file or via an import in scope. Cross-file resolution piggybacks on the existing `module_edges` import resolver.
- Capability surfacing on `LanguageCapabilities` so `nexus_stats` advertises which adapters emit relation edges.

**Out (v1):**
- JavaScript class extends (no syntactic `implements`; AST shape differs slightly — covered in v1.5).
- Java/C# adapters — listed in roadmap as "first" but the v1 ship gate is "TS landed end-to-end including new MCP tool." Java/C# follow as v1.5 / v2 once the schema and tool surface have stabilized.
- Method override edges — needs name + signature resolution against parent class members. Defer to v2.
- Generic instantiation tracking (`Foo<string>` vs `Foo<number>`) — out of scope; the edge is from `Foo` declaration, not callsite.
- Mixin patterns (`class Foo extends Mixin(Base)`). Edge gets emitted with the textual parent expression (`"Mixin(Base)"`); resolution will fail. Documented limitation, not a bug.
- Inferred / structural-typing edges (`type X = Y & { ... }` is not a relation edge). Listed in roadmap as `derived` confidence, deferred until declared edges have proven their schema.

## Schema

New table `relation_edges`. Co-located with `module_edges` and `symbols`; bumps `SCHEMA_VERSION` (forces full reindex).

```sql
CREATE TABLE IF NOT EXISTS relation_edges (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,           -- 'extends_class' | 'implements' | 'extends_interface'
  target_name TEXT NOT NULL,           -- as written in source (e.g. "Base", "Mixin(Base)")
  target_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  confidence  TEXT NOT NULL DEFAULT 'declared',  -- 'declared' | 'derived' (future)
  line        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relation_edges_source ON relation_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_relation_edges_target ON relation_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_relation_edges_target_name ON relation_edges(target_name);
CREATE INDEX IF NOT EXISTS idx_relation_edges_kind ON relation_edges(kind);
CREATE INDEX IF NOT EXISTS idx_relation_edges_file ON relation_edges(file_id);
```

**`source_id` always resolves** (it's the declaring symbol — already in the same `ExtractionResult`). **`target_id` may be NULL** (parent class from an unresolved import, dynamic mixin, or a symbol the indexer hasn't reached yet).

**Confidence column** future-proofs for B-track derived/structural edges per the V3 roadmap's "capability matrix with `confidence: declared|derived`" language. v1 only ever writes `declared`.

## Overlay support

Same pattern as `module_edges`: overlay table replaces `target_id` with `target_path_key` + lookup, since cross-file FKs into the parent index don't survive `ATTACH DATABASE`. Detail follows the proven `overlay.ts:71` pattern.

## Capability surfacing

Extend `LanguageCapabilities`:

```ts
export interface LanguageCapabilities {
  // ... existing
  relationKinds: string[];   // [] = no edges; e.g. ['extends_class','implements','extends_interface'] for TS
}
```

TS adapter populates with the three kinds. Other adapters keep `[]`. `nexus_stats` already reports per-language capabilities — no new top-level field.

## Extractor

In `src/analysis/languages/typescript.ts`, add a `extractRelationEdges` pass over `class_declaration`, `interface_declaration`, and `abstract_class_declaration` nodes. Walk:
- `class_heritage` → `extends_clause` (single parent expression) → emit `extends_class`
- `class_heritage` → `implements_clause` (n parents) → emit one `implements` per identifier
- For interface: `extends_type_clause` → emit one `extends_interface` per identifier

`target_name` is the textual parent expression (joined token text). For `extends Foo<T>` we record `"Foo"` (strip generic args); for `extends Mixin(Base)` we record the full call expression text — best-effort, never fail.

`source_id` resolution: extractor produces `RelationEdgeRow` with `source_symbol_index` (an index into the `symbols` array of the same `ExtractionResult`). Orchestrator backfills `source_id` after symbol insert, mirroring how `module_edges.symbol_id` is wired.

`target_id` resolution: deferred to a separate pass after all files index. For each row with NULL `target_id`, look up `target_name` in:
1. Local file's symbols (top-level only).
2. Imports of the same file → `module_edges.resolved_file_id`'s exported symbols matching `target_name`.
3. Leave NULL if neither hits.

## MCP tool: `nexus_relations`

```
nexus_relations(name: string, direction?: 'parents' | 'children' | 'both', kind?: string, depth?: number, limit?: number)
```

- `name`: symbol name to query (class or interface).
- `direction`:
  - `parents` (default) — edges where `source_name === name` (what does X extend/implement?)
  - `children` — edges where `target_name === name` (who extends/implements X?)
  - `both` — union
- `kind`: optional filter (`extends_class`, `implements`, `extends_interface`).
- `depth`: 1-5, default 1. Recurse via `target_id` for `parents`, `source_id` for `children`. Symmetric with `nexus_deps`.
- `limit`: cap edges per node.

Returns:
```ts
{
  query: { name, direction, kind, depth },
  type: 'relations',
  results: [
    {
      source: { name, file, line, kind },     // class/interface that declared the edge
      kind: 'extends_class',
      target: { name, file?, line?, kind?, resolved: boolean },
      depth: 1
    },
    ...
  ],
  count: number,
  index_status, index_health, timing_ms
}
```

`target.resolved = false` means `target_id` is NULL (cross-boundary or unresolved). Consumers can choose to treat as best-effort.

## CLI: `nexus relations`

`nexus relations <name> [--direction parents|children|both] [--kind extends_class|implements|extends_interface] [--depth N] [--limit N] [--json]`

Mirrors the MCP shape. Useful for shell-driven hierarchy walks.

## Verification

1. **Unit (extractor):**
   - `class Foo extends Base {}` → 1 edge, kind `extends_class`, target_name `Base`.
   - `class Foo implements IUser, IAdmin {}` → 2 edges, kind `implements`.
   - `interface A extends B, C {}` → 2 edges, kind `extends_interface`.
   - `class Foo extends Mixin(Base) {}` → 1 edge, target_name = textual call expression, target_id = NULL.
   - `class Foo<T> extends Base<T> {}` → 1 edge, target_name = `Base` (generic args stripped).

2. **Integration (resolution):**
   - Same-file resolution: `class A {}` then `class B extends A {}` → B's edge has target_id = A's id.
   - Cross-file via import: `import { Base } from './base'; class B extends Base {}` → target_id resolves to `./base.ts`'s `Base` export.
   - Unresolved import: target_id = NULL, edge still present.

3. **MCP tool:**
   - `nexus_relations("Base", direction: "children")` returns all classes that extend Base, including transitive at `depth: 2`.
   - `nexus_relations("Foo", direction: "parents", kind: "implements")` returns only interface implementations.

4. **Capability:** TS adapter reports `relationKinds: ['extends_class','implements','extends_interface']`; other adapters report `[]`.

5. **Schema migration:** SCHEMA_VERSION bump triggers full rebuild; existing indexes survive bump on next run.

6. **Overlay:** in a worktree with hybrid overlay, edges from a modified file appear with negative ids and are merged into the union view.

## Out-of-scope follow-ups (tracked, not blocking)

- **B2 v1.5:** JS adapter (only `extends_class`, no `implements`).
- **B2 v2:** Method override edges — adds `overrides` kind on symbols (not classes), needs cross-symbol name+signature match.
- **B2 v3:** Java + C# adapters.
- **B-derived:** structural type edges (`type X = Y & Z`) at `confidence: derived`.

## Files (estimated)

| File | Action |
|---|---|
| `src/db/schema.ts` | Add `relation_edges` table + indexes; bump `SCHEMA_VERSION` to 3. |
| `src/db/store.ts` | New `RelationEdgeRow` type, insert helpers, query helpers (`getRelations`, `getRelationsByTarget`). Extend overlay temp views. |
| `src/db/overlay.ts` | Add overlay `relation_edges` table mirroring `module_edges` pattern (target_path_key). |
| `src/analysis/languages/registry.ts` | Add `relationKinds: string[]` to `LanguageCapabilities`; extend `ExtractionResult` with `relations`. |
| `src/analysis/languages/typescript.ts` | Add `extractRelationEdges`. |
| `src/analysis/languages/python.ts` `go.ts` `rust.ts` `java.ts` `csharp.ts` `css.ts` | Add empty `relationKinds: []` to capabilities, return `relations: []` from extract. |
| `src/index/orchestrator.ts` | Two-phase resolve: insert with NULL target_id, second pass resolves via local symbols + module_edges. |
| `src/index/overlay-orchestrator.ts` | Mirror two-phase for overlay edges. |
| `src/query/engine.ts` | New `relations()` method + `RelationsResult`. |
| `src/transports/mcp.ts` | Add `nexus_relations` tool. |
| `src/transports/cli.ts` | Add `nexus relations` command + formatter. |
| `tests/relations-extractor.test.ts` | NEW — extractor unit tests. |
| `tests/relations-resolver.test.ts` | NEW — same/cross-file resolution. |
| `tests/relations-query.test.ts` | NEW — engine method. |
| `tests/relations-mcp.test.ts` | NEW — MCP tool round-trip. |
| `tests/relations-overlay.test.ts` | NEW — overlay merge. |
| `CLAUDE.md` | Document `nexus_relations` under MCP Tools and `relation_edges` schema. |
| Roadmap doc | Mark B2 v1 in progress. |

## Risks / mitigations

- **SCHEMA_VERSION bump forces a full reindex on first upgrade.** Same as B1 ship; users have lived through this. Doctor should mention it. Mitigation: nothing — this is the design.
- **Two-phase resolution adds an indexing pass.** Cost: one extra SQL pass over `relation_edges` after symbol insert. Bounded by edge count, which is small (~one per class on most repos). Benchmark in plan.
- **Cross-boundary best-effort** in worktree overlays inherits the same caveat the worktree commit message already documents for symbol-level cross-boundary on `module_edges`. Same fallback (best-effort), same `meta.degraded_reason` plumbing.
- **Schema column `confidence` reserved but unused in v1.** Costs almost nothing (TEXT column, default value), saves a future migration.

## Acceptance criteria (v1 ship gate)

- All listed verification cases pass.
- Full vitest suite green (current 939 + ~30 new).
- `nexus_relations` returns correct edges on Nexus's own codebase (e.g., querying for `LanguageAdapter` returns each adapter file as `implements`).
- `nexus stats` reports `relationKinds: [...]` for TypeScript and `[]` for others.
- Reindex of Nexus's own repo completes in within 1.2× current baseline.
