import type Database from 'better-sqlite3';

/**
 * Event shape mirrors Claude Code's PreToolUse hook JSON payload.
 * Only the fields we actually consume are typed; extra fields are tolerated.
 */
export interface PolicyEvent {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  /**
   * Present on PostToolUse only. Shape varies by tool. For `Bash`,
   * Claude Code populates `{ stdout, stderr, exit_code, ... }`.
   * Untyped because no PreToolUse rule consumes it.
   */
  tool_response?: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
}

export interface PolicyDecision {
  decision: 'allow' | 'ask' | 'deny' | 'noop';
  reason?: string;
  rule?: string;
  /**
   * Optional advisory text forwarded to the assistant (via PreToolUse
   * `additionalContext`). Only meaningful when `decision` is `allow` or
   * `ask`; the dispatcher drops it on `deny`/`noop`.
   */
  additional_context?: string;
}

export interface PolicyResponse {
  decision: PolicyDecision['decision'];
  reason?: string;
  rule?: string;
  additional_context?: string;
  stale_hint: boolean;
}

export interface OutlineEntryForImpact {
  name: string;
  kind: string;
  line: number;
  /**
   * Real QueryEngine marks end_line optional on OutlineEntry. Rules that need
   * it (notably preedit-impact) must skip entries where it's missing.
   */
  end_line?: number;
  children?: OutlineEntryForImpact[];
}

export interface OutlineForImpact {
  file: string;
  exports: string[];
  outline: OutlineEntryForImpact[];
}

/**
 * Minimal surface of QueryEngine consumed by the preedit-impact rule.
 * Narrower than the real class so tests can stub without a DB. The real
 * QueryEngine satisfies this structurally (its return envelopes already
 * have `results` + `count`).
 */
export interface QueryEngineLike {
  importers(source: string): {
    results: { file: string }[];
    count: number;
  };
  outline(filePath: string): {
    results: OutlineForImpact[];
  };
  /**
   * Return envelope for "who calls `name`". The distinct-caller count lives
   * at `results[0]?.callers?.length ?? 0` — the real `QueryEngine.callers`
   * wraps a single `CallersResult` in a one-element array, so the envelope
   * `count` is always 0 or 1 (NOT the distinct-caller count). Rules must
   * compute the count from `results[0].callers.length`.
   */
  callers(
    name: string,
    opts?: { file?: string; limit?: number },
  ): {
    results: {
      callers: {
        caller?: { file?: string; line?: number };
        call_sites?: { line: number; col?: number }[];
      }[];
    }[];
  };
  /**
   * D3 evidence-summary uses this to surface exports added in the change set
   * that have no importers and no external occurrences. Real
   * `QueryEngine.unusedExports` returns `UnusedExportResult` rows
   * (`{ file, name, kind, line }`) which structurally satisfies this shape.
   */
  unusedExports(opts?: {
    path?: string;
    limit?: number;
    mode?: 'default' | 'runtime_only';
  }): {
    results: { name: string; file: string; kind: string; line: number }[];
  };
  /**
   * B6 v1.5: composed rename-safety verdict. preedit-impact upgrades its
   * crude `bucketRisk(callerCount)` to this when relation data is available
   * (extends/implements children push the bucket to `high` independently of
   * caller count). Optional so test stubs can omit it; the rule falls back
   * to bucketRisk when undefined or when the call throws.
   */
  renameSafety?: (
    name: string,
    opts?: { file?: string; new_name?: string },
  ) => {
    results: {
      risk: 'low' | 'medium' | 'high';
      reasons: string[];
      blast_radius: number;
      relations: {
        children: { count: number; kinds: Record<string, number> };
        parents: { count: number; kinds: Record<string, number> };
      };
    }[];
  };
}

export interface PolicyContext {
  rootDir: string;
  dbPath: string;
  /** Optional DB-backed query engine. Rules that need DB access must
   *  fall open (return null) when this is undefined. */
  queryEngine?: QueryEngineLike;
  /** Telemetry handle (D5). Forwarded by the dispatcher; rules ignore it. */
  telemetryDb?: Database.Database;
  /** Canonical hash of `tool_input` (D5). Undefined when telemetry disabled. */
  inputHash?: string;
}

export interface PolicyRule {
  name: string;
  evaluate(event: PolicyEvent, ctx: PolicyContext): PolicyDecision | null;
}
