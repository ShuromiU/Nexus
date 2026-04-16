#!/usr/bin/env bash
# session-start-build.sh — Claude Code SessionStart hook
#
# Runs `nexus build` (incremental) in the project's working directory whenever
# a new Claude Code session starts. Keeps the index fresh for the first query
# of the session without having to wait for the MCP server's startup reindex.
#
# Reads project root from $CLAUDE_PROJECT_DIR (set by Claude Code) and falls
# back to the current working directory.
#
# Install:
#   1. Copy this file to ~/.claude/hooks/session-start-build.sh and chmod +x
#   2. Add to ~/.claude/settings.json under "hooks":
#        "SessionStart": [
#          {
#            "matcher": "",
#            "hooks": [
#              { "type": "command",
#                "command": "bash ~/.claude/hooks/session-start-build.sh" }
#            ]
#          }
#        ]

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

cd "$PROJECT_DIR" 2>/dev/null || exit 0
nexus build 2>/dev/null || true
