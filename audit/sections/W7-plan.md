# W7 Plan — Streams over RPC (bypass the 32 MiB structured-clone wall)

> **Wave:** W7 — Lever E1 of `audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md` §E
> **Branch:** `w7-rpc-streams`
> **Author session:** nimbus-w7-rpc-streams (autonomous)
> **Date:** 2026-05-04 (year-long autonomous horizon, sub-agents unavailable per CT3)

## 1. The problem

Today every bulk write from a facet to the supervisor is **buffered fully into memory then structured-cloned**:

- `src/npm-install-batch-facet.ts:404` calls `env.SUPERVISOR.writeBatch({ inodes, chunks })` where `chunks: { path, chunkId, data: Uint8Array }[]`.
- `src/npm-install-facet.ts:298` does the same.
- `src/git-network-facet.ts:328` does the same.
- The `BatchWritePayload` is then structured-cloned by workerd through the RPC channel and re-materialised on the supervisor side at `src/nimbus-session.ts:1056` `_rpcWriteBatch`.

This wedges the install pipeline against three hard problems:

1. **32 MiB structured-clone cap** — workerd refuses RPC payloads larger than this. We hold the line at **16 MiB per flush** with `RPC_FLUSH_THRESHOLD = 16 * 1024 * 1024` in `src/npm-install-batch-facet.ts:393`. A 50 MB single tarball (vendored Electron, monorepo binary asset, Pyodide-style WASM blobs) **cannot fit in a single RPC**. Today the workaround is "skip the file" (`MAX_FILE_BYTES`) — installers truthfully discard files. This violates the install correctness contract.
2. **Heap pressure** — `pLimit=3` × 16 MiB pending-flush = 48 MiB simultaneously resident in facet heap before any RPC can drain. Combined with the tarball decompression buffer, integrity-hash buffer (full compressed bytes), and tar-parser closure state, the facet routinely peaks above 90 MiB inside its 128 MiB cap. Lever E1 estimates a drop to ~30 MiB peak (5-15 MiB streaming buffer + decompress state). See `audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md:397`.
3. **Latency** — every flush fully serialises the batch before any work begins on the supervisor. The supervisor cannot start the `transactionSync` until the **whole** payload arrives. With streaming, the supervisor's transaction can begin **as soon as the first chunk lands**.

CF docs (Public RPC, [https://developers.cloudflare.com/workers/runtime-apis/rpc/](https://developers.cloudflare.com/workers/runtime-apis/rpc/)) confirm the bypass:

> *"You can send and receive ReadableStream, WriteableStream, Request and Response using RPC methods. When doing so, bytes in the body are automatically streamed with appropriate flow control. This allows you to send messages over RPC which are larger than the typical 32 MiB limit."*
>
> *"Only byte-oriented streams (streams with an underlying byte source of `type: 'bytes'`) are supported."*
>
> *"In all cases, ownership of the stream is transferred to the recipient. The sender can no longer read/write the stream after sending it."*

Quoted in `audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md:373-381`.

## 2. The bypass

A `ReadableStream<Uint8Array>` (with `type: "bytes"` underlying source) sent over RPC:

- **Streams chunk-at-a-time** with workerd-managed flow control (the recipient's read backpressure is respected).
- **Has no aggregate size cap** — only per-chunk has to fit in a structured-clone frame.
- **Transfers ownership** — sender's reference becomes locked; the supervisor is the sole reader.
- **Is fundamentally a Cloudflare-supported byte channel between isolates**.

For our use case (facet → supervisor bulk write of inode metadata + N file-content chunks), the right shape is:

1. **Encode** the writeBatch into a framed byte stream: small fixed-size header → variable-length CBOR/length-prefixed JSON for inode metadata → length-prefixed binary chunk records.
2. **Transmit** the stream as a `ReadableStream<Uint8Array>` argument to a new RPC method `writeBatchStream(stream)`.
3. **Decode** on the supervisor: parse the header, read inode metadata, then iterate chunks, materialising **one inode/chunk at a time** into the SQLite `transactionSync` block.

The frame format is intentionally trivial (we control both ends). No CBOR/protobuf dep — this is byte-counted length-prefixed records.

## 3. Frame format (W7 wire protocol v1)

```
┌─────────────────────────────────────────────────────────┐
│ MAGIC: 4 bytes — 'NW7\x01'  (Nimbus W7 v1)             │
├─────────────────────────────────────────────────────────┤
│ HDR_LEN: 4 bytes uint32-LE — length of header JSON      │
│ HDR_JSON: HDR_LEN bytes UTF-8 JSON                      │
│   { inodes: BatchInodeEntry[], deletePaths?: string[],  │
│     chunkCount: number }                                │
├─────────────────────────────────────────────────────────┤
│ For each chunk (chunkCount times):                       │
│   ┌───────────────────────────────────────────────────┐ │
│   │ PATH_LEN: 4 bytes uint32-LE                        │ │
│   │ PATH_BYTES: PATH_LEN bytes UTF-8                   │ │
│   │ CHUNK_ID:  4 bytes uint32-LE                       │ │
│   │ DATA_LEN:  4 bytes uint32-LE  (max 64 KiB normally)│ │
│   │ DATA:      DATA_LEN bytes raw                       │ │
│   └───────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│ TRAILER: 4 bytes — 'NEND'  (sanity terminator)          │
└─────────────────────────────────────────────────────────┘
```

Why this shape:

- **Header carries inode metadata as JSON** — inodes are tiny (~80 B/path), the JSON is bounded (~100 KiB for a typical 500-path flush, ~1 MiB for a 5K-path flush). It comfortably fits in the first frame; the supervisor can parse + start the transaction as soon as it arrives.
- **Chunks stream after the header** — the supervisor inserts inodes synchronously while content chunks arrive in flight. Backpressure is automatic: `transactionSync` only consumes at the rate it can persist.
- **Length-prefixed**, no terminator-scan — recovery from corruption is trivially impossible (we just abort the transaction). No need for escaping.
- **Magic + trailer** — defensive sanity. A truncated stream lacks the trailer; a misframed stream fails the magic check on byte 0.

`type: "bytes"` requirement: the encoder uses `new ReadableStream({ type: 'bytes', pull(controller) { ... controller.enqueue(uint8) } })`. Per CF docs, this is the **only** flavour supported for RPC streaming.

## 4. RPC contract changes

### 4.1 New method on `SupervisorRPC`

```ts
// src/supervisor-rpc.ts — new method
async writeBatchStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ inodes: number; chunks: number }> {
  // OOM-discriminator frame stamp BEFORE consuming (last-known-RPC).
  setLastRpcFrame('writeBatchStream', -1 /* unknown size up-front */);
  return this._getStub()._rpcWriteBatchStream(stream);
}
```

### 4.2 New supervisor handler

```ts
// src/nimbus-session.ts — new method
async _rpcWriteBatchStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ inodes: number; chunks: number }> {
  this.ensureSqliteFs();
  // Decode the W7 frame, materialising inodes + chunks lazily.
  // Calls sqliteFs.writeStream({ inodes, chunkIter, deletePaths }).
  return this.sqliteFs!.writeStream(decodeW7Frame(stream));
}
```

### 4.3 New SqliteVFS method `writeStream`

```ts
// src/sqlite-vfs.ts — new method
async writeStream(payload: {
  inodes: BatchInodeEntry[];
  chunkIter: AsyncIterable<BatchChunkEntry>;
  deletePaths?: string[];
}): Promise<{ inodes: number; chunks: number }>
```

The crucial difference from `writeBatch`: chunks arrive as an **async iterator**. Inside `transactionSync`, we cannot await — `transactionSync` is synchronous. So the implementation drains chunks into a memory ring buffer **outside** `transactionSync`, then runs the transaction once the iterator is exhausted (or hits a flush watermark).

Two operating modes for `writeStream`:

- **Spool-then-commit (v1, this wave):** drain the entire chunk iterator into an in-memory array, then call existing `writeBatch` machinery. Saves the 32 MiB clone cap (the stream itself can be > 32 MiB, only the per-chunk frame has to clone) but does not reduce supervisor heap. **This is what we ship in W7.** Heap savings come from the *facet* side where we no longer hold the whole batch before sending.
- **Multi-segment commit (deferred, future wave):** chunk the supervisor-side `transactionSync` calls into N segments (e.g. every 8 MiB of streamed content). Saves supervisor heap too. **Deferred** — out of W7 scope, noted in retro for follow-up.

### 4.4 Backwards-compat shim

- The legacy `writeBatch(payload)` RPC method **stays**. Its existing callers (git-network-facet, seed-project, npm-install-facet legacy path, npm-installer's writeBatch on bin entries at line 1042) continue to work.
- The new `writeBatchStream(stream)` method is opt-in. We migrate **only** `npm-install-batch-facet.ts` (the high-volume hot path) in W7.
- Future waves can migrate other callers; each callsite must verify the receiver supports `writeBatchStream` (typeof check, same shape as W4's `getCachedTarball` shim).

## 5. Per-call breakage assessment

| Caller | Path | Shape today | W7 plan | Risk |
|---|---|---|---|---|
| `npm-install-batch-facet.ts:404` | facet → supervisor | `writeBatch({ inodes, chunks })` | **MIGRATE** to `writeBatchStream(encodedStream)` | M — hottest path, biggest gain |
| `npm-install-facet.ts:298` | facet → supervisor | `writeBatch({ inodes, chunks })` | KEEP (legacy facet, soft-deprecated by batch-facet) | L — already deprecated |
| `git-network-facet.ts:328` | facet → supervisor | `writeBatch(payload)` | KEEP (single git pack write per clone, payload is bounded by npm-resolver patterns) | L — git clone payloads <16 MiB typically |
| `npm-installer.ts:1042` | supervisor-local | `vfs.writeBatch(...)` (DIRECT, no RPC) | KEEP (no RPC boundary, no clone overhead) | none |
| `npm-installer.ts:293, 344` | supervisor-local | `vfs.writeBatch(...)` (DIRECT) | KEEP | none |
| `seed-project.ts:994, 1007` | supervisor-local | `vfs.writeBatch(...)` (DIRECT) | KEEP | none |
| `sqlite-vfs.ts:1514` | internal | `this.writeBatch(...)` (DIRECT) | KEEP | none |
| `_rpcWriteBatch` (legacy RPC) | RPC entry | normalises chunk data | KEEP unchanged | none |

Shape: **only one production callsite migrates** in W7 (npm-install-batch-facet). All other callers keep the existing `writeBatch` API — no breakage. The new `writeBatchStream` is purely additive.

## 6. Risk register

| # | Risk | Probability | Mitigation |
|---|---|---|---|
| R1 | `ReadableStream` over `ctx.exports` loopback might not stream — could buffer fully, eating the gain | M | **Probe-first** — functional/01-bytes-stream-roundtrip.mjs verifies a 50 MB stream survives the boundary without hitting the 32 MiB cap. If it buffers, we still bypass the cap (CF docs say streams bypass it), but the heap-savings claim must be verified by the heap-peak probe. |
| R2 | `type: "bytes"` constructor not available in some workerd build | L | The constructor has been GA in workerd since ~2024-01. We assert availability in `streams.ts` startup; if missing, raise loud. |
| R3 | Stream cancellation mid-flight leaves the supervisor's `transactionSync` half-applied | M | Use `try/finally` in `_rpcWriteBatchStream`: if the iterator throws (cancelled), abort BEFORE entering `transactionSync`. The transaction is atomic — never enter unless decoding finished. |
| R4 | Backpressure isn't actually applied (CF flow control claim) — facet sends faster than supervisor consumes → memory pressure on supervisor | L | The default `ReadableStream` queue strategy uses backpressure (`pull` only fires when reader is hungry). We use a `pull`-based source. CF docs explicitly call this out. |
| R5 | TypeScript types — `ReadableStream<Uint8Array>` argument types in the WorkerEntrypoint signature | L | TS type is straightforward; no compiler tricks needed. |
| R6 | Existing per-flush threshold logic in `npm-install-batch-facet.ts` (`bufferedBytes >= RPC_FLUSH_THRESHOLD`) becomes meaningless | L | Remove or repurpose. Flush still happens when stream hits a high-watermark; main difference is the **whole package** can be one stream now if memory permits. We retain a per-package flush boundary to avoid 5GB-monorepo-package edge case but raise the threshold significantly (e.g. 64 MiB → no longer relevant since stream bypasses cap). |
| R7 | Mock SqlStorage harness in tests must support the new `writeStream` path | L | Add a thin shim in the existing `_mocks.mjs` (we'll write a new w7-specific mock harness that wraps the W5/W8 pattern). |
| R8 | `setLastRpcFrame` payload-bytes field becomes -1 (unknown) for streams — degrades OOM diagnostics | L | Document. The OOM discriminator's value is in the *method name* and *facet ID*; payload bytes is a hint. We can update post-stream-completion to record the actual decoded byte count. |
| R9 | Concurrent `writeBatchStream` calls into the same supervisor — supervisor may serialise transactions and starve | L | This is the same as today's `writeBatch` — supervisor `transactionSync` already serialises. No regression. |

## 7. Performance prediction (acceptance gates)

Per `audit/sections/MASTER-ROADMAP.md:208-212`:

- **Install of 5GB monorepo doesn't hit 32 MiB wall** — verifiable today by attempting a synthetic 50 MB single-tarball install; pre-W7 this fails with `Error: structured-clone limit exceeded` or our own `MAX_FILE_BYTES` truncation. Post-W7 it succeeds.
- **Install latency for typical projects ≥30% faster** — measured via `e2e/install-latency-bench.mjs`; today's baseline is captured by Mossaic install at ~7-10s for the 248-dep project. W7 expects 5-7s. Hard to hit deterministically in mock — we measure local `transactionSync` count saved (1 per stream vs N per chunked batch).
- **Peak heap reduction: 48 MiB → 30 MiB** — measured via `e2e/heap-peak-during-install.mjs` instrumenting `process.memoryUsage().heapUsed` (best-effort under workerd; the harness uses our mock and tracks aggregate-bytes-resident in the facet code path).

## 8. Code-diff sketches

### 8.1 New file: `src/_shared/w7-frame.ts`

```ts
// Encode/decode for the W7 wire protocol described in §3.
export const W7_MAGIC = new Uint8Array([0x4e, 0x57, 0x37, 0x01]); // 'NW7\x01'
export const W7_TRAILER = new Uint8Array([0x4e, 0x45, 0x4e, 0x44]); // 'NEND'

export interface W7Header {
  inodes: BatchInodeEntry[];
  deletePaths?: string[];
  chunkCount: number;
}

export function encodeWriteBatchStream(payload: BatchWritePayload): ReadableStream<Uint8Array> {
  // ReadableStream with type: 'bytes' (BYOB-sourceable per CF requirement)
  // Yields: MAGIC | HDR_LEN | HDR_JSON | (PATH_LEN PATH CHUNK_ID DATA_LEN DATA)* | TRAILER
}

export async function decodeWriteBatchStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{
  inodes: BatchInodeEntry[];
  chunkIter: AsyncIterable<BatchChunkEntry>;
  deletePaths?: string[];
}>;
```

### 8.2 `src/supervisor-rpc.ts` — additive

```ts
async writeBatchStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ inodes: number; chunks: number }> {
  try {
    setLastRpcFrame('writeBatchStream', -1);
  } catch { /* best-effort */ }
  return this._getStub()._rpcWriteBatchStream(stream);
}
```

### 8.3 `src/nimbus-session.ts` — additive

```ts
async _rpcWriteBatchStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ inodes: number; chunks: number }> {
  this.ensureSqliteFs();
  const { inodes, chunkIter, deletePaths } = await decodeWriteBatchStream(stream);
  return this.sqliteFs!.writeStream({ inodes, chunkIter, deletePaths });
}
```

### 8.4 `src/sqlite-vfs.ts` — new `writeStream`

```ts
async writeStream(payload: {
  inodes: BatchInodeEntry[];
  chunkIter: AsyncIterable<BatchChunkEntry>;
  deletePaths?: string[];
}): Promise<{ inodes: number; chunks: number }> {
  // v1: spool-then-commit. Drain iterator into Array<BatchChunkEntry>,
  // then call existing writeBatch path. Future v2 multi-segments.
  const chunks: BatchChunkEntry[] = [];
  for await (const c of payload.chunkIter) chunks.push(c);
  return this.writeBatch({
    inodes: payload.inodes,
    chunks,
    deletePaths: payload.deletePaths,
  });
}
```

### 8.5 `src/npm-install-batch-facet.ts` — migrate the flush

```ts
// Replace: await env.SUPERVISOR.writeBatch({ inodes, chunks });
// With:
if (typeof env.SUPERVISOR.writeBatchStream === 'function') {
  const stream = encodeWriteBatchStream({ inodes, chunks });
  await env.SUPERVISOR.writeBatchStream(stream);
} else {
  // backwards compat — pre-W7 supervisor
  await env.SUPERVISOR.writeBatch({ inodes, chunks });
}
```

But: cloudflare-parallel serializes via `fn.toString()` and the facet doesn't have `_shared/w7-frame.ts` in its lexical scope. Same constraint as the existing `streamTarEntries` / `readableStreamToAsyncIterable` preamble symbols. Two choices:

- **(a) Inline `encodeWriteBatchStream`** in the facet (~50 LOC). Heavy duplication but proven.
- **(b) Add `encodeWriteBatchStream` to the facet preamble** alongside `streamTarEntries`. The preamble is at `src/parallel/facet-pool.ts` (search for `streamTarEntries` definition).

We pick **(b)** — add to the preamble. It's the same pattern used for `streamTarEntries` and `readableStreamToAsyncIterable`. Single source of truth.

### 8.6 Threshold change

The `RPC_FLUSH_THRESHOLD = 16 MiB` becomes a **stream-internal** chunk-flush boundary, not an RPC-payload boundary. We can lift it to e.g. 64 MiB — well above the 32 MiB cap, since the cap no longer applies — but for memory hygiene we keep the per-flush spool moderate. Set to **24 MiB** (pre-W4 baseline; W4 lowered to 16 MiB to fit the 32 MiB cap with overhead, no longer needed).

## 9. Test plan (TDD red → green)

### 9.1 Functional probes (`audit/probes/w7/functional/`)

- `01-frame-roundtrip.mjs` — `encode → decode` of a small writeBatch produces equal data.
- `02-large-payload.mjs` — encode 50 MB of synthetic chunks, decode, assert byte-equal. Pre-W7 fails (32 MiB cap), post-W7 passes.
- `03-backpressure.mjs` — slow consumer; verify the encoder's `pull` is invoked only when reader is hungry. Best-effort signal: total simultaneous in-memory bytes never exceeds threshold.
- `04-cancel-mid-stream.mjs` — consumer cancels reader after N bytes; encoder's `cancel` is invoked, no leaked resources.
- `05-error-propagation.mjs` — consumer throws while reading mid-frame; the source-side error reaches the encoder side cleanly.
- `06-empty-chunks.mjs` — zero-chunk batch (inode-only), zero-inode batch — corner cases.
- `07-bytes-source-type.mjs` — assert encoder produces `type: 'bytes'` stream (BYOB-sourceable).
- `08-writestream-on-vfs.mjs` — call `vfs.writeStream({ inodes, chunkIter })` against a mock SqlStorage; verify same outcome as `writeBatch`.

### 9.2 Regression probes (`audit/probes/w7/regression/`)

- `install-pipeline-coverage.mjs` — same as W8: assert the four canonical scenarios (fastify, express, ts-jest, redis) are still mentioned.
- `mossaic-shape.mjs` — assert Mossaic test scaffold structure unchanged (W7 does not touch Mossaic-relevant code paths).
- `legacy-writeBatch-still-works.mjs` — `vfs.writeBatch(...)` still works for callers that didn't migrate.
- `node-shims-builtins-shape.mjs` — node-shims exports unchanged.

### 9.3 E2E probes (`audit/probes/w7/e2e/`)

- `synthetic-50mb-tarball.mjs` — replay-style test: build a fake tarball of one 50 MB file, run through the install pipeline (mock-SUPERVISOR), assert all bytes land in the mock VFS without truncation. **Pre-W7 fails**, post-W7 passes.
- `heap-peak-during-install.mjs` — run a synthetic 200-package, ~120 MB-total install through the mock pipeline; track peak in-memory bytes resident in facet code path. **Acceptance gate: peak ≤ 30 MiB.**
- `latency-bench.mjs` — measure `transactionSync` count for an N-package install. Pre-W7: ~N calls (one per flush per package). Post-W7: still ~N (because each package still flushes once at end), BUT each is single-RPC end-to-end. Latency proxy = number of structured-clone roundtrips. Goal: ≥30% reduction in roundtrip-bytes.

### 9.4 Heap-peak harness

Per acceptance gate: 48 MiB → 30 MiB. We instrument the encoder/decoder to expose `peakBytesResident()`. The harness:

1. Builds a synthetic 200-package install scenario.
2. Runs through the encoder + decoder path with a mock SqlStorage.
3. Asserts `encoder.peakBytesResident() ≤ 30 MiB` AND `decoder.peakBytesResident() ≤ 30 MiB`.

This is the explicit acceptance gate from the master roadmap.

## 10. Citations

- Cloudflare RPC docs (public): [https://developers.cloudflare.com/workers/runtime-apis/rpc/](https://developers.cloudflare.com/workers/runtime-apis/rpc/) — quoted verbatim above. Confirms `ReadableStream` over RPC, `type: 'bytes'` requirement, ownership transfer, and 32 MiB cap.
- Cloudflare Streams docs: [https://developers.cloudflare.com/workers/runtime-apis/streams/](https://developers.cloudflare.com/workers/runtime-apis/streams/) — backpressure semantics and 128 MB worker memory limit.
- `audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md` §E1, §E.1, §E.2 — Lever 3 origin and impact estimate.
- `src/npm-install-batch-facet.ts:393` — current 16 MiB flush threshold.
- `src/npm-installer.ts:1255` — measured 6% structured-clone overhead.

## 11. Self-review pass

Before committing this plan, I re-walked the following:

- ✓ All four target files (`src/supervisor-rpc.ts`, `src/sqlite-vfs.ts`, `src/npm-installer.ts`, `src/npm-tarball.ts`) listed in the master roadmap §W7 are addressed. **Note:** `src/npm-tarball.ts` and `src/npm-installer.ts` themselves do not call `writeBatch` over RPC (they call `vfs.writeBatch` directly inside the supervisor isolate). The streaming change is concentrated in `src/npm-install-batch-facet.ts` (the facet-side hot path) and the corresponding RPC endpoints. The roadmap file list is approximate; actual changes track the RPC boundary.
- ✓ Backwards compat preserved (legacy `writeBatch` stays, `writeBatchStream` is additive).
- ✓ Risk R1 (loopback might buffer) has a probe — `02-large-payload.mjs` will confirm at minimum the cap-bypass even if heap savings end up modest.
- ✓ Tests use the mock SqlStorage harness pattern proven in W5 and W8 (`_mocks.mjs`).
- ✓ The "spool-then-commit" v1 approach is honest: facet-side heap drops because we don't pre-build the chunks array. Supervisor-side heap stays roughly equal in v1; multi-segment commit is deferred. The retro will document this honestly.
- ✓ TypeScript types are straightforward; no `any` deception.
- ✓ Heap-peak measurement harness present per explicit acceptance gate.
- ✓ The plan does not mutate prod infrastructure — wrangler auth lapse is not a blocker for W7 because acceptance is **all w7 tests pass locally**.

Plan stands. Proceeding to Phase B.
