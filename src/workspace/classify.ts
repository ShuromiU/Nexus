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
 * @param posixPath - workspace-relative, forward-slash path.
 * @param basename  - redundant but explicit; callers usually already have it.
 * @param config    - resolved .nexus.json config (only languages field consulted).
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

  // 3. .github/workflows/*.{yml,yaml} - direct children only.
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

/**
 * Heuristic test-file detector (B5). Path-based — does NOT inspect content.
 *
 * Returns the strength of the signal:
 *   - `declared`: filename pattern (`*.test.*`, `*.spec.*`) or `__tests__/`
 *     directory. Universally recognised by test runners (Jest, Vitest, Mocha,
 *     Karma, …) — strong signal.
 *   - `derived`: file lives under a top-level `tests/` or `test/` directory
 *     (Vitest convention) but does NOT match the declared patterns. Weaker
 *     signal: utility files, fixtures, and helpers also live here.
 *   - `null`: not a test file.
 *
 * Path is expected to be a workspace-relative POSIX path (forward slashes).
 */
export type TestConfidence = 'declared' | 'derived';

export function classifyTestPath(posixPath: string): TestConfidence | null {
  const lower = posixPath.toLowerCase();
  const segments = lower.split('/');
  const basename = segments[segments.length - 1] ?? '';

  // declared — filename pattern: *.test.* or *.spec.* (any source extension).
  // The last dot-separated segment before the final extension must be
  // exactly 'test' or 'spec'.
  const dotParts = basename.split('.');
  if (dotParts.length >= 3) {
    const tag = dotParts[dotParts.length - 2];
    if (tag === 'test' || tag === 'spec') return 'declared';
  }

  // declared — any ancestor directory named __tests__.
  if (segments.some(s => s === '__tests__')) return 'declared';

  // derived — top-level tests/ or test/ directory.
  if (segments.length >= 2 && (segments[0] === 'tests' || segments[0] === 'test')) {
    return 'derived';
  }

  return null;
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
