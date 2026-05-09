# git-freeze progress

## Brief
P0 user-impact bug: `git clone https://github.com/AshishKumar4/Nimbus`
on prod froze at exactly `[git] Updating workdir 1450/1595`.

User concern: "1.6M file count is suspicious — Nimbus repo has well
under 50k files. cf-git fork may be walking .git/objects as workdir
files."

## YOU OWN E2E
Drive prod via WS, reproduce freeze, no asking user to retest.

## Phases
- [x] P0 setup (HEAD: 4723924; tsc baseline: 2)
- [ ] P1 characterize via WS + wrangler tail
- [ ] P2 root cause with file:line
- [ ] P3 fix at source
- [ ] P4 probe at audit/probes/git-freeze/clone-large-repo.mjs
- [ ] P5 cross-wave 29/29 + tsc baseline
- [ ] P6 retro at audit/sections/GIT-FREEZE-retro.md

## Findings so far

### File count "1.6M" mystery — RESOLVED
The user's "1595642" was line-noise concatenation of two consecutive
progress frames overlapping in display:
  - frame N:   `Updating workdir 1450/1595`
  - frame N+1: `Updating workdir XXX/1595` (started "642" or similar)
Strip ANSI without proper carriage-return handling → "1450/1595642".
The actual total IS 1595, which matches Nimbus's real file count
(under 2k). The 1.6M observation was a UI artifact, not a runtime
bug.

### Real bug — RECONFIRMED
Clone freezes at **`Updating workdir 1450/1595`** (≈91% complete)
on prod. Reproduced twice via WS-driven trace
(audit/probes/git-freeze/trace-2026-05-09T03-54-36Z.txt).
180s+ of silence after that frame; no `done.`, no error, no
progress, no facet exit. Last reachable frame is the progress
log.

The first 1450 files write at ~150 files/s (fine). The hang is
specifically after writing 1450 of 1595 — leaves ~145 files
unprocessed.

## Hypotheses to investigate (P2)
- H1 VFS writeBatch backpressure — DO RPC queue saturates
- H2 Per-file RPC limits (W7 streaming should batch but maybe doesn't reach checkout)
- H3 (REJECTED — 1.6M was a UI artifact, not a real count)
- H4 workerd CPU budget kills request, log frames keep arriving from cache
- H5 isomorphic-git checkout sync issue
- H6 cf-git fork's writeBuffer (network-facet.ts:385) deadlocks at end-of-clone

H6 is intriguing — the fork uses a writeBuffer that flushes via
`maybeFlush()` at line 390 (and elsewhere). If the LAST batch
never flushes (no trigger condition met), the clone never
completes.

## P2 root cause (file:line)

**ROOT CAUSE**: `src/git/network-facet.ts:328` uses
`supervisor.writeBatch(payload)` — the structured-clone path with a
32 MiB cap and ~4 MiB-per-wave payloads. The git facet does NOT
use the W7 streaming `writeBatchStream` path that npm install
uses (`src/npm/install-batch-facet.ts:430`).

**Evidence from prod tail**
(`audit/probes/git-freeze/tail-2026-05-09T04-00-32Z.jsonl`):

```
t+20.0s: 1st _rpcWriteBatch → ok (1350ms)
t+25.7s: 2nd _rpcWriteBatch → ok (117ms)
t+25.7s: SupervisorRPC stat → exceededMemory (wallTime=37806ms)
t+25.8s: SupervisorRPC stat → exceededMemory (wallTime=37734ms)
t+33.3s: 3rd _rpcWriteBatch → ok (2076ms — slow, post-OOM
                                   reincarnation)
t+33.7s: 4th _rpcWriteBatch → ok (1488ms)
t+34.6s: 5th _rpcWriteBatch → ok (521ms)
```

The wrapper isolate hosting `SupervisorRPC` (the `ctx.exports`
loopback) accumulated memory across many calls and hit its 128 MB
ceiling. The OOM events fire on `event.rpcMethod: "stat"` with
`exceptions.message: "Worker exceeded memory limit."`.

The git facet's fs-adapter flow:
  - Each blob written via `fs.writeFile` → buffered.
  - After 500 files (WAVE_FILES) or 4 MB (WAVE_BYTES),
    `maybeFlush()` calls `supervisor.writeBatch(payload)`.
  - Each writeBatch payload is structured-cloned through workerd's
    Service Binding, costing ~4 MiB resident in the wrapper isolate.
  - After 5 waves + many stat/readFileBytes RPCs, the wrapper's
    heap exceeds 128 MB.
  - Subsequent stat RPCs fail. But the failures don't bubble up to
    the git facet — the RPC just hangs (workerd retries).
  - The git facet's `flushWave()` waiting for the next writeBatch
    response, OR the next `lstat` on a flushed file, never resolves.
  - User sees `Updating workdir 1450/1595` as the final progress
    frame; clone Promise never resolves.

**Why exactly 1450/1595**: ~3 checkout-phase flushes (500 files
each = 1500 files would land), but the OOM happens during the
3rd flush's downstream stat RPCs. Last successful progress
emit is from batchAllSettled's iteration immediately before the
hang point.

**File-count "1.6M" mystery — confirmed UI artifact**: actual
total is 1595 (matches Nimbus repo's real file count). User's
"1595642" was line-noise from ANSI/CR-overprinting of two
adjacent progress frames.

**Why the 1450/1595 vs the user's 1450/1595642**: my repro shows
clean `1450/1595`. The user's UI rendered the next frame's
"642/1595" overlapping the prior, displayed as "1595642".

## P3 fix at source

The git facet must use `writeBatchStream` (W7) instead of
`writeBatch`. Same pattern as npm install at
`src/npm/install-batch-facet.ts:421-440`:

  if (env.SUPERVISOR.writeBatchStream) {
    const stream = encodeWriteBatchStream({ inodes, chunks });
    await env.SUPERVISOR.writeBatchStream(stream);
  } else {
    await env.SUPERVISOR.writeBatch({ inodes, chunks });
  }

Requires:
1. Add W7_FRAME_PREAMBLE to git facet's `modules` map at
   `src/git/network-facet.ts:101-104`.
2. Detect `env.SUPERVISOR.writeBatchStream` availability inside
   the facet.
3. Use streaming when available; fall back to writeBatch for
   pre-W7 supervisors.

This bypasses structured-clone, flows bytes via ReadableStream
with 256 KiB highwater (W7_HIGHWATER_BYTES), keeps wrapper
isolate resident size BELOW the runaway accumulation point.
NO setTimeout / sleep / retry. NO new safety nets.
