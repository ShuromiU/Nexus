#!/usr/bin/env node

/**
 * nexus-hook — slim hot-path bin for Claude Code hooks.
 *
 * Subcommands:
 *   - `pre`           : dispatch a PreToolUse event (reads stdin → writes JSON response)
 *   - `post`          : dispatch a PostToolUse event (same shape)
 *   - `session-start` : bootstrap on session start (currently `nexus build`-equivalent)
 *
 * Static imports are kept minimal: only policy/dispatch-hook + workspace/detector.
 * The QueryEngine and any tree-sitter adapters are loaded via dynamic import,
 * so a pure-Grep event never pays for tree-sitter cold-start.
 *
 * Always exits 0 unless something truly unrecoverable happens.
 */

import { runPolicyHook, readStdinSync } from '../policy/dispatch-hook.js';
import { resolveRoot } from '../workspace/detector.js';

async function runSessionStart(): Promise<void> {
  const startDir = resolveRoot().startDir;
  // Lazy imports — extractor adapters are heavy, but session-start fires
  // once per session, so the load cost is amortized.
  const { detectWorkspace } = await import('../workspace/detector.js');
  const info = detectWorkspace(startDir);
  try {
    if (info.mode === 'worktree') {
      const { buildWorktreeIndex } = await import('../index/overlay-orchestrator.js');
      const outcome = buildWorktreeIndex(info);
      const tag = outcome.kind === 'overlay' ? 'overlay-on-parent' : `worktree-isolated (${outcome.reason})`;
      process.stderr.write(`[nexus session-start] worktree mode=${tag} files=${outcome.result.filesIndexed}\n`);
    } else {
      const { runIndex } = await import('../index/orchestrator.js');
      const result = runIndex(info.root);
      process.stderr.write(`[nexus session-start] ${info.mode} mode=full files=${result.filesIndexed}\n`);
    }
  } catch (err) {
    // SessionStart hooks should not block the user's session under any
    // circumstance. Log to stderr (visible in Claude Desktop's MCP panel)
    // and exit cleanly.
    process.stderr.write(`[nexus session-start] reindex warning: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  switch (sub) {
    case 'pre':
    case 'post': {
      const raw = readStdinSync();
      const response = await runPolicyHook(raw);
      process.stdout.write(response);
      return;
    }
    case 'session-start':
      await runSessionStart();
      return;
    default:
      process.stderr.write(
        `nexus-hook: unknown subcommand ${JSON.stringify(sub ?? '')}. ` +
        `Expected one of: pre, post, session-start\n`,
      );
      process.exitCode = 1;
      return;
  }
}

const argv1 = process.argv[1] ?? '';
const norm = argv1.replace(/\\/g, '/');
const isDirectRun = norm.endsWith('transports/hook-entry.js') || norm.endsWith('transports/hook-entry.ts');

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`[nexus-hook] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
