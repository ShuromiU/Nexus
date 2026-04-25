import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { computeStaleHint } from './stale-hint.js';
import { recordEvent } from './telemetry.js';
import type { PolicyEvent, PolicyResponse, PolicyRule, PolicyContext, QueryEngineLike } from './types.js';

export interface DispatchOptions {
  rootDir: string;
  rules: readonly PolicyRule[];
  /** Optional DB-backed engine forwarded into ctx for DB-aware rules. */
  queryEngine?: QueryEngineLike;
  /** D5 telemetry handle. When omitted, all telemetry calls are no-ops. */
  telemetryDb?: Database.Database;
  /** Canonical hash of `tool_input` (D5). Used for override correlation. */
  inputHash?: string;
}

/**
 * Evaluate rules in order. The first rule that returns a decision other than
 * `noop`/`null` wins. `noop` is treated as "rule inspected but abstains" and
 * allows later rules to decide. If no rule decides, the response is `allow`
 * and a single `noop` row is recorded (D5) so override-rate joins can detect
 * the action proceeded.
 *
 * Per-rule evaluation is wrapped in try/catch so a thrown rule cannot break
 * dispatch.
 *
 * Always attaches `stale_hint` — the caller (PreToolUse hook) can downgrade
 * a deny to a warning on stale data if it wishes.
 */
export function dispatchPolicy(event: PolicyEvent, opts: DispatchOptions): PolicyResponse {
  const ctx: PolicyContext = {
    rootDir: opts.rootDir,
    dbPath: path.join(opts.rootDir, '.nexus', 'index.db'),
    ...(opts.queryEngine ? { queryEngine: opts.queryEngine } : {}),
    ...(opts.telemetryDb ? { telemetryDb: opts.telemetryDb } : {}),
    ...(opts.inputHash ? { inputHash: opts.inputHash } : {}),
  };

  const filePath = extractTouchedPath(event, opts.rootDir);
  const hookEvent: 'PreToolUse' | 'PostToolUse' =
    event.hook_event_name === 'PostToolUse' ? 'PostToolUse' : 'PreToolUse';

  for (const rule of opts.rules) {
    const t0 = process.hrtime.bigint();
    let decision: ReturnType<PolicyRule['evaluate']> = null;
    try {
      decision = rule.evaluate(event, ctx);
    } catch {
      decision = null;
    }
    const latency_us = Number((process.hrtime.bigint() - t0) / 1000n);

    if (!decision || decision.decision === 'noop') continue;

    recordEvent(opts.telemetryDb ?? null, {
      ts_ms: Date.now(),
      session_id: event.session_id ?? null,
      hook_event: hookEvent,
      tool_name: event.tool_name,
      rule: rule.name,
      decision: decision.decision,
      latency_us,
      input_hash: opts.inputHash ?? null,
      file_path: filePath ?? null,
      payload_json: null,
    });

    return {
      decision: decision.decision,
      reason: decision.reason,
      rule: decision.rule,
      ...(decision.additional_context && decision.decision !== 'deny'
        ? { additional_context: decision.additional_context }
        : {}),
      stale_hint: computeStaleHint({
        rootDir: opts.rootDir,
        touchedAbsPath: filePath,
      }),
    };
  }

  // No rule decided — record a noop row keyed on (session_id, input_hash) so
  // V4's override-rate join can detect "the action proceeded."
  recordEvent(opts.telemetryDb ?? null, {
    ts_ms: Date.now(),
    session_id: event.session_id ?? null,
    hook_event: hookEvent,
    tool_name: event.tool_name,
    rule: null,
    decision: 'noop',
    latency_us: 0,
    input_hash: opts.inputHash ?? null,
    file_path: filePath ?? null,
    payload_json: null,
  });

  return {
    decision: 'allow',
    stale_hint: computeStaleHint({
      rootDir: opts.rootDir,
      touchedAbsPath: filePath,
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
