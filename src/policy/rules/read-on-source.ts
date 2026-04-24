import * as path from 'node:path';
import type { PolicyRule } from '../types.js';
import { classifyPath } from '../../workspace/classify.js';
import { NON_CODE_PATH } from './common-paths.js';

const EMPTY_CONFIG = { languages: {} };

const CONTEXT =
  'This file is indexed by Nexus. Prefer nexus_outline(file) to see ' +
  'structure + signatures, or nexus_source(symbol, file) for a specific ' +
  "symbol. Fall back to Read if those don't answer the question.";

/**
 * Bare Read on an indexed source file → allow, but inject a nudge via
 * `additional_context` pointing at nexus_outline / nexus_source. Never asks
 * or denies — this rule is advisory only.
 *
 * Skips:
 *   - non-Read events
 *   - paginated reads (offset or limit present, including falsy values)
 *   - excluded paths (node_modules, .git, .nexus, docs/, .env, .claude/)
 *   - non-source kinds (structured configs, lockfiles, README.md, etc.)
 *
 * No DB access — classification is purely path-based. "Is this indexed?" is
 * not checked; stale_hint (computed by the dispatcher) advertises the lag.
 */
export const readOnSourceRule: PolicyRule = {
  name: 'read-on-source',
  evaluate(event, ctx) {
    if (event.tool_name !== 'Read') return null;

    const input = event.tool_input;
    if (input.offset !== undefined) return null;
    if (input.limit !== undefined) return null;

    const raw = input.file_path;
    if (typeof raw !== 'string' || raw.length === 0) return null;

    const normalized = raw.replace(/\\/g, '/');
    if (NON_CODE_PATH.test(normalized)) return null;

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

    let kind;
    try {
      kind = classifyPath(relPath, basename, EMPTY_CONFIG);
    } catch {
      return null;
    }
    if (kind.kind !== 'source') return null;

    return { decision: 'allow', rule: 'read-on-source', additional_context: CONTEXT };
  },
};
