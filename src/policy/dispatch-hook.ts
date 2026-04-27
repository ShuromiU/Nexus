/**
 * Shared hook-dispatch logic used by both `nexus-policy-check` and
 * `nexus-hook` bins. Stays small: only depends on policy + DB + workspace.
 * Does NOT import Commander, formatters, or analysis adapters.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectRoot, resolveRoot } from '../workspace/detector.js';
import { dispatchPolicy } from './dispatcher.js';
import { DEFAULT_RULES } from './index.js';
import type { PolicyEvent, PolicyResponse, QueryEngineLike } from './types.js';
import { openDatabase } from '../db/schema.js';
import {
  openTelemetryDb,
  closeTelemetryDb,
  pruneIfDue,
  recordOptOutTransition,
} from './telemetry.js';
import { isTelemetryEnabled, computeInputHash } from './telemetry-config.js';

export function readStdinSync(): string {
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(65536);
    for (;;) {
      let n = 0;
      try {
        n = fs.readSync(0, buf, 0, buf.length, null);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN') continue;
        break;
      }
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch {
    return '';
  }
}

function parseEvent(raw: string): PolicyEvent | null {
  try {
    const obj = JSON.parse(raw) as Partial<PolicyEvent>;
    if (typeof obj.tool_name !== 'string') return null;
    const hasToolResponse = obj.tool_response && typeof obj.tool_response === 'object';
    return {
      hook_event_name: typeof obj.hook_event_name === 'string' ? obj.hook_event_name : 'PreToolUse',
      tool_name: obj.tool_name,
      tool_input: (obj.tool_input ?? {}) as Record<string, unknown>,
      ...(hasToolResponse
        ? { tool_response: obj.tool_response as Record<string, unknown> }
        : {}),
      session_id: typeof obj.session_id === 'string' ? obj.session_id : undefined,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Open a read-only QueryEngine if the index exists at `<rootDir>/.nexus/index.db`.
 * Returns undefined if the index is missing or unopenable. Lazy-loads QueryEngine
 * via dynamic import to keep the cold-start cost off the Grep-only hot path.
 */
async function tryOpenEngineLazy(rootDir: string): Promise<QueryEngineLike | undefined> {
  try {
    const dbPath = path.join(rootDir, '.nexus', 'index.db');
    if (!fs.existsSync(dbPath)) return undefined;
    const db = openDatabase(dbPath, { readonly: true });
    const { QueryEngine } = await import('../query/engine.js');
    return new QueryEngine(db) as unknown as QueryEngineLike;
  } catch {
    return undefined;
  }
}

/**
 * Translate a `PolicyResponse` into the Claude Code hook envelope shape
 * (`{ hookSpecificOutput: { hookEventName, permissionDecision?, permissionDecisionReason?, additionalContext? } }`).
 *
 * Returns an empty string when the response has nothing actionable for Claude
 * Code (e.g. plain `allow` with no `additional_context`). Callers SHOULD skip
 * writing to stdout when this returns `''` — Claude Code treats no output as
 * "no opinion / proceed."
 *
 * `nexus-policy-check` keeps emitting the flat `PolicyResponse` shape for the
 * legacy bash wrapper that wraps it via `jq`. This helper exists for the new
 * `nexus-hook` bin, which is invoked DIRECTLY by Claude Code with no wrapper.
 */
export function formatHookEnvelope(
  response: PolicyResponse,
  hookEventName: 'PreToolUse' | 'PostToolUse',
): string {
  if (hookEventName === 'PreToolUse') {
    if (response.decision === 'deny' || response.decision === 'ask') {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: response.decision,
          permissionDecisionReason: response.reason ?? '',
        },
      });
    }
    if (response.decision === 'allow' && response.additional_context) {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: 'allow',
          additionalContext: response.additional_context,
        },
      });
    }
    return '';
  }

  if (response.additional_context) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext: response.additional_context,
      },
    });
  }
  return '';
}

/**
 * Compute the bare `PolicyResponse` for a hook payload. Used by both
 * `runPolicyHook` (which stringifies it for the legacy bash wrapper) and
 * `nexus-hook`, which wraps it into the Claude Code `hookSpecificOutput`
 * envelope via `formatHookEnvelope`.
 */
export async function computePolicyResponse(rawStdin: string): Promise<PolicyResponse> {
  const event = parseEvent(rawStdin);
  if (!event) {
    return {
      decision: 'allow',
      rule: 'parse-error',
      reason: 'malformed hook payload',
      stale_hint: false,
    };
  }

  const cwd = event.cwd ?? resolveRoot().startDir;
  let rootDir: string;
  try {
    rootDir = detectRoot(cwd);
  } catch {
    rootDir = cwd;
  }

  const enabled = isTelemetryEnabled(rootDir);
  recordOptOutTransition(rootDir, enabled);
  const telemetryDb = enabled ? openTelemetryDb(rootDir) : null;
  if (telemetryDb) {
    try { pruneIfDue(telemetryDb); } catch { /* swallow */ }
  }
  const inputHash = computeInputHash(event.tool_input);

  // Engine open is lazy: rules that need it pull QueryEngine on demand.
  // For now we open eagerly only if the index file exists, but the import
  // happens after the cheap fs.existsSync check, so pure-Grep events still
  // skip QueryEngine entirely if the index is missing.
  const queryEngine = await tryOpenEngineLazy(rootDir);

  try {
    return dispatchPolicy(event, {
      rootDir,
      rules: DEFAULT_RULES,
      ...(queryEngine ? { queryEngine } : {}),
      ...(telemetryDb ? { telemetryDb } : {}),
      inputHash,
    });
  } finally {
    if (telemetryDb) closeTelemetryDb(telemetryDb);
  }
}

/**
 * Drive a Pre/Post tool-use policy dispatch from a raw stdin payload, returning
 * the JSON response body to write to stdout. Always returns a valid response —
 * malformed input becomes `decision: allow` so the hook never blocks the user
 * accidentally.
 */
export async function runPolicyHook(rawStdin: string): Promise<string> {
  const response = await computePolicyResponse(rawStdin);
  return JSON.stringify(response);
}
