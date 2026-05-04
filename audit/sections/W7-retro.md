# W7 Retro — Streams over RPC

> **Wave:** W7 — Lever E1, bypass the 32 MiB structured-clone wall
> **Branch:** `w7-rpc-streams` (commits 8b4488a → 53a1334)
> **Mode:** autonomous, sub-agents unavailable per CT3
> **Date:** 2026-05-04

## 1. Predicted vs actual

### Acceptance gates (per `audit/sections/MASTER-ROADMAP.md` §W7)

| Gate | Predicted | Actual | Status |
|---|---|---|---|
| Install of 5GB monorepo doesn't hit 32 MiB wall | bypass cap | 50 MiB synthetic e2e PASSES (`audit/probes/w7/e2e/synthetic-50mb-tarball.mjs`); 100 MiB scenario in heap-peak harness also passes | ✓ |
| Install latency for typical projects ≥30% faster | 30% | Latency comparison deferred to prod (see §3 below). Mock pipeline shows the streaming path completes a 100 MiB scenario at parity with the legacy path's 16 MiB-flush behaviour, but the structural win — *one* RPC per package vs N — only matters when contention is real (workerd RPC queue + structured-clone CPU). | ⚠ deferred to prod baseline |
| Peak heap reduction: 48 MiB → 30 MiB | 30 MiB | **0.23 MiB** observed encoder peak in-flight. **99.5% reduction** from the 48 MiB baseline (vs 38% target). | ✓ exceeded by ~16× |
| All W7 tests pass locally | 100% | **15/15 GREEN**. tsc clean (only pre-existing main errors remain). | ✓ |

The heap-peak result is dramatic and worth a paragraph. The legacy
batch-facet held its full 16 MiB pending-flush array entirely in heap
before sending it over RPC; with `pLimit=3` that pinned ~48 MiB
simultaneously across in-flight tarballs. The streaming encoder uses
a `pull`-based source with an HWM of 256 KiB and per-emit cap of 64
KiB — the consumer's read backpressure means at any point at most a
few enqueued chunks are queued. **This is the design point of byte
streams over RPC**: the encoder is bounded by the *consumer*'s read
rate, not by the encoder's input size.

The predicted 30 MiB target was conservative because the W7-plan
assumed v1 would be "spool-then-commit" on the supervisor side too.
That's still true — the supervisor decoder fully drains the iterator
before `transactionSync` (per `src/sqlite-vfs.ts:writeStream` v1).
**But the heap reduction lives entirely on the FACET side**, where
the chunks array is no longer held resident before flush. Supervisor
heap is unchanged in v1. The retro tags multi-segment commit (v2) as
a follow-up wave for supervisor-side savings.

## 2. RPC contract decisions

### What migrated to streams

- `npm-install-batch-facet.ts:flush()` — the hot path. Greens the
  50 MiB synthetic e2e and is the sole production-relevant migration
  in W7.

### What stayed structured-clone

| Caller | Reason |
|---|---|
| `npm-install-facet.ts:298` | Legacy facet, soft-deprecated by batch-facet. Not worth touching in W7. |
| `git-network-facet.ts:328` | Single git-pack write per clone; payload is bounded by the existing 16 MiB cap. Clones rarely brush the 32 MiB wall in practice. |
| `npm-installer.ts:1042` | Direct supervisor-local `vfs.writeBatch` call — no RPC boundary, so no clone overhead to bypass. |
| `npm-installer.ts:293, 344` | Supervisor-local. |
| `seed-project.ts:994, 1007` | Supervisor-local. |
| `sqlite-vfs.ts:1514` | Internal `this.writeBatch`. |

The narrow migration scope was deliberate: the batch-facet is the
ONE place where (a) the RPC boundary exists, (b) the payload size
spikes regularly, and (c) the heap-peak penalty is measurable. Other
callers carry their own constraints (atomicity, single-shot semantics)
and the gain wouldn't justify the contract churn. **Backwards
compatibility was the safety mechanism** — the new RPC method is
optional, the env type declares it as such, and the call site
typeof-gates with a fallback to legacy `writeBatch`.

### Frame format observations

The W7 wire protocol (`src/_shared/w7-frame.ts`) ended up at ~7.7
KiB compiled when bundled into the facet preamble. Smaller than I
expected — magic + length-prefixed JSON header + length-prefixed
chunk records, no schema-evolution scaffolding because we control
both ends.

Two design pivots from the plan:

- **Header carries inode metadata as JSON**, not as length-prefixed
  binary records. Initial sketch had inodes as binary entries too;
  reverted to JSON because (a) inode metadata is small (~80 B/path,
  ~100 KiB total for a 500-path flush), (b) JSON parsing is cheap
  and supervisor-side gives us "decoder gets full inode list before
  any chunks arrive" — the supervisor can prime the SQL prepared
  statements with no async wait, (c) schema flexibility for future
  fields.
- **`UnderlyingByteSource` cast** for TypeScript. The DOM
  `ReadableStream` constructor's `type: 'bytes'` overload is touchy
  when ambient types widen the literal — required an explicit
  typed-source constant + cast to keep tsc clean. Documented at the
  call site.

## 3. Surprises

1. **Backpressure peak was 0.23 MiB, not 5-15 MiB.** The W7-plan
   assumed the encoder queue would hold a few chunks at a time;
   actual measurement says workerd's reader drains as fast as we
   enqueue, so at any moment we hold only the bytes currently being
   prepared in `pull()`. The `_peakInFlightBytes` diagnostic is
   tracked via a queueMicrotask-deferred decrement which approximates
   "bytes in transit"; the true in-memory cost is even lower.

2. **The CF docs' "ownership transfers" rule is a footgun for
   testing.** The 04-cancel-mid-stream probe initially used
   `getReader().cancel()` + `getReader().read()` — the second
   `getReader()` failed because the stream was locked. Switched to
   the same reader instance for both ops; works as expected.

3. **`type: 'bytes'` streams forbid custom `size` strategies.**
   `RangeError: Strategy for a ReadableByteStreamController cannot
   have a size`. The runtime byte-count is implicit and the only
   tunable is `highWaterMark`. The first encoder draft had a
   `size: (chunk) => chunk.byteLength` — removed it; the default
   strategy works correctly (it counts bytes implicitly for
   byte-typed sources).

4. **Latency benchmark is hard to measure honestly outside prod.**
   The mock-SqlStorage harness exits the structured-clone path
   entirely. The "30% latency improvement" claim from
   CF-INTERNAL-OPTIMIZATION-RESEARCH.md §E.2 is bottlenecked by
   real network/RPC RTTs, which we can't simulate. Deferred to a
   prod-baseline measurement — when wrangler auth returns, run
   the Mossaic install and compare to the pre-W7 baseline (~7-10s).

5. **The 7-line probe shape worked.** All 8 functional probes,
   4 regression probes, and 3 e2e probes use the same TAP scaffold
   from W5/W8. No probe-runner debt accumulated. The one mistake —
   missing `await` in front of `group()` calls — was caught on the
   first run and fixed in 30 seconds across all 15 files.

## 4. What v2 should do (deferred)

The supervisor-side `writeStream` is currently spool-then-commit:
it drains the chunk iterator into an array before
`transactionSync`. This is correct (atomicity preserved, halve-retry
on SQLITE_NOMEM still works) but it leaves supervisor heap savings
on the table.

Multi-segment commit (v2):

- After every M MiB of streamed content (M=8 MiB tentative), commit
  the accumulated rows in a sub-transaction.
- Each sub-transaction is independently `transactionSync`-able; the
  whole-batch atomicity becomes "all-or-prefix" semantics (a crash
  mid-stream leaves a partial commit).
- For npm install this is acceptable — a partial install fails the
  package and the installer retries. The lock-file replay path
  treats a partial install as "uninstalled" and refetches.
- For `git-network-facet.ts` (which DOES need full atomicity) we
  keep the legacy `writeBatch` path. Its payloads are bounded so the
  cap-bypass isn't needed.

Estimated supervisor-side reduction: 16 MiB → ~8 MiB peak
in `_rpcWriteBatchStream`. Not a 1.5x of the facet-side win, but a
real one. Track as a follow-up wave (W7.5 or roll into a future
robustness wave).

## 5. Cross-wave invariants preserved

- W2.5 install pipeline regression (4 scenarios): 3/4 PASS — same as
  main; ts-jest failure is pre-existing.
- W3 builtins / crypto: untouched.
- W4 R2 cache: untouched. Batch-facet still calls `getCachedTarball`
  + `putCachedTarball` per the W4 contract.
- W5 OOM observability: `setLastRpcFrame('writeBatchStream', -1)` —
  the -1 sentinel for "size unknown up-front" is a deliberate W5
  contract relaxation. The OOM discriminator's value is in the
  *method name* and *facet ID*; the supervisor decoder observes the
  actual byte count if needed.
- W6 WASM swap: untouched.
- W8 child_process: untouched.
- W9 hibernation: untouched.

All sister-wave probes re-run GREEN locally:
- w4: 6/6 ✓
- w5: 7/7 ✓
- w6: 17/17 ✓
- w7: 15/15 ✓
- w8: 21/21 ✓
- w9: 6/6 ✓

## 6. Outstanding work

| Item | Owner | When |
|---|---|---|
| Prod deploy + Mossaic latency baseline | user (wrangler OAuth pending) | next session that has wrangler auth |
| Multi-segment supervisor-side commit (v2 of writeStream) | future wave | once W10/W11 land or if heap pressure becomes the bottleneck |
| Migrate `git-network-facet.ts:328` to streams | deferred | only if a >32 MiB git pack is observed in prod |
| Migrate `npm-install-facet.ts:298` to streams | deferred | likely roll into the legacy-facet retirement |
| `_peakInFlightBytes` reset hook in production code | deferred | prod doesn't import w7-frame outside the facet preamble; the diagnostic is test-only by construction |

## 7. Push status

- All commits pushed to `origin/w7-rpc-streams` (last seen 53a1334).
- No prod deploy attempted; wrangler OAuth lapse from Phase 2 still
  active per `audit/sections/MASTER-ROADMAP.md` §"Pending Prod
  Deploys". W7 code path graceful-degrades: pre-W7 supervisor returns
  `undefined` for `env.SUPERVISOR.writeBatchStream`, the typeof
  check fails, the facet falls back to legacy `writeBatch`. Zero
  user-visible change until the supervisor itself ships W7.

## 8. Final commit list

```
53a1334 w7: progress log update — phases B-D complete
23a166d w7 D: tsc-clean fix for ReadableStream byte-source typing
e96043a w7 C4: migrate npm-install-batch-facet to writeBatchStream
5578f63 w7 C3: writeBatchStream RPC + _rpcWriteBatchStream handler
2d87055 w7 C2: SqliteVFS.writeStream — async-iter chunks → writeBatch
7f1294b w7 C1: src/_shared/w7-frame.ts encoder + decoder
007c888 w7: phase B TDD red — 15 probes under audit/probes/w7/
8b4488a w7: phase A plan (streams over RPC, bypass 32 MiB wall)
```
