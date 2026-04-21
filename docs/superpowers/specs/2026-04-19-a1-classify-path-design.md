# A1 — `classifyPath()` + Document Parsers (Design Spec)

**Status:** Approved design, ready for plan.
**Tier:** V3 Tier 1 (per [sourcegraph-closest-analog-sharded-seahorse.md](../../../../../Users/Shlom/.claude/plans/sourcegraph-closest-analog-sharded-seahorse.md), section "Tier 1 — V3 Specs", subsection A1).
**Scope slice chosen:** (b) Ship `classifyPath()` + all document parsers as spec'd. Parsers sit unused until A3 consumes them.

---

## Goal

Unify Nexus's notion of "what kind of file is this?" behind a single pure function, and land the document-parser helpers that A3's upcoming MCP tools will consume. The scanner stops doing ad-hoc `path.extname` lookups; instead it asks `classifyPath()` and filters on `kind === 'source'`. Parsers live beside the classifier so A3 can wire them up without touching this module again.

This is a **refactor + groundwork** slice. No new user-visible MCP tools. Behavior change is limited to:
- Filename-based rules now recognize `package.json`, `tsconfig*.json`, `.github/workflows/*.yml`, lockfiles, `Cargo.toml` — but still `ignored` from the scanner's POV (nothing else consumes them yet).
- The `.nexus.json` `languages` override regression (V2.2 change #4) now exercises the real code path.

---

## Architecture

### New module: `src/workspace/classify.ts`

One exported function, one exported type:

```typescript
export type FileKind =
  | { kind: 'source'; language: string }
  | { kind: 'package_json' }
  | { kind: 'tsconfig_json' }
  | { kind: 'gha_workflow' }
  | { kind: 'cargo_toml' }
  | { kind: 'package_lock' }
  | { kind: 'yarn_lock' }
  | { kind: 'pnpm_lock' }
  | { kind: 'cargo_lock' }
  | { kind: 'json_generic' }
  | { kind: 'yaml_generic' }
  | { kind: 'toml_generic' }
  | { kind: 'ignored' };

export function classifyPath(
  posixPath: string,
  basename: string,
  config: { languages: Record<string, { extensions: string[] }> },
): FileKind;
```

`posixPath` is the path relative to the repo root, forward slashes only.
`basename` is redundant but explicit — callers almost always already have it and passing it avoids a `path.basename()` call inside a hot loop.
`config.languages` carries `.nexus.json` overrides already loaded by [config.ts](../../../src/config.ts).

**The default extension map moves from `scanner.ts` into `classify.ts`.** `scanner.ts` stops owning it; `classify.ts` is the single source of truth.

### Classification precedence

First match wins:

1. **Exact basename** (case-insensitive): `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.toml`, `Cargo.lock`.
2. **Basename pattern**: `tsconfig*.json` → `tsconfig_json`.
3. **Path pattern**: `.github/workflows/*.{yml,yaml}` → `gha_workflow`. Must match the full prefix — nested workflow files don't qualify (GitHub ignores them anyway).
4. **Extension → source** via merged map: `DEFAULT_EXTENSIONS` + `config.languages` overrides. Config wins on conflict (explicit user intent).
5. **Extension → generic**: `.json` → `json_generic`, `.yml`/`.yaml` → `yaml_generic`, `.toml` → `toml_generic`.
6. **Fallthrough** → `ignored`.

**Why source beats generic:** a user who maps `.yaml` → `yaml_schema` via config expects source treatment. A `.json` that isn't a known special filename falls through to `json_generic`.

**Case rules:**
- Known filenames (`Cargo.toml`, `package.json`) compare case-insensitively on the basename. Some users on case-insensitive filesystems commit `cargo.toml`; it still classifies the same way.
- Extensions already lowercase the input (matches existing scanner behavior at [scanner.ts:81](../../../src/workspace/scanner.ts:81) and [scanner.ts:164](../../../src/workspace/scanner.ts:164)).

### Scanner wiring changes

`src/workspace/scanner.ts`:
- `DEFAULT_EXTENSIONS` (lines 9-24) **deleted** — moved into `classify.ts`.
- Both scan loops call `classifyPath(posixPath, basename, config)` instead of `extensions[ext]`. Only entries where `kind === 'source'` survive.
- `language` comes from `FileKind` (`kind.language`), not a separate lookup.
- `buildExtraExtensions()` becomes dead code and is **deleted**. Current callers: [src/index/orchestrator.ts:88](../../../src/index/orchestrator.ts:88) (feeds `scanDirectory`) and [tests/workspace.test.ts:304](../../../tests/workspace.test.ts:304) (standalone unit test). The orchestrator call goes away; the test gets dropped (the override behavior is re-covered end-to-end in the new `tests/scanner.test.ts` integration test).
- `ScanOptions.extraExtensions` is replaced with `languages: Record<string, { extensions: string[] }>` — the same shape as `config.languages`. The orchestrator already has config in scope ([orchestrator.ts:11,88-89](../../../src/index/orchestrator.ts)), so it passes `config.languages` straight through.
- `src/index.ts` re-export line is trimmed — `scanDirectory` stays exported, `buildExtraExtensions` is removed.

**Net functional change to the scanner:** zero. Same files get indexed before and after — just routed through a consistent classifier.

### Document parsers — `src/analysis/documents/`

Seven plain synchronous functions, one file each, exported from `src/analysis/documents/index.ts`:

| File | Exports | Parser |
|---|---|---|
| `package-json.ts` | `parsePackageJson(content: string): ParsedPackageJson \| ParseError` | `JSON.parse` |
| `tsconfig.ts` | `parseTsconfig(content: string): ParsedTsconfig \| ParseError` | `jsonc-parser` |
| `gha-workflow.ts` | `parseGhaWorkflow(content: string): ParsedGhaWorkflow \| ParseError` | `yaml` |
| `cargo-toml.ts` | `parseCargoToml(content: string): ParsedCargoToml \| ParseError` | `smol-toml` |
| `generic-json.ts` | `parseGenericJson(content: string): unknown \| ParseError` | `jsonc-parser` (tolerates comments) |
| `generic-yaml.ts` | `parseGenericYaml(content: string): unknown \| ParseError` | `yaml` |
| `generic-toml.ts` | `parseGenericToml(content: string): unknown \| ParseError` | `smol-toml` |

```typescript
export type ParseError = { error: string };
```

**Contract:**
- Synchronous.
- Never throws. Caught exceptions turn into `{ error: <one-line reason> }`.
- Return shape is format-specific — `ParsedPackageJson` exposes `name`, `version`, `dependencies`, `devDependencies`, `peerDependencies`, `scripts`, `workspaces` (all optional). No unified `ParsedDocument` union — A3 tools want the raw shapes and premature unification would only add mapping churn.
- No size caps, no caching. A2 owns those.
- No line anchors in P0 (V2.2 change #8).

**Parsed shapes** (representative):

```typescript
export interface ParsedPackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages: string[] };
}

export interface ParsedTsconfig {
  extends?: string | string[];
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
  files?: string[];
  references?: { path: string }[];
}

export interface ParsedGhaWorkflow {
  name?: string;
  on?: unknown;
  jobs?: Record<string, {
    'runs-on'?: string | string[];
    steps?: {
      name?: string;
      uses?: string;
      run?: string;
    }[];
  }>;
}

export interface ParsedCargoToml {
  package?: { name?: string; version?: string; edition?: string };
  dependencies?: Record<string, unknown>;
  'dev-dependencies'?: Record<string, unknown>;
  workspace?: { members?: string[] };
}
```

Shapes are **narrow on purpose** — enough for A3's MCP tools to answer common questions, not a full schema reproduction. Unknown fields stay in the parsed result (the types don't exhaust the return value; `unknown` fields are accessible via index signature or cast).

**`yarn.lock`** uses a small hand-rolled regex parser (yarn v1 format — `"<spec>":\n  version "<v>"`). Yarn's format isn't YAML despite the extension. The parser exposes `{ name, version }[]`. Only needed once A3 P2 lockfile tools ship, but we land it here for consistency.

---

## Dependencies

Three new runtime deps, added in `package.json` alongside the existing ones:

| Package | Purpose | Rationale |
|---|---|---|
| `jsonc-parser` | tsconfig + generic JSON | Handles comments + trailing commas. VSCode's parser. Zero deps. |
| `yaml` | GHA workflows + generic YAML | Mature, maintained, widely used. |
| `smol-toml` | Cargo.toml + generic TOML | Zero deps, maintained. (`@iarna/toml` is unmaintained.) |

All three are small and pure-JS. No new dev-deps needed.

---

## Testing

### `tests/classify.test.ts` (new)

- **Positive case per FileKind variant** — one fixture each.
- **Precedence:**
  - `package.json` → `package_json`, not `json_generic`.
  - `tsconfig.base.json` → `tsconfig_json`.
  - `.github/workflows/ci.yml` → `gha_workflow`, not `yaml_generic`.
  - `package-lock.json` → `package_lock`, not `json_generic`.
  - `Cargo.lock` → `cargo_lock`, not `toml_generic`.
- **Config override (V2.2 change #4 regression):**
  - `config.languages = { typescript: { extensions: ['.astro'] } }` → `foo.astro` classifies as `source(typescript)`.
  - Override beats generic: user mapping `.yaml` → some language wins over `yaml_generic`.
- **Windows input:** `src\foo.ts` (backslash) classifies the same as `src/foo.ts`. Documents the POSIX-normalization contract.
- **Case insensitivity:** `cargo.toml` and `Cargo.toml` both match; `PACKAGE.JSON` matches.
- **Ignored fallthrough:** `README.md`, unknown extensions, `.gitignore`, `.eslintrc` all → `ignored` (no silent generic-YAML assignment for dotfiles with no extension).

### `tests/documents.test.ts` (new)

- One happy-path fixture per parser, asserting the fields listed in the parsed-shape definitions.
- One malformed-input fixture per parser (syntactically invalid JSON/YAML/TOML) → returns `{ error }`, does not throw.
- `parseTsconfig` fixture includes both `// line comment` and trailing comma to prove JSONC tolerance.
- `parseGenericJson`/`parseGenericYaml`/`parseGenericToml` round-trip arbitrary nested structures without schema assertions.
- `parseGhaWorkflow` fixture includes a multi-job workflow with `uses:` and `run:` steps.

### `tests/scanner.test.ts` (new or modify)

One integration test:
- Temp directory with `.nexus.json` mapping `.astro` → `typescript`, plus an `.astro` file and a `.ts` file.
- `scanDirectory()` returns both files with `language: 'typescript'`.

Proves the classifier override path survives the refactor end-to-end.

### Out of scope for A1 tests

- No MCP tool tests (A3).
- No cache tests (A2).
- No size-cap tests (A2).

---

## Scope boundaries — explicitly out

- ❌ No MCP tools: `nexus_structured_query`, `nexus_structured_outline`, `nexus_lockfile_deps` all belong to A3.
- ❌ No cache: A2 owns in-process LRU.
- ❌ No size caps on parsers: A2 owns per-format caps.
- ❌ No indexed storage of parsed results: V3 spec explicitly defers.
- ❌ No line anchors: V2.2 change #8 drops from P0.
- ❌ No document adapter registry: promote only at ≥3 shared consumers (per spec).
- ❌ No CLI surface: parsers are internal until A3.

---

## Files touched

| File | Action | Purpose |
|---|---|---|
| `src/workspace/classify.ts` | **Create** | `FileKind` union + `classifyPath()` |
| `src/workspace/scanner.ts` | Modify | Replace both `path.extname` sites; delete `DEFAULT_EXTENSIONS` and `buildExtraExtensions` |
| `src/index/orchestrator.ts` | Modify | Drop `buildExtraExtensions` call; pass `config.languages` to `scanDirectory` directly |
| `src/index.ts` | Modify | Remove `buildExtraExtensions` from re-exports |
| `tests/workspace.test.ts` | Modify | Update 6 `scanDirectory` call sites to new signature; delete standalone `buildExtraExtensions` test |
| `src/analysis/documents/index.ts` | Create | Re-exports |
| `src/analysis/documents/package-json.ts` | Create | `parsePackageJson` |
| `src/analysis/documents/tsconfig.ts` | Create | `parseTsconfig` |
| `src/analysis/documents/gha-workflow.ts` | Create | `parseGhaWorkflow` |
| `src/analysis/documents/cargo-toml.ts` | Create | `parseCargoToml` |
| `src/analysis/documents/generic-json.ts` | Create | `parseGenericJson` |
| `src/analysis/documents/generic-yaml.ts` | Create | `parseGenericYaml` |
| `src/analysis/documents/generic-toml.ts` | Create | `parseGenericToml` |
| `src/analysis/documents/yarn-lock.ts` | Create | `parseYarnLock` (regex) |
| `package.json` | Modify | Add `jsonc-parser`, `yaml`, `smol-toml` |
| `tests/classify.test.ts` | Create | Classifier unit suite |
| `tests/documents.test.ts` | Create | Parser unit suite |
| `tests/scanner.test.ts` | Create/modify | Override-regression integration test |
| `CHANGELOG.md` | Modify | Unreleased entry |
| `CLAUDE.md` | Modify | Architecture note on `src/workspace/classify.ts` + `src/analysis/documents/` |

---

## Success criteria

- [ ] `classifyPath()` passes all unit tests listed above.
- [ ] Scanner indexes the same set of files before vs. after the refactor on the Nexus self-index.
- [ ] `.nexus.json` `languages` override regression test passes.
- [ ] All seven parsers round-trip representative fixtures and return `{ error }` on malformed input.
- [ ] `npm run build` clean, `npm run lint` clean, `npm test` green (394 existing + new ~30).
- [ ] Three new deps appear in `package.json`, lockfile committed.
- [ ] CHANGELOG and CLAUDE.md updated.

---

## Open questions — none

All V2.2 changes affecting A1 are resolved:
- Config override behavior: spec'd in precedence rule 4.
- Line anchors: out of P0.
- Cache key: A2 concern.

Ready to hand off to `superpowers:writing-plans`.
