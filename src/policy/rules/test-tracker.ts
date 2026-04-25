import type { PolicyRule } from '../types.js';
import { parseTestCommand } from '../evidence.js';
import { appendTestRun } from '../session-state.js';

function readExitCode(resp: unknown): number | null {
  if (!resp || typeof resp !== 'object') return null;
  const v = (resp as Record<string, unknown>).exit_code;
  return typeof v === 'number' ? v : null;
}

/**
 * `test-tracker` — PostToolUse Bash rule. When a recognised test command
 * exits 0, append a record to `.nexus/session-state.json` so the
 * evidence-summary rule can answer `tests_run_this_session`.
 *
 * Returns `noop` after the side-effect (so the dispatcher treats it as
 * non-deciding and falls through to the default `allow`). Returns `null`
 * for any path that is not a successful test run, including infrastructure
 * failures inside `appendTestRun`.
 */
export const testTrackerRule: PolicyRule = {
  name: 'test-tracker',
  evaluate(event, ctx) {
    if (event.hook_event_name !== 'PostToolUse') return null;
    if (event.tool_name !== 'Bash') return null;

    const command = event.tool_input.command;
    if (typeof command !== 'string') return null;

    const exitCode = readExitCode(event.tool_response);
    if (exitCode !== 0) return null;

    const matched = parseTestCommand(command);
    if (!matched) return null;

    const sessionId = event.session_id;
    if (!sessionId) return null;

    try {
      appendTestRun(ctx.rootDir, sessionId, {
        cmd: matched,
        ts_ms: Date.now(),
        exit: 0,
      });
    } catch {
      // never throw from a hook
    }
    return { decision: 'noop', rule: 'test-tracker' };
  },
};
