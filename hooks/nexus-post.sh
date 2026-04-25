#!/usr/bin/env bash
# nexus-post.sh — Claude Code PostToolUse dispatcher for the test-tracker rule.
#
# Records successful test runs to .nexus/session-state.json so the
# evidence-summary rule (PreToolUse on git/gh commands) can answer
# tests_run_this_session.
#
# The script never emits stdout — PostToolUse hooks don't influence the
# assistant's next turn. Failure is always silent.
#
# Disable temporarily:  NEXUS_FIRST_DISABLED=1
#
# Install:
#   1. Copy this file to ~/.claude/hooks/nexus-post.sh and chmod +x
#   2. Add to ~/.claude/settings.json under "hooks":
#        "PostToolUse": [
#          {
#            "matcher": "Bash",
#            "hooks": [
#              { "type": "command",
#                "command": "bash -c 'source ~/.bashrc && bash ~/.claude/hooks/nexus-post.sh'" }
#            ]
#          }
#        ]
#
# Requires `nexus-policy-check` on PATH (or local node_modules/.bin).

if [ "$NEXUS_FIRST_DISABLED" = "1" ]; then
  exit 0
fi

INPUT=$(cat)
if command -v nexus-policy-check >/dev/null 2>&1; then
  echo "$INPUT" | nexus-policy-check >/dev/null 2>&1 || true
else
  echo "$INPUT" | npx --no-install nexus-policy-check >/dev/null 2>&1 || true
fi
exit 0
