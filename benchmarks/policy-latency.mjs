// Ad-hoc latency harness for nexus-policy-check. NOT part of `npm test`.
// Run with: `node benchmarks/policy-latency.mjs` (after `npm run build`).
//
// Informational only — per the V3 roadmap, the CI gate fails only on 3
// consecutive main-branch regressions, not on a single run.

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ITERATIONS = 200;
const ENTRY = path.resolve('dist/transports/policy-entry.js');

const events = [
  { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'foo' } },
  { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'foo', glob: '*.md' } },
  { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' } },
];

const timings = [];
for (let i = 0; i < ITERATIONS; i++) {
  const event = events[i % events.length];
  const start = process.hrtime.bigint();
  spawnSync('node', [ENTRY], { input: JSON.stringify(event), encoding: 'utf-8' });
  const end = process.hrtime.bigint();
  timings.push(Number(end - start) / 1_000_000);
}

timings.sort((a, b) => a - b);
const p = (q) => timings[Math.floor(timings.length * q)];
const summary = {
  iterations: ITERATIONS,
  p50_ms: Number(p(0.5).toFixed(2)),
  p95_ms: Number(p(0.95).toFixed(2)),
  p99_ms: Number(p(0.99).toFixed(2)),
  max_ms: Number(timings[timings.length - 1].toFixed(2)),
  target: { p50_ms: 50, p95_ms: 150 },
  timestamp: new Date().toISOString(),
};
console.log(JSON.stringify(summary, null, 2));
