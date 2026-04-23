# Nexus Benchmarks

## Policy latency

`policy-latency.mjs` spawns the compiled `nexus-policy-check` bin N times and
reports p50/p95/p99. Per the V3 roadmap, targets are p50 < 50ms and p95 < 150ms
on representative payloads. Single-run regressions are not blocking — CI only
fails on three consecutive main-branch regressions.

Run locally:

```bash
npm run build
node benchmarks/policy-latency.mjs
```

Output is JSON; commit historical runs to `benchmarks/policy-latency.json` if
desired (not automated in this plan).

### Platform note

On Windows, Node.js process-spawn overhead typically exceeds 50ms, which means
the p50 target is effectively unreachable for the current spawn-per-call model.
Measured values of ~80ms for p50 on Windows are expected and not a regression.
The p95 target (<150ms) is still achievable cross-platform. If p50 becomes a
hard requirement on Windows, the V4 long-lived policy worker (per the roadmap)
removes the spawn cost entirely.
