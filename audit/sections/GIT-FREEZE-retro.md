# GIT-FREEZE retro

**Branch**: `git-freeze`
**Base**: `origin/main` @ `4723924`
**Date**: 2026-05-09

## Symptom

Prod session at `https://nimbus.ashishkmr472.workers.dev/`. After
`cd app && npm i` (8.7s OK), user ran:

```
$ git clone https://github.com/AshishKumar4/Nimbus
Cloning into '/home/user/nimbus'... (shallow, depth=1)
[git] Updating workdir 1450/1595642
```

Froze. User flagged the `1.6M` file count as suspicious.

## File-count "1.6M" mystery — RESOLVED (UI artifact)

The actual progress total is **1595** (matches Nimbus repo's real
file count). User's "1595642" was line-noise from
ANSI-overprint of two adjacent progress frames where consecutive
"\\r"-prefixed updates concatenated in their terminal renderer:

```
frame N:    [git] Updating workdir 1450/1595
frame N+1:  [git] Updating workdir 642/1595  ← carriage-return-overprint
                                  ^^^
                            this fragment shows after stripping ANSI
                            but before applying \r — appears as
                            "1450/1595" + "642" = "1450/1595642"
```

NOT a walking-`.git/objects` bug. NOT a runaway file count. The
clone HAD only 1595 ops to do; it just stopped at 1450.

WS-driven trace (P1, file:line: `audit/probes/git-freeze/trace-2026-05-09T03-54-36Z.txt`)
reproduces the freeze TWICE with clean `1450/1595` numerals.

## Root cause (file:line)

`src/git/network-facet.ts:328` (pre-fix) called
`supervisor.writeBatch(payload)` — the structured-clone RPC path.
Each wave is up to ~4 MiB (`WAVE_FILES = 500` files OR
`WAVE_BYTES = 4 MiB`, whichever first; constants at network-facet.ts:207-208).

The git facet's `modules` map at `src/git/network-facet.ts:101-104` (pre-fix)
shipped only:
- `git-network-worker.js`
- `git-bundle.js` (pre-bundled isomorphic-git)

NO W7 frame preamble. So `encodeWriteBatchStream` was unavailable
inside the facet's lexical scope — the streaming RPC path
(`writeBatchStream`) that npm install uses at
`src/npm/install-batch-facet.ts:430` was unreachable from git
clone.

After ~5 writeBatch waves on a real-repo clone, the wrapper
isolate that hosts `ctx.exports SupervisorRPC` accumulates resident
bytes and hits its **128 MiB per-isolate ceiling**. Subsequent
`stat` / `readFileBytes` RPCs hang.

The git facet's `flushWave` waits forever for the next writeBatch
RPC response or the next `lstat` on a flushed file → clone Promise
never resolves → user sees `Updating workdir 1450/1595` as the
final frame.

### Evidence

Prod tail captured during reproduced freeze
(`audit/probes/git-freeze/tail-2026-05-09T04-00-32Z.jsonl`):

```
t+20.0s: 1st _rpcWriteBatch  → ok           (1350 ms)
t+25.7s: 2nd _rpcWriteBatch  → ok           (117 ms)
t+25.7s: SupervisorRPC.stat  → exceededMemory (wallTime=37806 ms)
t+25.8s: SupervisorRPC.stat  → exceededMemory (wallTime=37734 ms)
   exceptions[].message: "Worker exceeded memory limit."
t+33.3s: 3rd _rpcWriteBatch  → ok           (2076 ms — slow,
                                              post-OOM reincarnation)
t+33.7s: 4th _rpcWriteBatch  → ok           (1488 ms)
t+34.6s: 5th _rpcWriteBatch  → ok           (521 ms)
```

**Two simultaneous "Worker exceeded memory limit" events on
SupervisorRPC.stat.** That's the smoking gun.

## Fix kind

**src/-only**, single-file change in `src/git/network-facet.ts`
(commit `d699a36`). Mirrors the npm install-batch-facet pattern
at `src/npm/install-batch-facet.ts:421-440`:

1. **Import `W7_FRAME_PREAMBLE`** from
   `src/loaders/generated-workers.ts`.

2. **Prepend the preamble to the facet's main module source** at
   `src/git/network-facet.ts:113-114`:
   ```ts
   modules: {
     'git-network-worker.js': W7_FRAME_PREAMBLE + '\n' + generateGitNetworkFacetCode(),
     'git-bundle.js': GIT_BUNDLE_CODE,
   },
   ```
   The preamble is a string of top-level `function`/`var`
   declarations. Prepending it makes `encodeWriteBatchStream` a
   module-local identifier referenced as a bare name (matches
   `install-batch-facet.ts:429`).

3. **Detect streaming support** at facet boot with a runtime
   feature-probe (`supportsStreaming`):
   ```js
   const supportsStreaming =
     supervisor && typeof supervisor.writeBatchStream === 'function' &&
     typeof encodeWriteBatchStream === 'function';
   ```

4. **Branch in `flushWave`** to use `writeBatchStream` when both
   ends support it, else fall back to legacy `writeBatch`:
   ```js
   if (supportsStreaming) {
     const stream = encodeWriteBatchStream(payload);
     await supervisor.writeBatchStream(stream);
   } else {
     await supervisor.writeBatch(payload);
   }
   ```

`writeBatchStream` uses a `type:'bytes'` ReadableStream with a
**256 KiB highwater** (per `W7_FRAME_PREAMBLE`'s `ENCODER_QUEUE_HWM`
constant). Wrapper-isolate residency stays bounded regardless of
wave size, so the OOM cascade can't fire.

Anti-requirements honored:
- NO `setTimeout` / sleep / retry-with-delay.
- NO magic-number band-aid (lowering `WAVE_FILES` would only
  push the OOM further along; the real fix is bounded-residency
  streaming RPC).
- NO "skip large clones" workaround.
- NO defensive bypass.

## Why prior waves missed this — harness gap

**There was no git clone in any probe** before this wave. Every
prior wave's `phase5-regression` run-all exercised:

- npm install paths (cache-and-scrub)
- session lifecycle / hibernation (B'.1-5)
- heap estimator (C'.1)
- recovery events (C'.2)
- error recovery (C'.3)
- resolver / streaming-buffers / barrel-synth / esbuild-bytes (A')
- cirrus-real DO Facet (D'.1)
- loader-pool (D'.2)
- W5 ring / lru / nomem / diag-shape
- W7 frame-roundtrip / large-payload / backpressure / ...

**Zero git probes** despite git clone being a documented user-facing
shell operation. The git network facet was shipped, comments in
`src/git/network-facet.ts:11-17` claim "1 writeBatch per 500
files" as a perf win — but no automated test ever drove a real
clone.

The fix in P4 (`audit/probes/git-freeze/clone-large-repo.mjs`)
adds end-to-end clone coverage with assertions on:

1. Clone completes within timeout.
2. `[git] clone complete (N files, X KB in T s)` line appears.
3. File count ≥ MIN_FILE_COUNT.
4. Final `Updating workdir N/N` shows `loaded === total` (NOT a
   partial-freeze tail like 1450/1595).

P6.2 wires this probe into `phase5-regression/run-all.mjs` so
every future cross-wave run exercises a real clone.

### Surface gap — note for future waves

The git-freeze hidden between waves taught a broader lesson:
**every resource-intensive shell operation needs a probe
equivalent**. Not just clone. Concretely, the next probe-coverage
wave should add:

- `tar` / `gzip` over a 100+ file tree (the tar-stream preamble
  has its own buffered fs adapter that could regress similarly).
- Large-file `cat > ` heredoc + `node` execution (the W8 facet
  child-process pipeline has the same RPC-wave shape).
- `find` / `grep -r` over a real `node_modules` (the supervisor's
  VFS readdir RPC bursts could OOM the wrapper isolate just like
  this bug).
- Any other shell command that issues 1000+ supervisor RPCs in a
  burst. **The pattern to look for: a shell command that calls
  through `ctx.exports SupervisorRPC` in a tight loop.**

The shape of the problem: any code path that funnels many
batched-but-still-structured-clone RPCs through the wrapper
isolate. The defense at the architecture level: use streaming RPC
(W7) for any path that COULD batch >5 MiB cumulatively. The
probe at the test level: clone-class probes that exercise the
RPC fabric end-to-end against real workloads.

## Cross-wave verification

`audit/probes/phase5-regression/run-all.mjs` (full set, against
local wrangler dev on port 8797):

- **29 PASS, 0 FAIL, 0 SKIP, 0 TIMEOUT, 0 MISS** (P5 commit `67211d4`)

After P6.2 wires the new clone-large-repo probe, the count rises
to 30/30.

tsc baseline: **2 errors** (unchanged from main).

## What I deliberately did NOT change

1. **Did NOT remove the legacy `writeBatch` fallback path.** The
   facet still calls `supervisor.writeBatch(payload)` when
   `supportsStreaming` is false. This keeps the facet working
   against any pre-W7 deployed supervisor. The only deployment
   shape where this matters is local wrangler dev with stale
   bundled code, but the symmetry is cheap.

2. **Did NOT lower `WAVE_FILES` or `WAVE_BYTES`.** That would have
   been a band-aid: smaller waves means more waves, which still
   accumulate in the wrapper isolate (just more slowly). The
   architectural fix is bounded-residency streaming RPC — exactly
   what W7 was built for.

3. **Did NOT add per-file RPCs.** Per-file RPCs would be even
   worse than batched: each call touches the wrapper isolate's
   message queue, accumulating per-call overhead. Streaming is
   the right primitive.

4. **No `setTimeout` / sleep / retry-with-delay anywhere.** The
   `supportsStreaming` gate is a synchronous typeof check. The
   stream RPC is bounded by the byte-source's pull/cancel
   contract (workerd handles flow control via the standard
   ReadableStream highwater mechanism).

5. **Did NOT touch the analyze() walker or the `ops` array
   assembly.** The pre-fix code's "1450/1595" progress is
   structurally correct (1595 ops to do, 1450 written before
   freeze). The freeze was downstream of the batch dispatch, not
   in the analyze walker.

## Commits

| SHA       | Phase | Description                                                                |
|-----------|-------|----------------------------------------------------------------------------|
| `1de5af2` | P1    | progress.md tracker + characterize via WS-driven trace                     |
| `02cdec5` | P2    | root cause via prod wrangler tail capture (2 OOMs on SupervisorRPC.stat)   |
| `d699a36` | P3    | src fix: W7_FRAME_PREAMBLE prepend + writeBatchStream branch in flushWave  |
| `5adffa2` | P4    | probe at audit/probes/git-freeze/clone-large-repo.mjs                      |
| `67211d4` | P5    | cross-wave 29/29 PASS preserved                                            |
| (P6.x)    | P6    | retro + wire probe into run-all + deploy + prod e2e verify                 |

## Prod E2E Verification

The original P3 freeze fix landed in deployed prod (`d185e0d1`). Driving
`audit/probes/git-freeze/clone-large-repo.mjs` against
`https://nimbus.ashishkmr472.workers.dev` showed the original "Updating
workdir 1450/1595" freeze IS gone — but a NEW prod-only failure
surfaced at the 2-second mark:

```
clone wall time: 2004 ms
FAIL: clone failed with: Cannot perform Construct on a detached ArrayBuffer
```

(`audit/probes/git-freeze/probe-prod-pre-fix-2026-05-09T14-40-45Z.txt`)

The wrangler-tail capture
`audit/probes/git-freeze/detached-buffer-tail-2026-05-09T14-35-39Z.jsonl`
confirmed: `_rpcWriteBatchStream` RPCs on script version `d185e0d1`
ending `outcome: "canceled"`, with no exception payload (the throw
bubbles through the facet's outer try/catch into a Response.json
error body, not a worker-level exception).

### Q1-Q3 — root cause + fix (Uint8Array aliasing)

Two-bug story uncovered in this verification wave:

**Bug A (Uint8Array aliasing across W7 byte-stream RPC).** Pre-fix
`src/git/network-facet.ts:421` stored caller-owned Uint8Array
references directly in `writeBuffer`. isomorphic-git's pack indexer
passes `subarray()` views over a packfile-sized parent ArrayBuffer;
multiple `writeFile` calls alias-share that single parent. pako's
inflate output reuse can also pass WHOLE-view Uint8Arrays that share
a parent without being "subarrays" by the
`byteOffset !== 0 || buffer.byteLength !== byteLength` test. When
`buildPayload` propagates the alias into `chunks[i].data` and the W7
encoder enqueues into a `type:'bytes'` ReadableStream, the stream
crosses **TWO RPC hops in prod** (facet → SupervisorRPC
WorkerEntrypoint → NimbusSession DO — see
`src/session/supervisor-rpc.ts:176`). The first hop's
ArrayBuffer transfer detaches the parent; ANY remaining view over it
throws "Cannot perform Construct on a detached ArrayBuffer" at the
next typed-array construction. Local probes did NOT repro because
in-process workerd dev shortcircuits cross-isolate transfer.

**Bug B (facet wrapper-isolate OOM during long checkouts).** With
Bug A fixed, the clone reaches the workdir-update phase, where the
facet's stateless-worker isolate accumulates ~2× wave-bytes during
each `await supervisor.writeBatchStream(stream)` — `writeBuffer`
holds copies + `payload.chunks` aliases them + the encoder queue
holds 256 KiB in flight. Across consecutive checkout RPCs the heap
inflates past 128 MiB and the facet OOMs. SAME stop-point as the
original P3-era freeze (1450/1601), DIFFERENT cause (memory, not the
OOM-on-stat deadlock that P3 fixed by switching to streaming). Bug
B was MASKED by Bug A: the detached-AB error fired before checkout
ever began. Q4-A verification (`probe-prod-post-fix-2026-05-09T14-54-31Z.txt`)
exposed it once Bug A was fixed.

### Q3-final fix — single-ownership at ingress + drop refs before await

Two coordinated changes inside `generateGitNetworkFacetCode()`:

1. **`writeFile`** — UNCONDITIONAL copy on the Uint8Array path.
   `new Uint8Array(data.length)` + `.set(data)` allocates a fresh
   dedicated ArrayBuffer per writeBuffer entry, with zero aliasing
   relation to the caller's parent. Q4-B verification
   (`probe-prod-post-fix-2026-05-09T15-04-00Z.txt`) confirmed an
   "only copy when subarray view" optimization REGRESSES back to
   detached-AB at 2 s — pako's whole-view-but-shared-parent pattern
   slips past the subarray test. Unconditional is the only safe
   choice.

2. **`flushWave`** — release `writeBuffer`, `dirBuffer`,
   `deleteBuffer` BEFORE `await`ing `writeBatchStream(stream)`.
   `payload` is the only consumer that needs the bytes for the
   duration of the await. After the clear, the chunk Uint8Arrays
   are reachable ONLY through `payload.chunks`, and as the W7
   encoder advances `chunkIdx` past consumed chunks the JS engine
   can collect them. Net facet-side residency during the await
   drops from ~2× wave bytes to ~1× wave bytes. Stats counters
   (`stats.filesWritten`, `stats.bytesWritten`) are computed from
   pre-clear snapshots so the rolled-up "[git] clone complete (N
   files, X bytes in Ts)" line stays accurate.

### Q4 GREEN evidence

| Deploy      | wallTime  | Result | Note |
|-------------|-----------|--------|------|
| `d185e0d1`  |  2 004 ms | FAIL   | Pre-fix prod (Q1 repro): detached-AB at 2 s |
| `bf5da24b`  | 46 568 ms | FAIL   | Q4-A: copy WITHOUT clear-before-await — Bug B exposed; OOM at 1450/1601 |
| `61e7aae7`  |  2 002 ms | FAIL   | Q4-B: subarray-only copy refinement regressed Bug A |
| `b29a1621`  | 12 012 ms | **PASS** | Q4-C: copy + clear-before-await — 1609 files, 1601/1601 |
| `6e1f53fd`  | 17 526 ms | **PASS** | Q4-D: confirmation run after comment cleanup; 1609 files, 1601/1601 |
| `6e1f53fd`  | 15 015 ms | **PASS** | Q7 final re-verify on the same deploy as Q4-D — 1609 files, 1598/1598 |

Real Nimbus clone time on prod: **11–17 s** (well within the
task-spec 10–60 s range, and definitively NOT the 2 s early-fail
signature). Working-tree count: **1609 files, 40 071–40 076 KB**.
Final progress frame: **1601/1601 (loaded === total)**, the exact
shape the probe asserts to lock the freeze invariant.

### Why prior local probes missed both bugs — local-vs-prod harness gap

Two distinct prod-only mechanisms hid the bugs from `wrangler dev`:

- **Bug A** needs ACTUAL cross-isolate ArrayBuffer transfer. Local
  workerd dev runs SupervisorRPC, NimbusSession DO, and the facet
  stateless worker in the same workerd process; transfer-by-reference
  shortcircuits prevent buffers from detaching. Prod runs them as
  three separate isolates (potentially across regions), forcing real
  byte transfer at each hop.

- **Bug B** needs LONG cumulative facet residency to inflate past
  128 MiB. Local dev tends to run smaller workloads (CI test repos),
  and even when given a real repo, GC pressure on a single-process
  workerd is fundamentally different from prod's per-isolate quotas.

The harness gap that allowed shipping `d185e0d1` to prod with both
bugs latent: **`audit/probes/git-freeze/clone-large-repo.mjs` was
P4-tested ONLY against `BASE=http://127.0.0.1:8797`**, which
shortcircuits the cross-isolate transfer that triggers Bug A. The
probe itself is correct — its assertions (clone completes, file count
matches, final frame is `loaded === total`) catch BOTH bugs. The
problem was running it ONLY against the harness-friendly base.

**Buffer-ownership-discipline note for future code.** Any code path
that crosses a Cloudflare RPC boundary as a `type:'bytes'`
ReadableStream MUST treat enqueued Uint8Arrays as transferred-on-pull.
The producer-side contract is fetch-once-consume-once: the buffered
write set must be the SOLE owner of each Uint8Array's underlying
ArrayBuffer at flush time, and the producer must drop its references
to those buffers before `await`ing the RPC if it wants the JS engine
to collect them as the consumer drains.

Two anti-patterns to avoid:
- Keeping a Map<key, Uint8Array> of pending bytes and ALSO building
  a chunks[] of the same Uint8Arrays. Either drop the Map ref before
  the await (preferred) or copy each chunk into a dedicated buffer.
- Using `data.subarray(i, j)` to chunk a large value across multiple
  enqueues on the SAME byte-stream controller. After the first
  transfer, the parent ArrayBuffer detaches and the next enqueue's
  subarray throws. Use `data.slice(i, j)` (allocates fresh) instead.

The wider lesson: **add a prod e2e probe BEFORE landing the local
probe**. Local probes are necessary but insufficient for any code
path that exercises the RPC fabric. Future surface to add prod e2e
coverage:
- npm install of a deps-heavy package (the encoder's
  multi-emit subarray loop in `src/_shared/w7-frame.ts:189-194` is
  latent dead code today only because both producers chunk at
  ≤ ENCODER_EMIT_CAP).
- Long-running shell processes that issue 1000+ supervisor RPCs in
  a burst.
- Any DO Facet pattern that wraps + forwards a stream across
  multiple RPC hops (the supervisor-rpc → DO double-hop is one
  example; there may be others).

### Q5 cross-wave (post-Q3-fix)

`audit/probes/phase5-regression/run-all.mjs` against local wrangler
dev on port 8792 (NIMBUS_DEBUG=1 enabled):

- **30 PASS, 0 FAIL, 0 SKIP, 0 TIMEOUT, 0 MISS** — total runtime
  33.3 s — `audit/probes/git-freeze/Q5-phase5-regression-2026-05-09T15-13-35Z.txt`.

tsc baseline: **2 errors** (unchanged from main:
`esbuild-wasm/esbuild.wasm` module-not-found + `SqliteVFSProvider`
FileType-string mismatch) — `audit/probes/git-freeze/Q5-tsc-baseline-2026-05-09.txt`.

Mossaic prod e2e: clone PASS in 4.5 s (427 files), npm install fails
on a pre-existing playwright bundle reject (~300 MB) — NOT a Q3
regression. `audit/probes/git-freeze/Q5-mossaic-prod-2026-05-09.txt`.

W1 wave1-regression: pre-existing FAIL (`node_modules/ not found`
after npm install reports success) — REPRODUCES on local AND prod
identically, NOT a Q3 regression.
`audit/probes/git-freeze/Q5-wave1-regression-prod-2026-05-09.txt`.

### Commits (this verification wave)

| SHA       | Phase | Description                                                                |
|-----------|-------|----------------------------------------------------------------------------|
| `718c98e` | Q1    | Prod tail repro + characterization of detached-AB on `d185e0d1`            |
| `96052b1` | Q2    | Root-cause analysis at `audit/probes/git-freeze/Q2-root-cause.md`          |
| `5cdb0e8` | Q3    | First-pass single-ownership at writeFile (unconditional copy)              |
| `e2bcc90` | Q3-fin/Q4 | flushWave clear-before-await + Q4 GREEN evidence (1601/1601, 11.1 s)   |
| `0bc67c5` | Q5/Q6 | Cross-wave snapshots + retro append (Prod E2E Verification section)        |
| `<this>`  | Q7    | Final prod re-verify (`6e1f53fd`) — 1609 files, 1598/1598 in 15.015 s, third independent GREEN |
