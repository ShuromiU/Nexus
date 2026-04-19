# A1 — `classifyPath()` + Document Parsers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Nexus's "what kind of file is this?" decision behind one pure function (`classifyPath`) and land the document-parser helpers that A3's upcoming MCP tools will consume. Pure refactor + groundwork — no behavior change for indexed files, no new MCP tools.

**Architecture:** One new module `src/workspace/classify.ts` exports `FileKind` (discriminated union) and `classifyPath()`. The default extension map moves out of `scanner.ts` into `classify.ts`. Scanner calls `classifyPath()` and filters on `kind === 'source'`. Document parsers live under `src/analysis/documents/` as plain functions — one per format, each returning a narrow typed shape or `{ error }`. No cache, no size caps, no MCP surface (those land in A2/A3).

**Tech Stack:** TypeScript (strict), Vitest, three new runtime deps (`jsonc-parser` for JSONC, `yaml` for YAML, `smol-toml` for TOML).

**Spec reference:** [docs/superpowers/specs/2026-04-19-a1-classify-path-design.md](../specs/2026-04-19-a1-classify-path-design.md).

---

### File Map

| File | Action | Responsibility |
|---|---|---|
| `src/workspace/classify.ts` | Create | `FileKind` union + `classifyPath()` + default extension map |
| `src/workspace/scanner.ts` | Modify | Replace both `path.extname` sites; delete `DEFAULT_EXTENSIONS` + `buildExtraExtensions`; `ScanOptions.extraExtensions` → `languages` |
| `src/index/orchestrator.ts` | Modify | Drop `buildExtraExtensions` call; pass `config.languages` straight to `scanDirectory` |
| `src/index.ts` | Modify | Remove `buildExtraExtensions` from re-exports; add `classifyPath` and `FileKind` |
| `src/analysis/documents/index.ts` | Create | Re-exports all parsers + their typed shapes |
| `src/analysis/documents/package-json.ts` | Create | `parsePackageJson` |
| `src/analysis/documents/tsconfig.ts` | Create | `parseTsconfig` |
| `src/analysis/documents/generic-json.ts` | Create | `parseGenericJson` |
| `src/analysis/documents/gha-workflow.ts` | Create | `parseGhaWorkflow` |
| `src/analysis/documents/generic-yaml.ts` | Create | `parseGenericYaml` |
| `src/analysis/documents/cargo-toml.ts` | Create | `parseCargoToml` |
| `src/analysis/documents/generic-toml.ts` | Create | `parseGenericToml` |
| `src/analysis/documents/yarn-lock.ts` | Create | `parseYarnLock` |
| `package.json` | Modify | Add `jsonc-parser`, `yaml`, `smol-toml` runtime deps |
| `tests/classify.test.ts` | Create | Classifier unit suite |
| `tests/documents.test.ts` | Create | Parser unit suite |
| `tests/workspace.test.ts` | Modify | Migrate 6 `scanDirectory` call sites to new signature; drop `buildExtraExtensions` unit test; keep "uses extra extensions in scan" as the integration test |
| `CHANGELOG.md` | Modify | Unreleased entry |
| `CLAUDE.md` | Modify | Architecture note on `src/workspace/classify.ts` + `src/analysis/documents/` |

---

### Task 1: `classifyPath()` + `FileKind`

**Files:**
- Create: `src/workspace/classify.ts`
- Create: `tests/classify.test.ts`

- [ ] **Step 1: Write the failing test suite**

Create `tests/classify.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyPath } from '../src/workspace/classify.js';

const noOverrides = { languages: {} };

describe('classifyPath', () => {
  it('classifies .ts as source(typescript)', () => {
    expect(classifyPath('src/index.ts', 'index.ts', noOverrides))
      .toEqual({ kind: 'source', language: 'typescript' });
  });

  it('classifies .py as source(python)', () => {
    expect(classifyPath('app.py', 'app.py', noOverrides))
      .toEqual({ kind: 'source', language: 'python' });
  });

  it('recognises every default extension', () => {
    const cases: Array<[string, string]> = [
      ['x.tsx', 'typescript'], ['x.mts', 'typescript'], ['x.cts', 'typescript'],
      ['x.js', 'javascript'], ['x.jsx', 'javascript'], ['x.mjs', 'javascript'], ['x.cjs', 'javascript'],
      ['x.go', 'go'], ['x.rs', 'rust'], ['x.java', 'java'], ['x.cs', 'csharp'], ['x.css', 'css'],
    ];
    for (const [p, lang] of cases) {
      expect(classifyPath(p, p, noOverrides)).toEqual({ kind: 'source', language: lang });
    }
  });

  it('classifies package.json as package_json (not json_generic)', () => {
    expect(classifyPath('package.json', 'package.json', noOverrides)).toEqual({ kind: 'package_json' });
  });

  it('classifies tsconfig.json and tsconfig.base.json as tsconfig_json', () => {
    expect(classifyPath('tsconfig.json', 'tsconfig.json', noOverrides)).toEqual({ kind: 'tsconfig_json' });
    expect(classifyPath('apps/web/tsconfig.base.json', 'tsconfig.base.json', noOverrides))
      .toEqual({ kind: 'tsconfig_json' });
  });

  it('classifies .github/workflows/ci.yml as gha_workflow', () => {
    expect(classifyPath('.github/workflows/ci.yml', 'ci.yml', noOverrides))
      .toEqual({ kind: 'gha_workflow' });
    expect(classifyPath('.github/workflows/release.yaml', 'release.yaml', noOverrides))
      .toEqual({ kind: 'gha_workflow' });
  });

  it('classifies nested .github/workflows/*.yml as yaml_generic (GHA ignores them)', () => {
    expect(classifyPath('.github/workflows/nested/ci.yml', 'ci.yml', noOverrides))
      .toEqual({ kind: 'yaml_generic' });
  });

  it('classifies lockfiles by exact basename', () => {
    expect(classifyPath('package-lock.json', 'package-lock.json', noOverrides)).toEqual({ kind: 'package_lock' });
    expect(classifyPath('yarn.lock', 'yarn.lock', noOverrides)).toEqual({ kind: 'yarn_lock' });
    expect(classifyPath('pnpm-lock.yaml', 'pnpm-lock.yaml', noOverrides)).toEqual({ kind: 'pnpm_lock' });
    expect(classifyPath('Cargo.lock', 'Cargo.lock', noOverrides)).toEqual({ kind: 'cargo_lock' });
  });

  it('classifies Cargo.toml as cargo_toml (case-insensitive basename)', () => {
    expect(classifyPath('Cargo.toml', 'Cargo.toml', noOverrides)).toEqual({ kind: 'cargo_toml' });
    expect(classifyPath('crates/a/cargo.toml', 'cargo.toml', noOverrides)).toEqual({ kind: 'cargo_toml' });
  });

  it('falls back to json_generic / yaml_generic / toml_generic', () => {
    expect(classifyPath('data/x.json', 'x.json', noOverrides)).toEqual({ kind: 'json_generic' });
    expect(classifyPath('ci/x.yaml', 'x.yaml', noOverrides)).toEqual({ kind: 'yaml_generic' });
    expect(classifyPath('ci/x.yml', 'x.yml', noOverrides)).toEqual({ kind: 'yaml_generic' });
    expect(classifyPath('cfg/x.toml', 'x.toml', noOverrides)).toEqual({ kind: 'toml_generic' });
  });

  it('returns ignored for unknown extensions and dotfiles', () => {
    expect(classifyPath('README.md', 'README.md', noOverrides)).toEqual({ kind: 'ignored' });
    expect(classifyPath('.gitignore', '.gitignore', noOverrides)).toEqual({ kind: 'ignored' });
    expect(classifyPath('.eslintrc', '.eslintrc', noOverrides)).toEqual({ kind: 'ignored' });
    expect(classifyPath('bin/tool', 'tool', noOverrides)).toEqual({ kind: 'ignored' });
  });

  it('honors config.languages override — custom extension wins over generic', () => {
    const config = { languages: { typescript: { extensions: ['.astro'] } } };
    expect(classifyPath('pages/index.astro', 'index.astro', config))
      .toEqual({ kind: 'source', language: 'typescript' });
  });

  it('config override beats json_generic / yaml_generic / toml_generic', () => {
    const config = { languages: { custom: { extensions: ['.yaml', '.json'] } } };
    expect(classifyPath('a.yaml', 'a.yaml', config)).toEqual({ kind: 'source', language: 'custom' });
    expect(classifyPath('a.json', 'a.json', config)).toEqual({ kind: 'source', language: 'custom' });
  });

  it('known basenames beat config-overridden generic extensions', () => {
    const config = { languages: { custom: { extensions: ['.json', '.toml', '.yaml'] } } };
    expect(classifyPath('package.json', 'package.json', config)).toEqual({ kind: 'package_json' });
    expect(classifyPath('Cargo.toml', 'Cargo.toml', config)).toEqual({ kind: 'cargo_toml' });
    expect(classifyPath('pnpm-lock.yaml', 'pnpm-lock.yaml', config)).toEqual({ kind: 'pnpm_lock' });
  });

  it('accepts extension with or without leading dot in config', () => {
    const config = { languages: { g: { extensions: ['graphql', '.gql'] } } };
    expect(classifyPath('q.graphql', 'q.graphql', config)).toEqual({ kind: 'source', language: 'g' });
    expect(classifyPath('q.gql', 'q.gql', config)).toEqual({ kind: 'source', language: 'g' });
  });

  it('is case-insensitive for extensions', () => {
    expect(classifyPath('x.TS', 'x.TS', noOverrides)).toEqual({ kind: 'source', language: 'typescript' });
    expect(classifyPath('x.JSON', 'x.JSON', noOverrides)).toEqual({ kind: 'json_generic' });
  });

  it('is case-insensitive for known basenames', () => {
    expect(classifyPath('PACKAGE.JSON', 'PACKAGE.JSON', noOverrides)).toEqual({ kind: 'package_json' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/classify.test.ts`
Expected: FAIL — module `../src/workspace/classify.js` does not exist.

- [ ] **Step 3: Implement `classify.ts`**

Create `src/workspace/classify.ts`:

```typescript
import * as path from 'node:path';

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

/**
 * Default language-by-extension map. Single source of truth — scanner consumes
 * this via classifyPath() only.
 */
export const DEFAULT_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.css': 'css',
};

const EXACT_BASENAME: Record<string, FileKind> = {
  'package.json': { kind: 'package_json' },
  'package-lock.json': { kind: 'package_lock' },
  'yarn.lock': { kind: 'yarn_lock' },
  'pnpm-lock.yaml': { kind: 'pnpm_lock' },
  'cargo.toml': { kind: 'cargo_toml' },
  'cargo.lock': { kind: 'cargo_lock' },
};

export interface ClassifyConfig {
  languages: Record<string, { extensions: string[] }>;
}

/**
 * Classify a workspace-relative file path into a FileKind.
 *
 * Precedence (first match wins):
 *   1. Exact basename (case-insensitive) — package.json, Cargo.lock, etc.
 *   2. Basename pattern — tsconfig*.json.
 *   3. Path pattern — .github/workflows/*.{yml,yaml} (direct children only).
 *   4. Extension → source via DEFAULT_EXTENSIONS + config.languages overrides.
 *   5. Extension → generic (.json/.yml/.yaml/.toml).
 *   6. Ignored.
 *
 * @param posixPath — workspace-relative, forward-slash path.
 * @param basename  — redundant but explicit; callers usually already have it.
 * @param config    — resolved .nexus.json config (only languages field consulted).
 */
export function classifyPath(
  posixPath: string,
  basename: string,
  config: ClassifyConfig,
): FileKind {
  const lowerBasename = basename.toLowerCase();

  // 1. Exact basename match (case-insensitive).
  const exact = EXACT_BASENAME[lowerBasename];
  if (exact) return exact;

  // 2. tsconfig*.json (case-insensitive on the tsconfig prefix).
  if (lowerBasename.startsWith('tsconfig') && lowerBasename.endsWith('.json')) {
    return { kind: 'tsconfig_json' };
  }

  // 3. .github/workflows/*.{yml,yaml} — direct children only.
  if (isGhaWorkflowPath(posixPath, lowerBasename)) {
    return { kind: 'gha_workflow' };
  }

  // 4. Source extension (config override > default map).
  const ext = path.extname(basename).toLowerCase();
  if (ext.length > 0) {
    const configLang = findConfigLanguage(ext, config);
    if (configLang !== null) return { kind: 'source', language: configLang };
    const defaultLang = DEFAULT_EXTENSIONS[ext];
    if (defaultLang) return { kind: 'source', language: defaultLang };
  }

  // 5. Generic by extension.
  if (ext === '.json') return { kind: 'json_generic' };
  if (ext === '.yml' || ext === '.yaml') return { kind: 'yaml_generic' };
  if (ext === '.toml') return { kind: 'toml_generic' };

  // 6. Fallthrough.
  return { kind: 'ignored' };
}

function isGhaWorkflowPath(posixPath: string, lowerBasename: string): boolean {
  if (!lowerBasename.endsWith('.yml') && !lowerBasename.endsWith('.yaml')) return false;
  // Must be .github/workflows/<file>.{yml,yaml} at exactly that depth.
  const segments = posixPath.split('/');
  return segments.length === 3
    && segments[0] === '.github'
    && segments[1] === 'workflows';
}

function findConfigLanguage(ext: string, config: ClassifyConfig): string | null {
  for (const [lang, { extensions }] of Object.entries(config.languages)) {
    for (const e of extensions) {
      const normalized = (e.startsWith('.') ? e : `.${e}`).toLowerCase();
      if (normalized === ext) return lang;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/classify.test.ts`
Expected: PASS — all 14 cases.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/workspace/classify.ts tests/classify.test.ts
git commit -m "feat(workspace): add classifyPath() + FileKind tagged union"
```

---

### Task 2: Migrate scanner to consume `classifyPath()`

**Files:**
- Modify: `src/workspace/scanner.ts` (lines 9-24 `DEFAULT_EXTENSIONS`, lines 39-44 `ScanOptions`, lines 81-83 + 164-166 classification, lines 234-245 `buildExtraExtensions`)

- [ ] **Step 1: Write the failing test**

The test here is the existing `tests/workspace.test.ts` suite with migrated call sites. Open `tests/workspace.test.ts` and migrate:

1. Update the import line (line 8):
```typescript
// Before:
import { scanDirectory, buildExtraExtensions } from '../src/workspace/scanner.js';
// After:
import { scanDirectory } from '../src/workspace/scanner.js';
```

2. Every `scanDirectory` call site (6 sites; lines 230, 248, 263, 278, 293, 317 in the file) gets a `languages: {}` field. Example for lines 230-234:
```typescript
// Before:
const files = scanDirectory(dir, matcher, {
  maxFileSize: 1_048_576,
  minifiedLineLength: 500,
});
// After:
const files = scanDirectory(dir, matcher, {
  maxFileSize: 1_048_576,
  minifiedLineLength: 500,
  languages: {},
});
```

3. Replace lines 317-321:
```typescript
// Before:
const files = scanDirectory(dir, matcher, {
  maxFileSize: 1_048_576,
  minifiedLineLength: 500,
  extraExtensions: { '.prisma': 'prisma' },
});
// After:
const files = scanDirectory(dir, matcher, {
  maxFileSize: 1_048_576,
  minifiedLineLength: 500,
  languages: { prisma: { extensions: ['.prisma'] } },
});
```

4. Delete the `'builds extra extensions from config'` test (lines 303-311).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/workspace.test.ts`
Expected: FAIL — the new `languages` option isn't read by scanner yet; build also fails because `buildExtraExtensions` import was removed.

- [ ] **Step 3: Rewrite `src/workspace/scanner.ts`**

Replace the file with:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IgnoreMatcher } from './ignores.js';
import { classifyPath } from './classify.js';
import type { ClassifyConfig } from './classify.js';

export interface ScannedFile {
  /** POSIX-relative path from root, original case */
  path: string;
  /** Absolute path on disk */
  absolutePath: string;
  /** Detected language */
  language: string;
  /** File stat mtime (epoch ms as float) */
  mtime: number;
  /** File size in bytes */
  size: number;
}

export interface ScanOptions {
  maxFileSize: number;
  minifiedLineLength: number;
  /** Resolved .nexus.json language overrides (forwarded to classifyPath). */
  languages: Record<string, { extensions: string[] }>;
}

function scanWithGit(
  rootDir: string,
  classifyConfig: ClassifyConfig,
  options: ScanOptions,
): ScannedFile[] | null {
  const root = path.resolve(rootDir);

  try {
    fs.statSync(path.join(root, '.git'));
  } catch {
    return null;
  }

  try {
    const output = execFileSync('git', [
      'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ], {
      cwd: root,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const files = output.split('\0').filter(f => f.length > 0);
    const results: ScannedFile[] = [];

    for (const relativePath of files) {
      const posixPath = relativePath.replace(/\\/g, '/');
      const basename = path.basename(posixPath);
      const kind = classifyPath(posixPath, basename, classifyConfig);
      if (kind.kind !== 'source') continue;

      const fullPath = path.join(root, relativePath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (!stat.isFile()) continue;
      if (stat.size > options.maxFileSize) continue;
      if (stat.size > 1024 && isMinified(fullPath, stat.size, options.minifiedLineLength)) continue;

      results.push({
        path: posixPath,
        absolutePath: fullPath,
        language: kind.language,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    }

    return results;
  } catch {
    return null;
  }
}

/**
 * Recursively scan a directory for indexable source files.
 * Tries git ls-files first for speed, falls back to directory walk.
 * Classification is delegated to classifyPath(); non-source kinds are skipped.
 */
export function scanDirectory(
  rootDir: string,
  isIgnored: IgnoreMatcher,
  options: ScanOptions,
): ScannedFile[] {
  const root = path.resolve(rootDir);
  const classifyConfig: ClassifyConfig = { languages: options.languages };

  const gitResult = scanWithGit(root, classifyConfig, options);
  if (gitResult !== null) return gitResult;

  const results: ScannedFile[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (!isIgnored(relativePath, true)) {
          walk(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (isIgnored(relativePath, false)) continue;

      const kind = classifyPath(relativePath, entry.name, classifyConfig);
      if (kind.kind !== 'source') continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.size > options.maxFileSize) continue;
      if (stat.size > 1024 && isMinified(fullPath, stat.size, options.minifiedLineLength)) {
        continue;
      }

      results.push({
        path: relativePath,
        absolutePath: fullPath,
        language: kind.language,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    }
  }

  walk(root);
  return results;
}

/**
 * Detect if a file is likely minified.
 * Heuristic: avg line length > threshold OR < 5 newlines per 10KB.
 */
function isMinified(filePath: string, fileSize: number, threshold: number): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(Math.min(fileSize, 10_240));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);

    const content = buffer.toString('utf-8');
    const newlines = content.split('\n').length - 1;

    if (newlines === 0) return fileSize > 1024;

    const avgLineLength = content.length / (newlines + 1);
    if (avgLineLength > threshold) return true;
    if (newlines < 5 && fileSize >= 10_240) return true;

    return false;
  } catch {
    return false;
  }
}
```

Note: `DEFAULT_EXTENSIONS` and `buildExtraExtensions` are gone — both now live in `classify.ts`.

- [ ] **Step 4: Update orchestrator call site**

Edit `src/index/orchestrator.ts`:

Line 11 (import):
```typescript
// Before:
import { scanDirectory, buildExtraExtensions } from '../workspace/scanner.js';
// After:
import { scanDirectory } from '../workspace/scanner.js';
```

Lines 87-93 (scan call):
```typescript
// Before:
const isIgnored = buildIgnoreMatcher(rootDir, config.exclude);
const extraExt = buildExtraExtensions(config.languages);
const scannedFiles = scanDirectory(rootDir, isIgnored, {
  maxFileSize: config.maxFileSize,
  minifiedLineLength: config.minifiedLineLength,
  extraExtensions: extraExt,
});
// After:
const isIgnored = buildIgnoreMatcher(rootDir, config.exclude);
const scannedFiles = scanDirectory(rootDir, isIgnored, {
  maxFileSize: config.maxFileSize,
  minifiedLineLength: config.minifiedLineLength,
  languages: config.languages,
});
```

- [ ] **Step 5: Update `src/index.ts` re-exports**

Line 13:
```typescript
// Before:
export { scanDirectory, buildExtraExtensions } from './workspace/scanner.js';
// After:
export { scanDirectory } from './workspace/scanner.js';
export { classifyPath, DEFAULT_EXTENSIONS } from './workspace/classify.js';
export type { FileKind, ClassifyConfig } from './workspace/classify.js';
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: PASS — all existing tests + new classify suite.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/workspace/scanner.ts src/index/orchestrator.ts src/index.ts tests/workspace.test.ts
git commit -m "refactor(scanner): consume classifyPath() and drop buildExtraExtensions"
```

---

### Task 3: Add parser dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the three deps**

Run:
```bash
npm install --save jsonc-parser yaml smol-toml
```

Expected output: three packages added under `dependencies`, `package-lock.json` updated.

- [ ] **Step 2: Verify the deps landed**

Run: `node -e "const p = require('./package.json'); console.log(p.dependencies['jsonc-parser'], p.dependencies.yaml, p.dependencies['smol-toml'])"`
Expected: three semver-prefixed version strings (not `undefined`).

- [ ] **Step 3: Build + smoke test imports**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(deps): add jsonc-parser, yaml, smol-toml for document parsers"
```

---

### Task 4: JSON-family parsers — `parsePackageJson`, `parseTsconfig`, `parseGenericJson`

**Files:**
- Create: `src/analysis/documents/package-json.ts`
- Create: `src/analysis/documents/tsconfig.ts`
- Create: `src/analysis/documents/generic-json.ts`
- Create: `tests/documents.test.ts` (new test file; will grow in later tasks)

- [ ] **Step 1: Write failing tests**

Create `tests/documents.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parsePackageJson } from '../src/analysis/documents/package-json.js';
import { parseTsconfig } from '../src/analysis/documents/tsconfig.js';
import { parseGenericJson } from '../src/analysis/documents/generic-json.js';

describe('parsePackageJson', () => {
  it('extracts name, version, deps, scripts', () => {
    const result = parsePackageJson(JSON.stringify({
      name: 'foo',
      version: '1.2.3',
      dependencies: { a: '^1.0.0' },
      devDependencies: { b: '^2.0.0' },
      peerDependencies: { c: '^3.0.0' },
      scripts: { test: 'vitest' },
      workspaces: ['packages/*'],
    }));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.name).toBe('foo');
    expect(result.version).toBe('1.2.3');
    expect(result.dependencies).toEqual({ a: '^1.0.0' });
    expect(result.devDependencies).toEqual({ b: '^2.0.0' });
    expect(result.peerDependencies).toEqual({ c: '^3.0.0' });
    expect(result.scripts).toEqual({ test: 'vitest' });
    expect(result.workspaces).toEqual(['packages/*']);
  });

  it('supports object-form workspaces', () => {
    const result = parsePackageJson(JSON.stringify({
      workspaces: { packages: ['apps/*'] },
    }));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.workspaces).toEqual({ packages: ['apps/*'] });
  });

  it('returns { error } on malformed JSON', () => {
    const r = parsePackageJson('{ not valid');
    expect('error' in r).toBe(true);
  });

  it('returns { error } on non-object root', () => {
    const r = parsePackageJson('42');
    expect('error' in r).toBe(true);
  });
});

describe('parseTsconfig', () => {
  it('tolerates line comments and trailing commas', () => {
    const src = `{
      // top-level comment
      "extends": "./base.json",
      "compilerOptions": {
        "strict": true,
        "target": "ES2022", /* inline */
      },
      "include": ["src/**/*"],
    }`;
    const r = parseTsconfig(src);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.extends).toBe('./base.json');
    expect(r.compilerOptions).toEqual({ strict: true, target: 'ES2022' });
    expect(r.include).toEqual(['src/**/*']);
  });

  it('extracts references and files', () => {
    const src = `{
      "files": ["a.ts"],
      "references": [{ "path": "../pkg-a" }, { "path": "../pkg-b" }]
    }`;
    const r = parseTsconfig(src);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.files).toEqual(['a.ts']);
    expect(r.references).toEqual([{ path: '../pkg-a' }, { path: '../pkg-b' }]);
  });

  it('returns { error } on syntactic garbage', () => {
    const r = parseTsconfig('{ "x": }');
    expect('error' in r).toBe(true);
  });
});

describe('parseGenericJson', () => {
  it('round-trips arbitrary nested structures', () => {
    const src = JSON.stringify({ a: [1, 2, { b: 'x' }], c: null });
    const r = parseGenericJson(src);
    expect(r).toEqual({ a: [1, 2, { b: 'x' }], c: null });
  });

  it('tolerates comments (JSONC)', () => {
    const r = parseGenericJson('{ /* c */ "a": 1, }');
    expect(r).toEqual({ a: 1 });
  });

  it('returns { error } on malformed input', () => {
    const r = parseGenericJson('{ not json');
    expect(r && typeof r === 'object' && 'error' in r).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/documents.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Implement `package-json.ts`**

Create `src/analysis/documents/package-json.ts`:

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

export type ParseError = { error: string };

export function parsePackageJson(content: string): ParsedPackageJson | ParseError {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'package.json root must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const result: ParsedPackageJson = {};
  if (typeof obj.name === 'string') result.name = obj.name;
  if (typeof obj.version === 'string') result.version = obj.version;
  if (isStringMap(obj.dependencies)) result.dependencies = obj.dependencies;
  if (isStringMap(obj.devDependencies)) result.devDependencies = obj.devDependencies;
  if (isStringMap(obj.peerDependencies)) result.peerDependencies = obj.peerDependencies;
  if (isStringMap(obj.scripts)) result.scripts = obj.scripts;
  if (Array.isArray(obj.workspaces) && obj.workspaces.every(w => typeof w === 'string')) {
    result.workspaces = obj.workspaces as string[];
  } else if (isWorkspacesObject(obj.workspaces)) {
    result.workspaces = obj.workspaces;
  }
  return result;
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(x => typeof x === 'string');
}

function isWorkspacesObject(v: unknown): v is { packages: string[] } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = (v as { packages?: unknown }).packages;
  return Array.isArray(p) && p.every(x => typeof x === 'string');
}
```

- [ ] **Step 4: Implement `tsconfig.ts`**

Create `src/analysis/documents/tsconfig.ts`:

```typescript
import { parse as parseJsonc, ParseError as JsoncParseError } from 'jsonc-parser';

export interface ParsedTsconfig {
  extends?: string | string[];
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
  files?: string[];
  references?: { path: string }[];
}

export type ParseError = { error: string };

export function parseTsconfig(content: string): ParsedTsconfig | ParseError {
  const errors: JsoncParseError[] = [];
  const raw = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    return { error: `tsconfig JSONC parse error (${errors.length})` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'tsconfig root must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const result: ParsedTsconfig = {};
  if (typeof obj.extends === 'string') result.extends = obj.extends;
  else if (Array.isArray(obj.extends) && obj.extends.every(x => typeof x === 'string')) {
    result.extends = obj.extends as string[];
  }
  if (typeof obj.compilerOptions === 'object' && obj.compilerOptions !== null && !Array.isArray(obj.compilerOptions)) {
    result.compilerOptions = obj.compilerOptions as Record<string, unknown>;
  }
  if (Array.isArray(obj.include) && obj.include.every(x => typeof x === 'string')) {
    result.include = obj.include as string[];
  }
  if (Array.isArray(obj.exclude) && obj.exclude.every(x => typeof x === 'string')) {
    result.exclude = obj.exclude as string[];
  }
  if (Array.isArray(obj.files) && obj.files.every(x => typeof x === 'string')) {
    result.files = obj.files as string[];
  }
  if (Array.isArray(obj.references)) {
    const refs: { path: string }[] = [];
    for (const r of obj.references) {
      if (typeof r === 'object' && r !== null && typeof (r as { path?: unknown }).path === 'string') {
        refs.push({ path: (r as { path: string }).path });
      }
    }
    if (refs.length > 0) result.references = refs;
  }
  return result;
}
```

- [ ] **Step 5: Implement `generic-json.ts`**

Create `src/analysis/documents/generic-json.ts`:

```typescript
import { parse as parseJsonc, ParseError as JsoncParseError } from 'jsonc-parser';

export type ParseError = { error: string };

export function parseGenericJson(content: string): unknown | ParseError {
  const errors: JsoncParseError[] = [];
  const raw = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    return { error: `JSON parse error (${errors.length})` };
  }
  return raw;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- tests/documents.test.ts`
Expected: PASS — 10 cases for the JSON family.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/analysis/documents/package-json.ts src/analysis/documents/tsconfig.ts src/analysis/documents/generic-json.ts tests/documents.test.ts
git commit -m "feat(documents): JSON-family parsers (package.json, tsconfig, generic JSON)"
```

---

### Task 5: YAML parsers — `parseGhaWorkflow`, `parseGenericYaml`

**Files:**
- Create: `src/analysis/documents/gha-workflow.ts`
- Create: `src/analysis/documents/generic-yaml.ts`
- Modify: `tests/documents.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

Append to `tests/documents.test.ts`:

```typescript
import { parseGhaWorkflow } from '../src/analysis/documents/gha-workflow.js';
import { parseGenericYaml } from '../src/analysis/documents/generic-yaml.js';

describe('parseGhaWorkflow', () => {
  it('extracts name, jobs, and steps', () => {
    const src = `
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Build
        run: npm run build
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`;
    const r = parseGhaWorkflow(src);
    if ('error' in r) throw new Error(r.error);
    expect(r.name).toBe('CI');
    expect(r.jobs?.test?.['runs-on']).toBe('ubuntu-latest');
    expect(r.jobs?.test?.steps).toHaveLength(2);
    expect(r.jobs?.test?.steps?.[0].uses).toBe('actions/checkout@v4');
    expect(r.jobs?.lint?.steps?.[0].run).toBe('npm run lint');
  });

  it('returns { error } on malformed YAML', () => {
    // Block mapping with inconsistent indentation that the yaml lib rejects.
    const r = parseGhaWorkflow('a: 1\n b: 2\n  c: 3\n\t- not yaml');
    expect('error' in r).toBe(true);
  });
});

describe('parseGenericYaml', () => {
  it('round-trips nested structures', () => {
    const r = parseGenericYaml('a:\n  - 1\n  - 2\nb:\n  c: x\n');
    expect(r).toEqual({ a: [1, 2], b: { c: 'x' } });
  });

  it('returns { error } on malformed YAML', () => {
    const r = parseGenericYaml(': : : :');
    expect(r && typeof r === 'object' && 'error' in (r as object)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/documents.test.ts`
Expected: FAIL — YAML modules don't exist.

- [ ] **Step 3: Implement `gha-workflow.ts`**

Create `src/analysis/documents/gha-workflow.ts`:

```typescript
import { parse as parseYaml } from 'yaml';

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

export type ParseError = { error: string };

export function parseGhaWorkflow(content: string): ParsedGhaWorkflow | ParseError {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid YAML' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'workflow root must be a mapping' };
  }
  const obj = raw as Record<string, unknown>;
  const result: ParsedGhaWorkflow = {};
  if (typeof obj.name === 'string') result.name = obj.name;
  if ('on' in obj) result.on = obj.on;
  if (typeof obj.jobs === 'object' && obj.jobs !== null && !Array.isArray(obj.jobs)) {
    const jobs: NonNullable<ParsedGhaWorkflow['jobs']> = {};
    for (const [jobId, jobRaw] of Object.entries(obj.jobs as Record<string, unknown>)) {
      if (typeof jobRaw !== 'object' || jobRaw === null || Array.isArray(jobRaw)) continue;
      const j = jobRaw as Record<string, unknown>;
      const job: NonNullable<ParsedGhaWorkflow['jobs']>[string] = {};
      if (typeof j['runs-on'] === 'string') job['runs-on'] = j['runs-on'] as string;
      else if (Array.isArray(j['runs-on']) && (j['runs-on'] as unknown[]).every(x => typeof x === 'string')) {
        job['runs-on'] = j['runs-on'] as string[];
      }
      if (Array.isArray(j.steps)) {
        const steps: NonNullable<NonNullable<ParsedGhaWorkflow['jobs']>[string]['steps']> = [];
        for (const s of j.steps as unknown[]) {
          if (typeof s !== 'object' || s === null || Array.isArray(s)) continue;
          const step = s as Record<string, unknown>;
          const item: { name?: string; uses?: string; run?: string } = {};
          if (typeof step.name === 'string') item.name = step.name;
          if (typeof step.uses === 'string') item.uses = step.uses;
          if (typeof step.run === 'string') item.run = step.run;
          steps.push(item);
        }
        job.steps = steps;
      }
      jobs[jobId] = job;
    }
    result.jobs = jobs;
  }
  return result;
}
```

- [ ] **Step 4: Implement `generic-yaml.ts`**

Create `src/analysis/documents/generic-yaml.ts`:

```typescript
import { parse as parseYaml } from 'yaml';

export type ParseError = { error: string };

export function parseGenericYaml(content: string): unknown | ParseError {
  try {
    return parseYaml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid YAML' };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/documents.test.ts`
Expected: PASS — cumulative cases for JSON + YAML.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/analysis/documents/gha-workflow.ts src/analysis/documents/generic-yaml.ts tests/documents.test.ts
git commit -m "feat(documents): YAML parsers (GHA workflow, generic YAML)"
```

---

### Task 6: TOML parsers — `parseCargoToml`, `parseGenericToml`

**Files:**
- Create: `src/analysis/documents/cargo-toml.ts`
- Create: `src/analysis/documents/generic-toml.ts`
- Modify: `tests/documents.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/documents.test.ts`:

```typescript
import { parseCargoToml } from '../src/analysis/documents/cargo-toml.js';
import { parseGenericToml } from '../src/analysis/documents/generic-toml.js';

describe('parseCargoToml', () => {
  it('extracts [package] and [dependencies]', () => {
    const src = `
[package]
name = "my-crate"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = "1.0"
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
criterion = "0.5"
`;
    const r = parseCargoToml(src);
    if ('error' in r) throw new Error(r.error);
    expect(r.package?.name).toBe('my-crate');
    expect(r.package?.version).toBe('0.1.0');
    expect(r.package?.edition).toBe('2021');
    expect(r.dependencies?.serde).toBe('1.0');
    expect(r['dev-dependencies']?.criterion).toBe('0.5');
  });

  it('extracts [workspace].members', () => {
    const src = `
[workspace]
members = ["crates/a", "crates/b"]
`;
    const r = parseCargoToml(src);
    if ('error' in r) throw new Error(r.error);
    expect(r.workspace?.members).toEqual(['crates/a', 'crates/b']);
  });

  it('returns { error } on malformed TOML', () => {
    const r = parseCargoToml('[[[[bad');
    expect('error' in r).toBe(true);
  });
});

describe('parseGenericToml', () => {
  it('round-trips arbitrary structures', () => {
    const r = parseGenericToml('title = "t"\n[table]\nkey = 1\n');
    expect(r).toEqual({ title: 't', table: { key: 1 } });
  });

  it('returns { error } on malformed TOML', () => {
    const r = parseGenericToml('[[[[bad');
    expect(r && typeof r === 'object' && 'error' in (r as object)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/documents.test.ts`
Expected: FAIL — TOML modules don't exist.

- [ ] **Step 3: Implement `cargo-toml.ts`**

Create `src/analysis/documents/cargo-toml.ts`:

```typescript
import { parse as parseToml } from 'smol-toml';

export interface ParsedCargoToml {
  package?: { name?: string; version?: string; edition?: string };
  dependencies?: Record<string, unknown>;
  'dev-dependencies'?: Record<string, unknown>;
  workspace?: { members?: string[] };
}

export type ParseError = { error: string };

export function parseCargoToml(content: string): ParsedCargoToml | ParseError {
  let raw: unknown;
  try {
    raw = parseToml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid TOML' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'Cargo.toml root must be a table' };
  }
  const obj = raw as Record<string, unknown>;
  const result: ParsedCargoToml = {};
  if (typeof obj.package === 'object' && obj.package !== null && !Array.isArray(obj.package)) {
    const pkg = obj.package as Record<string, unknown>;
    const p: ParsedCargoToml['package'] = {};
    if (typeof pkg.name === 'string') p.name = pkg.name;
    if (typeof pkg.version === 'string') p.version = pkg.version;
    if (typeof pkg.edition === 'string') p.edition = pkg.edition;
    result.package = p;
  }
  if (typeof obj.dependencies === 'object' && obj.dependencies !== null && !Array.isArray(obj.dependencies)) {
    result.dependencies = obj.dependencies as Record<string, unknown>;
  }
  if (typeof obj['dev-dependencies'] === 'object' && obj['dev-dependencies'] !== null && !Array.isArray(obj['dev-dependencies'])) {
    result['dev-dependencies'] = obj['dev-dependencies'] as Record<string, unknown>;
  }
  if (typeof obj.workspace === 'object' && obj.workspace !== null && !Array.isArray(obj.workspace)) {
    const ws = obj.workspace as Record<string, unknown>;
    const w: ParsedCargoToml['workspace'] = {};
    if (Array.isArray(ws.members) && ws.members.every(x => typeof x === 'string')) {
      w.members = ws.members as string[];
    }
    result.workspace = w;
  }
  return result;
}
```

- [ ] **Step 4: Implement `generic-toml.ts`**

Create `src/analysis/documents/generic-toml.ts`:

```typescript
import { parse as parseToml } from 'smol-toml';

export type ParseError = { error: string };

export function parseGenericToml(content: string): unknown | ParseError {
  try {
    return parseToml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid TOML' };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/documents.test.ts`
Expected: PASS — cumulative cases through TOML family.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/analysis/documents/cargo-toml.ts src/analysis/documents/generic-toml.ts tests/documents.test.ts
git commit -m "feat(documents): TOML parsers (Cargo.toml, generic TOML)"
```

---

### Task 7: `parseYarnLock`

**Files:**
- Create: `src/analysis/documents/yarn-lock.ts`
- Modify: `tests/documents.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/documents.test.ts`:

```typescript
import { parseYarnLock } from '../src/analysis/documents/yarn-lock.js';

describe('parseYarnLock', () => {
  it('extracts name + version from yarn v1 entries', () => {
    const src = `# yarn lockfile v1

"react@^18.0.0":
  version "18.2.0"
  resolved "https://registry.yarnpkg.com/react/-/react-18.2.0.tgz"

"lodash@^4.17.0", "lodash@^4.17.21":
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"
`;
    const r = parseYarnLock(src);
    if ('error' in r) throw new Error(r.error);
    expect(r.entries).toContainEqual({ name: 'react', version: '18.2.0' });
    expect(r.entries).toContainEqual({ name: 'lodash', version: '4.17.21' });
    expect(r.entries).toHaveLength(2);
  });

  it('handles scoped packages', () => {
    const src = `
"@types/node@^20.0.0":
  version "20.10.5"
`;
    const r = parseYarnLock(src);
    if ('error' in r) throw new Error(r.error);
    expect(r.entries).toContainEqual({ name: '@types/node', version: '20.10.5' });
  });

  it('returns empty entries for an empty lockfile', () => {
    const r = parseYarnLock('# yarn lockfile v1\n');
    if ('error' in r) throw new Error(r.error);
    expect(r.entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/documents.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `yarn-lock.ts`**

Create `src/analysis/documents/yarn-lock.ts`:

```typescript
export interface ParsedYarnLock {
  entries: { name: string; version: string }[];
}

export type ParseError = { error: string };

/**
 * Minimal yarn v1 lockfile parser. Pulls name + resolved version from each
 * block. Good enough for A3's lockfile_deps tool; not a full grammar.
 */
export function parseYarnLock(content: string): ParsedYarnLock | ParseError {
  const entries: { name: string; version: string }[] = [];

  // A block starts at column 0 with a spec line that ends in ':', and contains
  // a `  version "<v>"` line somewhere in its body. We walk lines to find
  // spec→version pairs.
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.length === 0 || line.startsWith('#') || line.startsWith(' ')) {
      i++;
      continue;
    }
    if (!line.endsWith(':')) {
      i++;
      continue;
    }

    const firstSpec = extractFirstSpec(line.slice(0, -1));
    if (!firstSpec) {
      i++;
      continue;
    }

    // Scan body for version.
    let version: string | null = null;
    let j = i + 1;
    while (j < lines.length && (lines[j].startsWith(' ') || lines[j].length === 0)) {
      const m = /^\s+version\s+"([^"]+)"/.exec(lines[j]);
      if (m) {
        version = m[1];
        break;
      }
      j++;
    }

    if (version !== null) {
      entries.push({ name: firstSpec, version });
    }
    i = j;
  }

  return { entries };
}

/**
 * A spec line can be a single quoted spec or a comma-separated list:
 *   "react@^18.0.0"
 *   "lodash@^4.17.0", "lodash@^4.17.21"
 *   react@^18.0.0
 * We extract the package name from the first spec only.
 */
function extractFirstSpec(specLine: string): string | null {
  const first = specLine.split(',')[0].trim();
  // Strip surrounding quotes.
  const unquoted = first.startsWith('"') && first.endsWith('"')
    ? first.slice(1, -1)
    : first;
  // Name is everything up to the last `@` that isn't the leading scope `@`.
  // For scoped packages (`@scope/name@range`) the package name is `@scope/name`.
  if (unquoted.startsWith('@')) {
    const slashIdx = unquoted.indexOf('/');
    if (slashIdx === -1) return null;
    const atAfterName = unquoted.indexOf('@', slashIdx);
    return atAfterName === -1 ? unquoted : unquoted.slice(0, atAfterName);
  }
  const atIdx = unquoted.indexOf('@');
  return atIdx <= 0 ? unquoted : unquoted.slice(0, atIdx);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/documents.test.ts`
Expected: PASS — all documents tests.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/documents/yarn-lock.ts tests/documents.test.ts
git commit -m "feat(documents): minimal yarn.lock parser (name + resolved version)"
```

---

### Task 8: `documents/index.ts` re-exports

**Files:**
- Create: `src/analysis/documents/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create `documents/index.ts`**

```typescript
export { parsePackageJson } from './package-json.js';
export type { ParsedPackageJson } from './package-json.js';

export { parseTsconfig } from './tsconfig.js';
export type { ParsedTsconfig } from './tsconfig.js';

export { parseGenericJson } from './generic-json.js';

export { parseGhaWorkflow } from './gha-workflow.js';
export type { ParsedGhaWorkflow } from './gha-workflow.js';

export { parseGenericYaml } from './generic-yaml.js';

export { parseCargoToml } from './cargo-toml.js';
export type { ParsedCargoToml } from './cargo-toml.js';

export { parseGenericToml } from './generic-toml.js';

export { parseYarnLock } from './yarn-lock.js';
export type { ParsedYarnLock } from './yarn-lock.js';
```

- [ ] **Step 2: Add to `src/index.ts`**

Insert after the `// Analysis` block (after line 25 `import './analysis/languages/typescript.js';` region, before `// Index orchestrator`):

```typescript
// Document parsers (structured config / lockfile helpers — consumed by A3)
export {
  parsePackageJson, parseTsconfig, parseGenericJson,
  parseGhaWorkflow, parseGenericYaml,
  parseCargoToml, parseGenericToml,
  parseYarnLock,
} from './analysis/documents/index.js';
export type {
  ParsedPackageJson, ParsedTsconfig, ParsedGhaWorkflow, ParsedCargoToml, ParsedYarnLock,
} from './analysis/documents/index.js';
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/documents/index.ts src/index.ts
git commit -m "feat(documents): public re-exports via documents/index.ts and src/index.ts"
```

---

### Task 9: Docs + final verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add CHANGELOG entry**

At the top of `CHANGELOG.md`, under the existing Unreleased block (or as a new Unreleased block), add:

```markdown
### Added
- `classifyPath()` + `FileKind` discriminated union in `src/workspace/classify.ts` — unified classification for source and structured files. Honors `.nexus.json` `languages` overrides.
- Document parser helpers under `src/analysis/documents/`: `parsePackageJson`, `parseTsconfig`, `parseGenericJson`, `parseGhaWorkflow`, `parseGenericYaml`, `parseCargoToml`, `parseGenericToml`, `parseYarnLock`. Each returns a narrow typed shape or `{ error }`; never throws.
- New runtime deps: `jsonc-parser`, `yaml`, `smol-toml`.

### Changed
- Scanner consumes `classifyPath()` instead of ad-hoc `path.extname` lookups. `ScanOptions.extraExtensions` replaced with `languages: Record<string, { extensions: string[] }>`.
- `buildExtraExtensions()` removed — `classifyPath()` consumes `config.languages` directly.

### Notes
- No new MCP tools. Parsers sit unused until A3 lands. No indexed storage, no cache (A2), no size caps (A2).
```

- [ ] **Step 2: Update `CLAUDE.md` architecture section**

Find the `src/workspace/` line in the architecture tree. Add a sub-bullet for `classify.ts`. Find `src/analysis/` and add a sub-bullet for `documents/`. Minimal edit — one or two lines per section.

Example (locate the existing `workspace/` bullet at [CLAUDE.md:11](../../../CLAUDE.md:11)):

```markdown
  workspace/       — File discovery, ignore rules, change detection, file-kind classification
```

And under `analysis/`:

```markdown
  analysis/        — Tree-sitter parsing + per-language symbol extractors
    languages/     — Adapters: typescript, python, go, rust, java, csharp, css
    documents/     — Structured-file parsers: package.json, tsconfig, Cargo.toml, GHA YAML, lockfiles (consumed by A3 tools)
    registry.ts    — Adapter registration (side-effect imports in entry points)
```

- [ ] **Step 3: Full verification pass**

Run each:

```bash
npm run build
npm run lint
npm test
```

Expected: build clean, `tsc --noEmit` clean, all tests pass (original count + ~30 new — ~15 classify + ~15 documents).

- [ ] **Step 4: Self-re-index**

```bash
npx --no -- nexus rebuild
npx --no -- nexus stats
```

Expected: full rebuild succeeds (no schema bump this time — so this is just a sanity check that the refactored scanner still finds the same file set).

- [ ] **Step 5: Commit docs**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: A1 classifyPath + document parsers in CHANGELOG and architecture"
```

- [ ] **Step 6: Final status check**

```bash
git log --oneline main..HEAD
git status
```

Expected: 9 feat/refactor/build/docs commits on top of main's merge base; clean working tree. Branch ready for PR.

---

## Notes for the Implementing Engineer

- **Pure refactor, no behavior change.** The scanner must index exactly the same file set before vs. after this plan. If the file count changes on the Nexus self-index, investigate — something is wrong.
- **`classifyPath()` is the single source of truth.** Don't sprinkle ad-hoc extension checks elsewhere. If a new consumer needs to ask "what kind of file is this?", they import `classifyPath`.
- **Parsers never throw.** The whole point of the `ParseError` return type is that callers never need a `try/catch`. If you find yourself catching an exception from `parseX`, the parser has a bug.
- **Narrow shapes, not full schemas.** `ParsedPackageJson` exposes the fields A3 will ask about — not every npm schema field. Unknown fields are dropped from the typed surface. Don't chase completeness; YAGNI.
- **`jsonc-parser`'s `parse()` accepts options.** `{ allowTrailingComma: true, disallowComments: false }` is the tsconfig-compatible default. Don't enable `allowEmptyContent` — empty `{}` is still valid JSON.
- **`yaml` lib quirk:** empty documents parse to `null`, not `{}`. A workflow file that's just whitespace returns `null` from `parseYaml` — the tsconfig-style guard `typeof raw !== 'object' || raw === null` covers this.

## Success Criteria Checklist

- [ ] `classifyPath()` passes all 14 unit tests including config-override regression.
- [ ] Scanner indexes the same file set before vs. after on a representative repo (Nexus self-index: `nexus stats` file count unchanged).
- [ ] All seven parsers round-trip a happy-path fixture and return `{ error }` on malformed input.
- [ ] `jsonc-parser`, `yaml`, `smol-toml` appear under `dependencies` in `package.json`; lockfile committed.
- [ ] `npm run build`, `npm run lint`, `npm test` all clean.
- [ ] CHANGELOG and CLAUDE.md updated.
- [ ] No new MCP tools, no cache, no size caps (those are A2/A3).
