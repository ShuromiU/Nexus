#!/usr/bin/env bash
# nexus-first.sh — Claude Code PreToolUse hook
#
# Enforces "use Nexus before Grep/Explore" policy:
#   • Grep on code files          → denied (use nexus_search/nexus_grep instead)
#   • Glob for file discovery     → allowed (Nexus is for symbols, not file globs)
#   • Explore subagents           → denied unless prompt mentions a nexus_* tool
#   • Agent spawns                → denied unless prompt or description mentions Nexus
#
# Allow-list:
#   • Grep on .md/.json/.yaml/.toml/.env/.lock/etc
#   • Grep on docs/, .git, node_modules, .nexus, .claude
#   • Agents whose description starts with non-code words (commit, deploy, build, …)
#
# Disable temporarily:  NEXUS_FIRST_DISABLED=1
#
# Install:
#   1. Copy this file to ~/.claude/hooks/nexus-first.sh and chmod +x
#   2. Add to ~/.claude/settings.json under "hooks":
#        "PreToolUse": [
#          {
#            "matcher": "Grep|Glob|Agent",
#            "hooks": [
#              { "type": "command",
#                "command": "bash -c 'source ~/.bashrc && bash ~/.claude/hooks/nexus-first.sh'" }
#            ]
#          }
#        ]
#
# Requires `jq` on PATH.

if [ "$NEXUS_FIRST_DISABLED" = "1" ]; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Canonical list of every Nexus MCP tool. Update when adding new tools.
NEXUS_TOOLS_REGEX='(nexus_find|nexus_refs|nexus_search|nexus_symbols|nexus_exports|nexus_imports|nexus_importers|nexus_grep|nexus_outline|nexus_source|nexus_slice|nexus_deps|nexus_tree|nexus_stats|nexus_callers|nexus_pack|nexus_changed|nexus_diff_outline|nexus_signatures|nexus_definition_at|nexus_unused_exports|nexus_kind_index|nexus_doc|nexus_batch)'

# ── Grep / Glob ──────────────────────────────────────────────────────
if [ "$TOOL_NAME" = "Grep" ] || [ "$TOOL_NAME" = "Glob" ]; then
  SEARCH_PATH=$(echo "$INPUT" | jq -r '.tool_input.path // empty')
  GLOB_TYPE=$(echo "$INPUT" | jq -r '.tool_input.type // empty')
  GLOB_FILTER=$(echo "$INPUT" | jq -r '.tool_input.glob // empty')

  # Allow non-code file types
  if echo "$GLOB_FILTER" | grep -qiE '\.(md|json|yaml|yml|toml|env|lock|txt|csv|html|xml|sql|sh|bat|cmd|log)'; then
    exit 0
  fi
  if echo "$GLOB_TYPE" | grep -qiE '^(md|json|yaml|yml|toml)$'; then
    exit 0
  fi
  # Allow non-code directories
  if echo "$SEARCH_PATH" | grep -qiE '(node_modules|\.git|\.nexus|docs/|\.env|\.claude/)'; then
    exit 0
  fi
  # Glob is for file discovery — always allow
  if [ "$TOOL_NAME" = "Glob" ]; then
    exit 0
  fi

  # Deny Grep on code files
  echo '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "NEXUS ONLY: Use nexus_find, nexus_refs, nexus_search, or nexus_grep instead of Grep for code files. Grep is NOT allowed for code — use Nexus."
    }
  }'
  exit 0
fi

# ── Agent spawns ─────────────────────────────────────────────────────
if [ "$TOOL_NAME" = "Agent" ]; then
  PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')
  DESCRIPTION=$(echo "$INPUT" | jq -r '.tool_input.description // empty')
  SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')

  # Explore subagents must reference a Nexus tool — Explore IS code search
  if [ "$SUBAGENT_TYPE" = "Explore" ]; then
    if echo "$PROMPT" | grep -qiE "$NEXUS_TOOLS_REGEX"; then
      exit 0
    fi
    echo '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "BLOCKED: Explore agents MUST use Nexus MCP tools. Either use Nexus tools directly (nexus_find, nexus_outline, nexus_source, nexus_slice, nexus_deps, nexus_callers, nexus_pack, nexus_search, nexus_grep, nexus_tree, nexus_stats, nexus_changed, nexus_diff_outline, nexus_signatures, nexus_doc, nexus_kind_index, nexus_unused_exports, nexus_definition_at, nexus_batch) or add explicit Nexus instructions to the agent prompt."
      }
    }'
    exit 0
  fi

  # Other agents: allow if prompt mentions any Nexus tool
  if echo "$PROMPT" | grep -qiE "$NEXUS_TOOLS_REGEX"; then
    exit 0
  fi

  # Allow non-code agent tasks based on description
  if echo "$DESCRIPTION" | grep -qiE '^(commit|deploy|push|git|install|lint|format|test|build|review|pr|release|merge|rebase|stash|status|telemetry|configure|setup)'; then
    exit 0
  fi

  echo '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "BLOCKED: Agent spawns MUST include Nexus instructions. Add to the prompt: \"Use Nexus MCP tools (nexus_find, nexus_refs, nexus_search, nexus_grep, nexus_outline, nexus_source, nexus_slice, nexus_deps, nexus_callers, nexus_pack, nexus_changed, nexus_diff_outline, nexus_signatures, nexus_doc, nexus_kind_index, nexus_unused_exports, nexus_definition_at, nexus_tree, nexus_stats, nexus_batch) instead of Grep for all code searches.\" The agent has MCP access but will not use Nexus unless explicitly told."
    }
  }'
  exit 0
fi

exit 0
