# Q2 — Root cause: detached ArrayBuffer in W7 byte-stream RPC

## Summary

The original git-freeze (wrapper-isolate OOM at "Updating workdir
1450/1595", fixed by P3 commit `d699a36`) is gone in deployed prod
`d185e0d1`. The probe now fails ~2 s into the clone — **before** any
workdir update — with:

```
Cannot perform Construct on a detached ArrayBuffer
```

This is a new failure mode that the original wrapper-isolate OOM was
masking. Once W7 streaming made the supervisor side memory-bounded,
the underlying buffer-ownership violation in the producer became the
first thing to trip.

## File:line evidence

The bug lives at the boundary between the buffered fs adapter and the
W7 byte-stream encoder inside `generateGitNetworkFacetCode()`'s template
string body:

1. **`src/git/network-facet.ts:421` (pre-fix)** — `writeFile` body:
   ```js
   const buf = typeof data === 'string'
     ? new TextEncoder().encode(data)
     : (data instanceof Uint8Array ? data : new Uint8Array(data));
   ```
   The `data instanceof Uint8Array ? data` branch stores the **caller's
   Uint8Array directly** in `writeBuffer`. When the caller is
   isomorphic-git's pack-indexer, `data` is typically a `subarray(...)`
   over a single packfile-sized parent ArrayBuffer. Multiple writeFile
   calls (one per loose object) all share that single parent buffer.

2. **`src/git/network-facet.ts:310`** — `buildPayload` for the small-file
   path:
   ```js
   if (size <= CHUNK_SIZE) {
     chunks.push({ path, chunkId: 0, data });   // ← aliases writeBuffer entry
   }
   ```
   `data` here is the same Uint8Array stored in `writeBuffer`.

3. **`src/_shared/w7-frame.ts:189`** — encoder `pull()`:
   ```js
   enqueue(controller, data);
   ```
   `data` enters the `type:'bytes'` ReadableStream. When the stream
   chunks cross the RPC boundary in `supervisor.writeBatchStream(stream)`
   (`src/git/network-facet.ts:371`), workerd transfers the underlying
   ArrayBuffer to the receiver. The transfer **detaches the parent
   ArrayBuffer** in our isolate.

4. **The next write or read of any other Uint8Array view that shares
   the same parent ArrayBuffer** then throws "Cannot perform Construct
   on a detached ArrayBuffer". This can happen at:
   - the encoder's next `enqueue(controller, otherChunkSubarray)` call,
   - or `fs.readFile`'s `new TextDecoder().decode(writeBufferEntry)`
     when isomorphic-git reads back a path whose buffer was just
     transferred.

The error doesn't have to throw on the same path that triggered the
transfer. ANY view over the parent buffer is now invalid.

## Why prod and not local

Local probes (P4 `clone-large-repo.mjs` against
`http://127.0.0.1:8797`) ran clean. Prod fails reliably.

The difference is the RPC topology:

- **Local wrangler dev**: single workerd process, all bindings live in
  the same isolate group. Transfers across "RPC boundaries" inside one
  workerd shortcircuit — chunks pass by reference; underlying buffers
  never actually detach. The buffer-ownership violation is silent.

- **Prod**: SupervisorRPC is a `WorkerEntrypoint`-class binding (its
  own isolate) and `NimbusSession` is a Durable Object (a third
  isolate, possibly cross-region). The byte stream traverses TWO
  cross-isolate hops:
  ```
  facet → SupervisorRPC.writeBatchStream → this._getStub()._rpcWriteBatchStream → NimbusSession DO
  ```
  Each hop performs real ArrayBuffer transfer per
  https://developers.cloudflare.com/workers/runtime-apis/rpc/ ("Streams
  are transferred"). The double-hop forwarding inside SupervisorRPC
  (`src/session/supervisor-rpc.ts:176`) is correct in itself; what
  breaks is the producer-side aliasing.

## Why npm install (same encoder) didn't surface this

`src/npm/install-batch-facet.ts:467` uses identical
`encodeWriteBatchStream` + `writeBatchStream` plumbing. But the
producer there is `streamTarEntries(asyncIter)` — each yielded
`entry.data` is a freshly allocated Uint8Array out of pako's gunzip
inflator. **No shared parent ArrayBuffer.** The aliasing constraint is
naturally satisfied; ownership is fetch-once-consume-once by
construction.

The git-network-facet's buffered fs adapter is the only producer that
violates the contract.

## Hypothesis disposition

| H   | Description                                            | Status                             |
|-----|--------------------------------------------------------|------------------------------------|
| H-A | network-facet transfers a buffer caller still holds    | **CONFIRMED** — root cause         |
| H-B | r2-cache L2 caches Response consumed twice             | Rejected — git path doesn't use r2-cache |
| H-C | fanout-pool peer-DO RPC transfers buffer supervisor holds | Rejected — git path is single-DO |
| H-D | W7 frame codec multi-emit loop transfers downstream re-read | Latent (dead code on git+npm; chunks always ≤ ENCODER_EMIT_CAP) — NOT fixed in this wave |

## Fix shape

Per task constraint — "ensure single ownership (fetch-once-consume-once
contract)" — the fix is at the SINGLE ingress point
(`network-facet.ts` `writeFile`). The buffered fs adapter promises
that what it stores in `writeBuffer` has its own dedicated
ArrayBuffer, no aliasing of caller buffers. Cost: one O(N) copy per
writeFile. Eliminates the alias-and-transfer hazard for ALL downstream
consumers (encoder enqueue + readFile fallback + readdir state).

NOT a defensive `.slice()` scattered at every read site. ONE invariant
at ONE producer site.
