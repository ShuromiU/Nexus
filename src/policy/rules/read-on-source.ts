import * as path from 'node:path';
import type { PolicyRule } from '../types.js';
import { classifyPath } from '../../workspace/classify.js';
import { NON_CODE_PATH } from './common-paths.js';

const EMPTY_CONFIG = { languages: {} };

const CONTEXT =
  'This file is indexed by Nexus. Prefer nexus_outline(file) to see ' +
  'structure + signatures, or nexus_source(symbol, file) for a specific ' +
  "symbol. Fall back to Read if those don't answer the question. " +
  'The policy response includes stale_hint — if true, the index may lag ' +
  'recent edits to this file.';

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
  evaluate(event) {
    if (event.tool_name !== 'Read') return null;

    const input = event.tool_input;
    if (input.offset !== undefined) return null;
    if (input.limit !== undefined) return null;

    const raw = input.file_path;
    if (typeof raw !== 'string' || raw.length === 0) return null;

    const normalized = raw.replace(/\\/g, '/');
    if (NON_CODE_PATH.test(normalized)) return null;

    const basename = path.posix.basename(normalized);
    if (basename.length === 0) return null;

    let kind;
    try {
      kind = classifyPath(normalized, basename, EMPTY_CONFIG);
    } catch {
      return null;
    }
    if (kind.kind !== 'source') return null;

    return { decision: 'allow', rule: 'read-on-source', additional_context: CONTEXT };
  },
};
