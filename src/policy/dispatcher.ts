import * as path from 'node:path';
import { computeStaleHint } from './stale-hint.js';
import type { PolicyEvent, PolicyResponse, PolicyRule } from './types.js';

export interface DispatchOptions {
  rootDir: string;
  rules: readonly PolicyRule[];
}

/**
 * Evaluate rules in order. The first rule that returns a decision other than
 * `noop`/`null` wins. `noop` is treated as "rule inspected but abstains" and
 * allows later rules to decide. If no rule decides, the response is `allow`.
 *
 * Always attaches `stale_hint` — the caller (PreToolUse hook) can downgrade
 * a deny to a warning on stale data if it wishes.
 */
export function dispatchPolicy(event: PolicyEvent, opts: DispatchOptions): PolicyResponse {
  const ctx = {
    rootDir: opts.rootDir,
    dbPath: path.join(opts.rootDir, '.nexus', 'index.db'),
  };

  for (const rule of opts.rules) {
    const decision = rule.evaluate(event, ctx);
    if (!decision || decision.decision === 'noop') continue;
    return {
      decision: decision.decision,
      reason: decision.reason,
      rule: decision.rule,
      ...(decision.additional_context && decision.decision !== 'deny'
        ? { additional_context: decision.additional_context }
        : {}),
      stale_hint: computeStaleHint({
        rootDir: opts.rootDir,
        touchedAbsPath: extractTouchedPath(event, opts.rootDir),
      }),
    };
  }

  return {
    decision: 'allow',
    stale_hint: computeStaleHint({
      rootDir: opts.rootDir,
      touchedAbsPath: extractTouchedPath(event, opts.rootDir),
    }),
  };
}

/**
 * Best-effort path extraction for stale_hint. Looks at common tool_input keys
 * (`file_path`, `path`). Returns undefined when no plausible path is present.
 */
function extractTouchedPath(event: PolicyEvent, rootDir: string): string | undefined {
  const input = event.tool_input;
  const candidates = ['file_path', 'path', 'notebook_path', 'file'];
  for (const key of candidates) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) {
      const normalized = v.replace(/\\/g, '/');
      return path.isAbsolute(normalized) ? normalized : path.resolve(rootDir, normalized);
    }
  }
  return undefined;
}
