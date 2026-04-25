import type { PolicyRule } from '../types.js';
import { parseGitTrigger } from '../evidence.js';

/**
 * `evidence-summary` — PreToolUse Bash rule. When the command line
 * contains a `git commit` / `git push` / `gh pr create` segment, emit
 * `allow + additional_context` summarising the affected exports, callers,
 * unused-exports, test-run status, and risk bucket of the upcoming change
 * set. Never blocks; falls open on any failure.
 *
 * Task 6 (current) ships only the skip-path skeleton. The happy path
 * (git change-set collection + caller aggregation) lands in Task 7.
 */
export const evidenceSummaryRule: PolicyRule = {
  name: 'evidence-summary',
  evaluate(event, ctx) {
    if (event.hook_event_name !== 'PreToolUse') return null;
    if (event.tool_name !== 'Bash') return null;
    const command = event.tool_input.command;
    if (typeof command !== 'string') return null;
    const trigger = parseGitTrigger(command);
    if (!trigger) return null;
    if (!ctx.queryEngine) return null;

    // Happy path implemented in Task 7. For now, fall open.
    return null;
  },
};
