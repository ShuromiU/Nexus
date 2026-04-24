import * as path from 'node:path';
import type { PolicyRule } from '../types.js';
import { classifyPath, type FileKind } from '../../workspace/classify.js';

const EMPTY_CONFIG = { languages: {} };

const STRUCTURED_REASON = (kind: string) =>
  `Use nexus_structured_query or nexus_structured_outline instead of Read for ${kind}. ` +
  `These tools return the parsed value by path or a shallow outline — cheaper than reading the whole file.`;

const LOCKFILE_REASON = (kind: string) =>
  `Use nexus_lockfile_deps(file, name?) instead of Read for ${kind}. ` +
  `It returns {name, version} entries directly — no JSON/YAML/TOML walking needed.`;

/**
 * Read on a structured config / lockfile → suggest the appropriate Nexus tool.
 * Returns `decision: 'ask'` so the user gets a permission prompt with the
 * suggestion. Never denies.
 *
 * No DB I/O: classification is purely path-based via A1's classifyPath().
 */
export const readOnStructuredRule: PolicyRule = {
  name: 'read-on-structured',
  evaluate(event, ctx) {
    if (event.tool_name !== 'Read') return null;

    const raw = event.tool_input.file_path;
    if (typeof raw !== 'string' || raw.length === 0) return null;

    const normalized = raw.replace(/\\/g, '/');
    const rootDirPosix = ctx.rootDir.replace(/\\/g, '/');
    const absPath = path.posix.isAbsolute(normalized)
      ? normalized
      : path.posix.resolve(rootDirPosix || '/', normalized);
    const candidateRel = rootDirPosix
      ? path.posix.relative(rootDirPosix, absPath)
      : normalized;
    // If the path is outside rootDir (starts with '..'), fall back to the normalized
    // path — classifyPath will still make a best-effort decision based on basename.
    const relPath = candidateRel.startsWith('..') ? normalized : candidateRel;
    const basename = path.posix.basename(relPath);
    if (basename.length === 0) return null;

    let kind: FileKind;
    try {
      kind = classifyPath(relPath, basename, EMPTY_CONFIG);
    } catch {
      return null;
    }

    const reason = reasonFor(kind);
    if (reason === null) return null;

    return { decision: 'ask', rule: 'read-on-structured', reason };
  },
};

function reasonFor(kind: FileKind): string | null {
  switch (kind.kind) {
    case 'package_json':
    case 'tsconfig_json':
    case 'cargo_toml':
    case 'gha_workflow':
    case 'json_generic':
    case 'yaml_generic':
    case 'toml_generic':
      return STRUCTURED_REASON(kind.kind);
    case 'package_lock':
    case 'yarn_lock':
    case 'pnpm_lock':
    case 'cargo_lock':
      return LOCKFILE_REASON(kind.kind);
    default:
      return null;
  }
}
