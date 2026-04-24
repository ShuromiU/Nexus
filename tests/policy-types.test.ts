import { describe, it, expect } from 'vitest';
import type {
  PolicyEvent,
  PolicyDecision,
  PolicyResponse,
  PolicyRule,
} from '../src/policy/types.js';

describe('policy types', () => {
  it('PolicyDecision is one of allow|ask|deny|noop', () => {
    const decisions: PolicyDecision['decision'][] = ['allow', 'ask', 'deny', 'noop'];
    expect(decisions).toEqual(['allow', 'ask', 'deny', 'noop']);
  });

  it('PolicyEvent is structurally a Claude Code PreToolUse payload', () => {
    const event: PolicyEvent = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
      session_id: 'test',
      cwd: '/tmp',
    };
    expect(event.tool_name).toBe('Grep');
  });

  it('PolicyResponse carries stale_hint and optional decision', () => {
    const resp: PolicyResponse = {
      decision: 'allow',
      stale_hint: false,
    };
    expect(resp.stale_hint).toBe(false);
  });

  it('PolicyDecision and PolicyResponse accept optional additional_context', () => {
    const decision: PolicyDecision = {
      decision: 'allow',
      rule: 'x',
      additional_context: 'use nexus_outline',
    };
    const resp: PolicyResponse = {
      decision: 'allow',
      stale_hint: false,
      additional_context: 'use nexus_outline',
    };
    expect(decision.additional_context).toBe('use nexus_outline');
    expect(resp.additional_context).toBe('use nexus_outline');
  });

  it('PolicyRule has name + evaluate signature', () => {
    const rule: PolicyRule = {
      name: 'test-rule',
      evaluate: () => null,
    };
    expect(rule.name).toBe('test-rule');
  });
});
