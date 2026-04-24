export type {
  PolicyEvent,
  PolicyDecision,
  PolicyResponse,
  PolicyContext,
  PolicyRule,
} from './types.js';
export { dispatchPolicy } from './dispatcher.js';
export type { DispatchOptions } from './dispatcher.js';
export { computeStaleHint } from './stale-hint.js';
export { grepOnCodeRule } from './rules/grep-on-code.js';
export { readOnStructuredRule } from './rules/read-on-structured.js';
export { readOnSourceRule } from './rules/read-on-source.js';

import { grepOnCodeRule } from './rules/grep-on-code.js';
import { readOnStructuredRule } from './rules/read-on-structured.js';
import { readOnSourceRule } from './rules/read-on-source.js';
import type { PolicyRule } from './types.js';

/**
 * Default rule set shipped with Nexus. Extend in follow-up plans.
 *
 * Individual rules are accessible via deep imports, but consumers of the
 * public API should treat the concrete rule list as an implementation detail
 * and compose via `DEFAULT_RULES` (or build their own `PolicyRule[]`).
 *
 * Order: Grep checks run first (deny path, short-circuit on match), then the
 * two Read rules. The Read rules are mutually exclusive by FileKind, so the
 * order between them doesn't matter.
 */
export const DEFAULT_RULES: readonly PolicyRule[] = [
  grepOnCodeRule,
  readOnStructuredRule,
  readOnSourceRule,
];
