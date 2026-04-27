import { describe, it, expect } from 'vitest';
import { formatHookEnvelope } from '../src/policy/dispatch-hook.js';
import type { PolicyResponse } from '../src/policy/types.js';

describe('formatHookEnvelope', () => {
  describe('PreToolUse', () => {
    it('wraps deny into hookSpecificOutput.permissionDecision=deny', () => {
      const r: PolicyResponse = {
        decision: 'deny',
        rule: 'grep-on-code',
        reason: 'use Nexus instead',
        stale_hint: false,
      };
      const out = JSON.parse(formatHookEnvelope(r, 'PreToolUse'));
      expect(out).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'use Nexus instead',
        },
      });
    });

    it('wraps ask into hookSpecificOutput.permissionDecision=ask', () => {
      const r: PolicyResponse = {
        decision: 'ask',
        rule: 'read-on-structured',
        reason: 'try nexus_structured_query',
        stale_hint: false,
      };
      const out = JSON.parse(formatHookEnvelope(r, 'PreToolUse'));
      expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
      expect(out.hookSpecificOutput.permissionDecisionReason).toBe('try nexus_structured_query');
    });

    it('wraps allow + additional_context into hookSpecificOutput.permissionDecision=allow', () => {
      const r: PolicyResponse = {
        decision: 'allow',
        rule: 'read-on-source',
        additional_context: 'consider nexus_outline first',
        stale_hint: false,
      };
      const out = JSON.parse(formatHookEnvelope(r, 'PreToolUse'));
      expect(out).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: 'consider nexus_outline first',
        },
      });
    });

    it('emits empty string for plain allow with no additional_context', () => {
      const r: PolicyResponse = {
        decision: 'allow',
        stale_hint: false,
      };
      expect(formatHookEnvelope(r, 'PreToolUse')).toBe('');
    });

    it('emits empty string for noop', () => {
      const r: PolicyResponse = {
        decision: 'noop',
        stale_hint: false,
      };
      expect(formatHookEnvelope(r, 'PreToolUse')).toBe('');
    });

    it('falls back to empty reason when deny carries no reason field', () => {
      const r: PolicyResponse = { decision: 'deny', stale_hint: false };
      const out = JSON.parse(formatHookEnvelope(r, 'PreToolUse'));
      expect(out.hookSpecificOutput.permissionDecisionReason).toBe('');
    });
  });

  describe('PostToolUse', () => {
    it('wraps additional_context into hookSpecificOutput.additionalContext', () => {
      const r: PolicyResponse = {
        decision: 'allow',
        rule: 'evidence-summary',
        additional_context: '3 callers affected',
        stale_hint: false,
      };
      const out = JSON.parse(formatHookEnvelope(r, 'PostToolUse'));
      expect(out).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: '3 callers affected',
        },
      });
      expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    });

    it('emits empty string when there is no additional_context', () => {
      const r: PolicyResponse = {
        decision: 'allow',
        stale_hint: false,
      };
      expect(formatHookEnvelope(r, 'PostToolUse')).toBe('');
    });

    it('emits empty string for noop on PostToolUse', () => {
      const r: PolicyResponse = {
        decision: 'noop',
        stale_hint: false,
      };
      expect(formatHookEnvelope(r, 'PostToolUse')).toBe('');
    });
  });
});
