import { describe, it, expect } from 'vitest';
import { agentDisciplineRule } from '../src/policy/rules/agent-discipline.js';
import type { PolicyEvent, PolicyContext } from '../src/policy/types.js';

const ctx: PolicyContext = { rootDir: '/tmp', dbPath: '/tmp/.nexus/index.db' };

function ev(input: Record<string, unknown>): PolicyEvent {
  return { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input };
}

describe('agentDisciplineRule', () => {
  it('ignores non-Agent tools', () => {
    const d = agentDisciplineRule.evaluate(
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x.ts' } },
      ctx,
    );
    expect(d).toBeNull();
  });

  describe('Explore subagents', () => {
    it('denies Explore without Nexus mention in prompt', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'Explore',
          prompt: 'find every component that uses the auth context',
          description: 'Find auth uses',
        }),
        ctx,
      );
      expect(d?.decision).toBe('deny');
      expect(d?.rule).toBe('agent-discipline');
      expect(d?.reason).toMatch(/Explore agents MUST use Nexus/);
    });

    it('allows Explore when prompt mentions a Nexus tool', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'Explore',
          prompt: 'use nexus_callers to map the call graph',
          description: 'Map auth callers',
        }),
        ctx,
      );
      expect(d?.decision).toBe('allow');
      expect(d?.rule).toBe('agent-discipline');
    });

    it('matches nexus_ prefix case-insensitively', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'Explore',
          prompt: 'Nexus_Outline the file then summarize',
          description: 'Outline file',
        }),
        ctx,
      );
      expect(d?.decision).toBe('allow');
    });

    it('allows Explore when prompt mentions a structured-file Nexus tool not in the legacy regex', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'Explore',
          prompt: 'use nexus_lockfile_deps to enumerate package versions',
          description: 'List deps',
        }),
        ctx,
      );
      expect(d?.decision).toBe('allow');
    });

    it('Explore deny ignores description allow-list (Explore is stricter)', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'Explore',
          prompt: 'just look around',
          description: 'commit cleanup',
        }),
        ctx,
      );
      expect(d?.decision).toBe('deny');
    });
  });

  describe('Other agent types (general-purpose, Plan, etc.)', () => {
    it('denies general-purpose Agent without Nexus and without non-code description', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'general-purpose',
          prompt: 'find authentication helpers in the codebase',
          description: 'Find auth helpers',
        }),
        ctx,
      );
      expect(d?.decision).toBe('deny');
      expect(d?.reason).toMatch(/Agent spawns MUST include Nexus instructions/);
    });

    it('allows when prompt mentions Nexus regardless of subagent_type', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'Plan',
          prompt: 'use nexus_outline and nexus_deps to plan the refactor',
          description: 'Plan refactor',
        }),
        ctx,
      );
      expect(d?.decision).toBe('allow');
    });

    it('allows non-code description prefixes like "commit"', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'general-purpose',
          prompt: 'stage and commit the staged files with the right message',
          description: 'commit staged work',
        }),
        ctx,
      );
      expect(d?.decision).toBe('allow');
    });

    it('allows description "release v1.2.3"', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'general-purpose',
          prompt: 'tag and ship',
          description: 'release v1.2.3',
        }),
        ctx,
      );
      expect(d?.decision).toBe('allow');
    });

    it('allows description "test-runner audit" (test prefix)', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'general-purpose',
          prompt: 'run the suite',
          description: 'test-runner audit',
        }),
        ctx,
      );
      expect(d?.decision).toBe('allow');
    });

    it('does not match "testify" as the test prefix (word boundary)', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'general-purpose',
          prompt: 'testify some functions',
          description: 'testify the auth module',
        }),
        ctx,
      );
      expect(d?.decision).toBe('deny');
    });

    it('handles missing description (defensive)', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'general-purpose',
          prompt: 'do the thing',
        }),
        ctx,
      );
      expect(d?.decision).toBe('deny');
    });

    it('handles missing prompt (defensive)', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'general-purpose',
          description: 'commit changes',
        }),
        ctx,
      );
      expect(d?.decision).toBe('allow');
    });

    it('handles missing subagent_type (defaults to non-Explore branch)', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          prompt: 'use nexus_search for the auth helpers',
          description: 'Find auth',
        }),
        ctx,
      );
      expect(d?.decision).toBe('allow');
    });

    it('does not match a stray "nexus" without underscore', () => {
      const d = agentDisciplineRule.evaluate(
        ev({
          subagent_type: 'general-purpose',
          prompt: 'Nexus is a great tool but I will use Grep',
          description: 'Find auth',
        }),
        ctx,
      );
      expect(d?.decision).toBe('deny');
    });
  });
});
