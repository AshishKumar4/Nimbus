# W11.5-E2 — Webpack-in-Facet investigation receipts

> **Wave:** W11.5-E2 (Next.js Phase 2 substrate, gate E2 only)
> **Author:** autonomous Seal session, 2026-05-05
> **Mode:** PLAN — no src/ writes; investigation produces receipts
> only.
> **Companion:** `audit/sections/W11.5-E2-plan.md`

This directory holds reproduction artifacts + projected-stack receipts
for the webpack worker-pool recursion problem that blocks
`next dev` on Nimbus. Files:

| File | What it is |
|---|---|
| `R0-static-failure-projection.mjs` | Static-analysis probe — walks Next 14.2 + webpack 5 + jest-worker source-shape conventions and projects the exact failure stack we expect against Nimbus's W8 facet substrate. Exits 0; emits TAP. Fully offline-runnable. |
| `R1-facet-pool-cap-snapshot.mjs` | Reads `src/parallel/facet-pool.ts` + `src/facet-manager.ts` and prints the concurrency caps, RPC depth allowance, hibernation surface, and the file:line of every gate webpack would hit. Exits 0. |
| `R2-cp-recursion-budget.mjs` | Reads `CHILD_PROCESS_MAX_DEPTH`, the `NIMBUS_CP_DEPTH` env-propagation site, and the W8 facet-direct-runs-inline simplification (W8-retro §3 item 7). Computes the worst-case fork depth webpack/jest-worker would request and compares it to our cap. Exits 0. |
| `R3-fork-ipc-shape-mismatch.mjs` | Reads node-shims's fork() shim (`src/node-shims.ts:1543-1648`) and checks for v8.serialize codepath — finds none. This is the W7.5/E1-tracked gap, NOT E2's gate; recorded here for orthogonal-failure ordering. |
| `next-dev-probe-attempted.md` | Why we did not run `next dev` end-to-end through wrangler dev for this investigation, and what the partial run would have shown. |

Each probe is a pure-JS / pure-static-read script that runs offline.
The **dynamic** wrangler-dev reproduction is gated on user OAuth (same
gate every prod-acceptance probe in this repo waits on). It is
specified in `next-dev-probe-attempted.md` and will be run by the
build wave when the E2 implementation lands.

## Why static-analysis-first

Two reasons:

1. **The autonomous session cannot deploy Nimbus.** Wrangler OAuth has
   lapsed (per `MASTER-ROADMAP.md` line 4). Local `wrangler dev` is
   possible but `next install` of 314 packages against a session-bound
   sandbox routinely times out or fills disk in this container (~600
   MiB cap, see AGENTS.md). The W11 e2e probe `next-dev-200.mjs`
   already self-skips without `NIMBUS_W11_E2E=1` for the same reason.

2. **The expected webpack failure mode is well-defined.** Next 14.2's
   webpack-config-builder + jest-worker pool sizes are public; webpack
   5's compiler.run() emits a deterministic call graph; our W8 facet
   recursion cap is exactly enforced at `src/facet-process.ts:191`.
   Combining these we can project the failing stack within ±2 frames —
   strong enough evidence for the plan's hypothesis ranking. The build
   wave's TDD scaffolding (W11.5-E2-plan §4) will turn these receipts
   into asserting probes.

## Run

```
node R0-static-failure-projection.mjs
node R1-facet-pool-cap-snapshot.mjs
node R2-cp-recursion-budget.mjs
node R3-fork-ipc-shape-mismatch.mjs
```

All probes complete in <1 s and write a single TAP-shaped block to
stdout. No exit-code assertions — they are evidence collectors, not
gating tests.
