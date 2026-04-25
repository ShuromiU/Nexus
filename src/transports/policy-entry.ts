#!/usr/bin/env node

/**
 * nexus-policy-check — dedicated micro-entrypoint for the PreToolUse hot path.
 *
 * Contract:
 *   - Reads a single JSON event from stdin.
 *   - Writes a single JSON response to stdout.
 *   - Exits 0 unless something truly unrecoverable happens.
 *   - Does NOT re-index. stale_hint advertises whether the answer may lag.
 *   - Must not import Commander or MCP SDK — stay small and fast.
 *
 * Retained for back-compat with installs that still call this bin directly.
 * New installs (`nexus install`) point hooks at the `nexus-hook` bin instead,
 * but both share `runPolicyHook` from `src/policy/dispatch-hook.ts`.
 */

import { runPolicyHook, readStdinSync } from '../policy/dispatch-hook.js';

async function main(): Promise<void> {
  const raw = readStdinSync();
  const response = await runPolicyHook(raw);
  process.stdout.write(response);
}

const argv1 = process.argv[1] ?? '';
const norm = argv1.replace(/\\/g, '/');
const isDirectRun = norm.endsWith('transports/policy-entry.js') || norm.endsWith('transports/policy-entry.ts');

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`[nexus-policy-check] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
