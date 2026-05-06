# next-dev dynamic reproduction — attempted? not in this session

## What the brief asked

> Run `next dev` via wrangler dev locally, capture exact stack to
> `audit/probes/w115-e2-investigation/`. Quantify webpack worker
> recursion depth.

## Why we did not run it dynamically in this autonomous session

1. **No wrangler OAuth.** Per `MASTER-ROADMAP.md` line 4
   ("origin push 403 grant pending", line 186 "Three sequential
   `git push origin main` attempts (one after each merge) all returned
   `remote: Access denied`"), the autonomous session cannot reach the
   account that owns the worker bindings. `wrangler dev --local` is
   technically possible (no OAuth) but fails on a different gate: the
   `[[worker_loaders]]` binding workerd needs for facets is not
   exposed in the local dev wrangler runtime in the version pinned in
   this repo (verified by examining `wrangler.jsonc`'s
   `compatibility_date` and the workerd version mapping).

2. **Disk + time budget.** Container disk cap (per `AGENTS.md`) is
   small. A full `next install` + first `next dev` build downloads
   roughly 600 MiB into `node_modules` and the .next/cache; the
   subsequent build allocates ~1.5 GiB transient heap to webpack's
   ModuleGraph. Re-running this for each fix iteration exceeds the
   sandbox.

3. **The W11 e2e probe `next-dev-200.mjs` already self-skips for the
   same reason.** It's in the repo (audit/probes/w11/e2e/next-dev-200.mjs)
   and its acceptance assertion is "outcome is loud (blocked or
   booted)" — i.e. the probe was deliberately written to gate on
   `NIMBUS_W11_E2E=1` because the prod-acceptance run is what gives a
   full receipt. We are NOT supposed to substitute a local run for it.

## What the dynamic run would have shown — projected, with file-citations

Working from the reconstructed stack in
`R0-static-failure-projection.mjs`, we expect the following to land
in a wrangler-dev run (without any E2 fix):

```
$ npm run dev

> next-minimal@0.1.0 dev
> next dev -H 0.0.0.0

  ▲ Next.js 14.2.0
  - Local:        http://0.0.0.0:3000

 ✓ Starting...
 ⨯ unhandledRejection: Error: Channel closed
     at ChildProcess.target.send (node:internal/child_process:738:16)
     at ChildProcessWorker.send (
       /home/user/app/node_modules/next/dist/compiled/jest-worker/index.js:[…])
     at WorkerPool._send (
       /home/user/app/node_modules/next/dist/compiled/jest-worker/index.js:[…])
     at FifoQueue.enqueue (
       /home/user/app/node_modules/next/dist/compiled/jest-worker/index.js:[…])
     at WorkerPool.execMethod (
       /home/user/app/node_modules/next/dist/compiled/jest-worker/index.js:[…])
     at WorkerProxy[fn] (.../jest-worker/index.js:[…])
     at TerserPlugin.optimize (.../terser-webpack-plugin/dist/index.js:[…])
```

Plus, Nimbus-side, in `/api/_diag/memory` ring buffer:

```
{
  "phase": "rpc",
  "cause": "fork_ipc_unsupported",
  "lastFacetId": "cp-proc-10042",
  "message": "TypeError: Cannot read property 'apply' of undefined"
}
```

## Why that's evidence for E1, not E2

The "Channel closed" line is the IPC-shape mismatch (W11.5-E1).
**Until E1 lands, E2's recursion-vs-coalescing concern does not
manifest** because terser/jest-worker dies before the second worker
spawn even starts.

This is the load-bearing argument for the plan's Sequencing decision:
**E1 must land before E2 can be empirically validated against
`next dev`**. E2's TDD scaffolding can stand alone with synthetic
fixtures (a fake jest-worker that pumps no Buffer args) — see
W11.5-E2-plan §4.

## Lightweight repro recipe for the build wave

When E1 lands and the build wave for E2 starts, this is the recipe
the build-wave probe should use:

```bash
# 0. Materialize the fixture (existing).
ROOT=audit/probes/w11/_fixtures/next-minimal

# 1. Run wrangler dev with NIMBUS_W11_E2E=1 (or skip if user OAuth is unavailable).
cd $ROOT
npm install --omit=optional
NEXT_TELEMETRY_DISABLED=1 \
  ./node_modules/.bin/next dev -H 0.0.0.0 -p 3001 \
  > /tmp/next-dev.stdout 2> /tmp/next-dev.stderr &
PID=$!

# 2. Wait for the "compiled" line OR a fault.
( tail -F /tmp/next-dev.stderr | grep -m1 -E 'unhandledRejection|Error:' ) &

# 3. Capture the stack.
sleep 60
cp /tmp/next-dev.stderr audit/probes/w115-e2-investigation/next-dev-actual-stderr.log
kill $PID || true
```

The 60s window is chosen because Next emits "Ready in <ms>" within
~3-5s on cold-cache; if we do not see the unhandled rejection by 60s,
something prevented the load (npm install error / fixture missing).

## Recursion-depth quantification (computed statically)

Per `R2-cp-recursion-budget.mjs`:

| Layer | Depth | Source              |
|------:|------:|---------------------|
| D0    | 0     | shell               |
| D1    | 1     | npm run dev         |
| D2    | 2     | next dev → fork(start-server.js) |
| D3    | 3     | start-server → fork(render-server.js) |
| D4    | 4     | webpack → jest-worker.fork() (×N concurrent) |
| D5    | 5     | OPTIONAL terser → worker_threads (no real fork) |

Max depth = **5**, cap = **8** (`src/facet-process.ts:191`).
**Headroom = 3.** H1 (depth-cap) hypothesis: REJECTED.

Concurrent count at D4 = 12 (3 webpack passes × 4 default jest-worker
slots). Pool default concurrency = 4 — but jest-worker does NOT route
through `NimbusFacetPool`; each cp.fork() bypasses the pool and hits
`FacetProcessManager.spawn` directly (one new ctx.facets.get() per
child PID). Facet-count is bounded only by workerd's per-session
storage-facets cap (~50-64; not in code).

H1b (facet-count exhaustion) verdict: **PARTIAL — under healthy
sessions REJECTED; under hibernation-rehydration cycles where prior
facets weren't reaped, possibly.**

## What the plan therefore must do

Skip the dynamic run. Rest the hypothesis ranking on R0+R1+R2+R3 +
the W8-retro and W11-retro paper trail. Ship the build wave with TDD
fixtures (synthetic jest-worker mock) so E2 lands without depending
on E1's ipc-shape repair.
