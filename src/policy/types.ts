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
}

export interface PolicyResponse {
  decision: PolicyDecision['decision'];
  reason?: string;
  rule?: string;
  stale_hint: boolean;
}

export interface PolicyContext {
  rootDir: string;
  dbPath: string;
}

export interface PolicyRule {
  name: string;
  evaluate(event: PolicyEvent, ctx: PolicyContext): PolicyDecision | null;
}
