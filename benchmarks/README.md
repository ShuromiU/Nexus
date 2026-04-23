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
