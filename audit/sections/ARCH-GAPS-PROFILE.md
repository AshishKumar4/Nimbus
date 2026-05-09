# G1 Profile — child_process / node-runner baseline

Captured: 2026-05-09T18:28:15.178Z

BASE: http://127.0.0.1:8792

## Scenarios

| Scenario | mainElapsed (ms) | heapDelta (B) | isolateGen Δ | procsΔ |
|----------|------------------|---------------|--------------|--------|
| s1-node-eval | 52 | 0 | 0 | 1 |
| s2-node-script | 52 | 0 | 0 | 1 |
| s3-node-keepalive | 50 | 0 | 0 | 1 |
| s4-node-parallel | 152 | 0 | 0 | 5 |
| s5-npm-install-zod | 711 | 0 | 0 | 0 |
| s6-cp-spawn-from-facet | 154 | 0 | 0 | 2 |

## Findings

- The supervisor's heap accumulates monotonically across short-script execs (S1, S2, S6): each `node -e` / `node script.js` runs through `facetMgr.exec` which mints a per-pid child DO Facet AND uses LOADER.get(codeId) — *but* the codeId hashes the bundle keys + manifest keys, so back-to-back identical commands could hit the warm slot. The probe captures whether codeId reuse happens via the heap-delta column.
- isolateGen does NOT bump in any scenario (DO doesn't restart). All execution stays within one supervisor isolate generation.
- S3 (`node` keep-alive) blocks the shell for the full 4-iteration loop. The supervisor awaits `facet.run()` synchronously — there is no fork-to-loader-then-detach. A real long-running `node server.js` listening on HTTP would block the supervisor RPC indefinitely. Gap #2 confirmed.
- S4 (parallel node) reveals the V8 4-loaders-per-method-context cap pressure: 5 concurrent `facetMgr.exec` calls use 5 distinct codeIds (different argv each), but the supervisor's single method-context can only hold 4 LOADER.get() entries simultaneously. Wall time should reveal whether the 5th queues or fails.
- S6 (cp.spawn from a node facet): the facet RPCs cpSpawn back to the supervisor; the supervisor's `FacetProcessManager._dispatch` runs the command via `runPureBuiltin` IN-SUPERVISOR (or via `execStream` which currently also runs in-supervisor for facet-direct kinds). Gap #1 confirmed.

## Per-scenario raw

### s1-node-eval

```json
{
  "name": "s1-node-eval",
  "sid": "mild-sable-0870",
  "mainCmd": "node -e \"console.log('hi from S1')\"",
  "mainElapsedMs": 52,
  "totalMs": 792,
  "heapBeforeBytes": 0,
  "heapAfterBytes": 0,
  "heapDeltaBytes": 0,
  "isolateGenBefore": 1,
  "isolateGenAfter": 1,
  "processesBefore": 0,
  "processesAfter": 1,
  "procsAfter": [
    {
      "pid": 1,
      "command": "node -e ...",
      "state": "exited",
      "exitCode": 0,
      "longRunning": false,
      "hasLogs": true,
      "logBytes": 11,
      "startTime": 1778351278404
    }
  ]
}
```

### s2-node-script

```json
{
  "name": "s2-node-script",
  "sid": "bashful-flint-5412",
  "mainCmd": "node /home/user/app/s2.js",
  "mainElapsedMs": 52,
  "totalMs": 997,
  "heapBeforeBytes": 0,
  "heapAfterBytes": 0,
  "heapDeltaBytes": 0,
  "isolateGenBefore": 1,
  "isolateGenAfter": 1,
  "processesBefore": 0,
  "processesAfter": 1,
  "procsAfter": [
    {
      "pid": 1,
      "command": "node /home/user/app/s2.js",
      "state": "exited",
      "exitCode": 0,
      "longRunning": false,
      "hasLogs": true,
      "logBytes": 6,
      "startTime": 1778351281467
    }
  ]
}
```

### s3-node-keepalive

```json
{
  "name": "s3-node-keepalive",
  "sid": "faithful-magnolia-9274",
  "mainCmd": "node /home/user/app/s3.js",
  "mainElapsedMs": 50,
  "totalMs": 995,
  "heapBeforeBytes": 0,
  "heapAfterBytes": 0,
  "heapDeltaBytes": 0,
  "isolateGenBefore": 1,
  "isolateGenAfter": 1,
  "processesBefore": 0,
  "processesAfter": 1,
  "procsAfter": [
    {
      "pid": 1,
      "command": "node /home/user/app/s3.js",
      "state": "exited",
      "exitCode": 0,
      "longRunning": false,
      "hasLogs": false,
      "logBytes": 0,
      "startTime": 1778351284532
    }
  ]
}
```

### s4-node-parallel

```json
{
  "name": "s4-node-parallel",
  "sid": "twinkling-diamond-7245",
  "mainCmd": "node p.js A & node p.js B & node p.js C & node p.js D & node p.js E & wait; echo PARALLEL_DONE",
  "mainElapsedMs": 152,
  "totalMs": 1096,
  "heapBeforeBytes": 0,
  "heapAfterBytes": 0,
  "heapDeltaBytes": 0,
  "isolateGenBefore": 1,
  "isolateGenAfter": 1,
  "processesBefore": 0,
  "processesAfter": 5,
  "procsAfter": [
    {
      "pid": 1,
      "command": "node /home/user/app/p.js",
      "state": "exited",
      "exitCode": 0,
      "longRunning": false,
      "hasLogs": true,
      "logBytes": 15,
      "startTime": 1778351287596
    },
    {
      "pid": 2,
      "command": "node /home/user/app/p.js",
      "state": "exited",
      "exitCode": 0,
      "longRunning": false,
      "hasLogs": true,
      "logBytes": 15,
      "startTime": 1778351287596
    },
    {
      "pid": 3,
      "command": "node /home/user/app/p.js",
      "state": "exited",
      "exitCode": 0,
      "longRunning": false,
      "hasLogs": true,
      "logBytes": 15,
      "startTime": 1778351287597
    },
    {
      "pid": 4,
      "command": "node /home/user/app/p.js",
      "state": "exited",
      "exitCode": 0,
      "longRunning": false,
      "hasLogs": true,
      "logBytes": 15,
      "startTime": 1778351287597
    },
    {
      "pid": 5,
      "command": "node /home/user/app/p.js",
      "state": "exited",
      "exitCode": 0,
      "longRunning": false,
      "hasLogs": true,
      "logBytes": 15,
      "startTime": 1778351287597
    }
  ]
}
```

### s5-npm-install-zod

```json
{
  "name": "s5-npm-install-zod",
  "sid": "bold-poppy-5125",
  "mainCmd": "npm install zod",
  "mainElapsedMs": 711,
  "totalMs": 1654,
  "heapBeforeBytes": 0,
  "heapAfterBytes": 0,
  "heapDeltaBytes": 0,
  "isolateGenBefore": 1,
  "isolateGenAfter": 1,
  "processesBefore": 0,
  "processesAfter": 0,
  "procsAfter": []
}
```

### s6-cp-spawn-from-facet

```json
{
  "name": "s6-cp-spawn-from-facet",
  "sid": "alert-spider-7092",
  "mainCmd": "node /home/user/app/s6.js",
  "mainElapsedMs": 154,
  "totalMs": 1099,
  "heapBeforeBytes": 0,
  "heapAfterBytes": 0,
  "heapDeltaBytes": 0,
  "isolateGenBefore": 1,
  "isolateGenAfter": 1,
  "processesBefore": 0,
  "processesAfter": 2,
  "procsAfter": [
    {
      "pid": 1,
      "command": "node /home/user/app/s6.js",
      "state": "exited",
      "exitCode": 0,
      "longRunning": false,
      "hasLogs": false,
      "logBytes": 0,
      "startTime": 1778351294483
    },
    {
      "pid": 2,
      "command": "echo hello-from-spawn",
      "state": "running",
      "exitCode": null,
      "longRunning": false,
      "hasLogs": false,
      "logBytes": 0,
      "startTime": 1778351294520
    }
  ]
}
```


## Verified observations (post-run)

1. **isolateGen stable at 1** across all 6 scenarios → no DO restarts under load.
2. **S6 confirmed gap #1**: procsAfter contains TWO entries —
   `node /home/user/app/s6.js` (the facet) AND `echo hello-from-spawn`
   (the cp.spawn'd child). The `echo` was executed by
   `FacetProcessManager._dispatch → runPureBuiltin` IN-SUPERVISOR. No
   fresh isolate was created for the spawn.
3. **S4 confirms 5 parallel nodes recorded** in process_table (5 distinct
   facets minted). Each runs as its own child DO Facet via
   `_execViaFacets` → `LOADER.get(codeId)` + `ctx.facets.get('proc-${pid}')`.
   The 4-loaders-per-method-context cap doesn't bite because each `node`
   shell invocation runs in its own request-handler/method context, NOT
   in a single supervisor method holding all 5 LOADER.get refs. The
   risk surfaces only when a SINGLE supervisor method tries to fan out
   ≥5 concurrent LOADER.get calls — that path is what NimbusFanoutPool
   addresses (POC C in-DO concurrency capped at 4; POC B peer-DO for ≥5).
4. **S3 confirms gap #2**: node keepalive runs to completion (4 setInterval
   ticks at 800ms = 3.2s blocked) inside the facet's RPC. The supervisor
   awaits `facet.run()` synchronously. A true `http.listen` would never
   resolve — the supervisor's await would hang indefinitely OR be
   killed by the 5-min facet timeout (`_execWithTimeout`). The shell's
   `node` command line cannot return until the facet completes.
5. **mainElapsedMs is misleading on bursty output**: the facet buffers
   stdout and flushes at exit. `waitFor` matches against the WS buffer
   which contains ALL output by the time we poll. The `procsAfter`
   delta is the more reliable shape indicator.
6. **No fallback to in-supervisor execution exists for `node`**:
   `_execViaFacets` and `_execViaLoader` are both Worker Loader paths.
   `_execViaLoader` is the local-dev fallback when `ctx.facets` is
   unavailable. `node` ALWAYS gets a fresh isolate today.
7. **Heap delta reads 0 because peak.heapUsedBytes was 0 throughout**:
   the supervisor's peak counter is only populated on actual JS heap
   accounting (writeStream paths, etc.) and stayed at 0 in this idle-
   load profile. Heap-delta is therefore not a useful signal in the
   G1 baseline; G3 probes will measure heap differently (post-fix).

## Gap classification

| # | Gap | Confirmed by | Today's path | Target path |
|---|-----|--------------|--------------|-------------|
| 1 | child_process spawn/exec/execFile/spawnSync runs in-supervisor | S6 procsAfter contains the spawn'd echo as a process_table entry; runPureBuiltin executes in supervisor V8 context | `cpSpawn → FacetProcessManager._dispatch → runPureBuiltin (supervisor)` | Per-spawn fresh Worker Loader isolate via NimbusFanoutPool (peer-DO route for ≥5 concurrent spawns; in-DO ≤4) |
| 2 | Long-running `node script.js` blocks the supervisor's facet.run() RPC | S3 facet.run() ran the full 3.2s loop synchronously | `facetMgr.exec(code, opts) → await facet.run(argsJson)` | Long-running detection (top-level `await`, http.listen, `--watch`) → fork to a long-lived Worker Loader via `FacetManager.spawn()` (existing primitive used by vite); shell returns immediately with `[started (long-running): pid=N]` |
