/**
 * Event shape mirrors Claude Code's PreToolUse hook JSON payload.
 * Only the fields we actually consume are typed; extra fields are tolerated.
 */
export interface PolicyEvent {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
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
    results: { callers: unknown[] }[];
  };
}

export interface PolicyContext {
  rootDir: string;
  dbPath: string;
  /** Optional DB-backed query engine. Rules that need DB access must
   *  fall open (return null) when this is undefined. */
  queryEngine?: QueryEngineLike;
}

export interface PolicyRule {
  name: string;
  evaluate(event: PolicyEvent, ctx: PolicyContext): PolicyDecision | null;
}
