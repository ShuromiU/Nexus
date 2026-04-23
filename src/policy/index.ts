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

import { grepOnCodeRule } from './rules/grep-on-code.js';
import type { PolicyRule } from './types.js';

/** Default rule set shipped with Nexus. Extend in follow-up plans. */
export const DEFAULT_RULES: readonly PolicyRule[] = [grepOnCodeRule];
