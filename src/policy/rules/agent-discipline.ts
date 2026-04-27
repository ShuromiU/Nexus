import type { PolicyRule } from '../types.js';

const NEXUS_TOOL_PATTERN = /\bnexus_\w+/i;

const NON_CODE_DESCRIPTION =
  /^\s*(commit|deploy|push|git|install|lint|format|test|build|review|pr|release|merge|rebase|stash|status|telemetry|configure|setup)\b/i;

const EXPLORE_DENY =
  'BLOCKED: Explore agents MUST use Nexus MCP tools. Either use Nexus tools directly (nexus_find, nexus_outline, nexus_source, nexus_slice, nexus_deps, nexus_callers, nexus_pack, nexus_search, nexus_grep, nexus_tree, nexus_stats, nexus_changed, nexus_diff_outline, nexus_signatures, nexus_doc, nexus_kind_index, nexus_unused_exports, nexus_definition_at, nexus_batch) or add explicit Nexus instructions to the agent prompt.';

const AGENT_DENY =
  'BLOCKED: Agent spawns MUST include Nexus instructions. Add to the prompt: "Use Nexus MCP tools (nexus_find, nexus_refs, nexus_search, nexus_grep, nexus_outline, nexus_source, nexus_slice, nexus_deps, nexus_callers, nexus_pack, nexus_changed, nexus_diff_outline, nexus_signatures, nexus_doc, nexus_kind_index, nexus_unused_exports, nexus_definition_at, nexus_tree, nexus_stats, nexus_batch) instead of Grep for all code searches." The agent has MCP access but will not use Nexus unless explicitly told.';

export const agentDisciplineRule: PolicyRule = {
  name: 'agent-discipline',
  evaluate(event) {
    if (event.tool_name !== 'Agent') return null;

    const input = event.tool_input;
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const description = typeof input.description === 'string' ? input.description : '';
    const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type : '';

    const promptMentionsNexus = NEXUS_TOOL_PATTERN.test(prompt);

    if (subagentType === 'Explore') {
      if (promptMentionsNexus) {
        return { decision: 'allow', rule: 'agent-discipline', reason: 'explore-with-nexus' };
      }
      return { decision: 'deny', rule: 'agent-discipline', reason: EXPLORE_DENY };
    }

    if (promptMentionsNexus) {
      return { decision: 'allow', rule: 'agent-discipline', reason: 'prompt-mentions-nexus' };
    }

    if (NON_CODE_DESCRIPTION.test(description)) {
      return { decision: 'allow', rule: 'agent-discipline', reason: 'non-code-description' };
    }

    return { decision: 'deny', rule: 'agent-discipline', reason: AGENT_DENY };
  },
};
