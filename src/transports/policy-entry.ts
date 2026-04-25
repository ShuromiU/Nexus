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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectRoot } from '../workspace/detector.js';
import { dispatchPolicy } from '../policy/dispatcher.js';
import { DEFAULT_RULES } from '../policy/index.js';
import type { PolicyEvent, PolicyResponse, QueryEngineLike } from '../policy/types.js';
import { openDatabase } from '../db/schema.js';
import { QueryEngine } from '../query/engine.js';

function readStdinSync(): string {
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(65536);
    for (;;) {
      let n = 0;
      try {
        n = fs.readSync(0, buf, 0, buf.length, null);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN') continue;
        break;
      }
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch {
    return '';
  }
}

function parseEvent(raw: string): PolicyEvent | null {
  try {
    const obj = JSON.parse(raw) as Partial<PolicyEvent>;
    if (typeof obj.tool_name !== 'string') return null;
    const hasToolResponse = obj.tool_response && typeof obj.tool_response === 'object';
    return {
      hook_event_name: typeof obj.hook_event_name === 'string' ? obj.hook_event_name : 'PreToolUse',
      tool_name: obj.tool_name,
      tool_input: (obj.tool_input ?? {}) as Record<string, unknown>,
      ...(hasToolResponse
        ? { tool_response: obj.tool_response as Record<string, unknown> }
        : {}),
      session_id: typeof obj.session_id === 'string' ? obj.session_id : undefined,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
    };
  } catch {
    return null;
  }
}

function tryOpenEngine(rootDir: string): QueryEngineLike | undefined {
  try {
    const dbPath = path.join(rootDir, '.nexus', 'index.db');
    if (!fs.existsSync(dbPath)) return undefined;
    const db = openDatabase(dbPath, { readonly: true });
    return new QueryEngine(db) as unknown as QueryEngineLike;
  } catch {
    return undefined;
  }
}

function main(): void {
  const raw = readStdinSync();
  const event = parseEvent(raw);

  if (!event) {
    const response: PolicyResponse = {
      decision: 'allow',
      rule: 'parse-error',
      reason: 'malformed hook payload',
      stale_hint: false,
    };
    process.stdout.write(JSON.stringify(response));
    return;
  }

  const cwd = event.cwd ?? process.cwd();
  let rootDir: string;
  try {
    rootDir = detectRoot(cwd);
  } catch {
    rootDir = cwd;
  }

  const queryEngine = tryOpenEngine(rootDir);

  const response = dispatchPolicy(event, {
    rootDir,
    rules: DEFAULT_RULES,
    ...(queryEngine ? { queryEngine } : {}),
  });
  process.stdout.write(JSON.stringify(response));
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('transports/policy-entry.js')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('transports/policy-entry.ts');

if (isDirectRun) main();
