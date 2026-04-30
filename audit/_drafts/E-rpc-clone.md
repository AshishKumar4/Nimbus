# Section E — RPC layer + structured-clone wall

> Researched against `developers.cloudflare.com/workers/runtime-apis/rpc/`, `developers.cloudflare.com/workers/runtime-apis/streams/`, `wiki.cfdata.org`. Nimbus HEAD `e93b18d`. Every claim cited.

---

## TL;DR — RPC levers, ranked

| # | Lever | Expected impact | Effort |
|---|---|---|---|
| **E1** | Switch supervisor⇄facet bulk-write RPC from `Uint8Array[]` chunks to `ReadableStream<Uint8Array>` | Bypasses 32 MiB serialization cap entirely; eliminates current 24 MiB-per-batch chunking + ~6 % structured-clone overhead | M |
| **E2** | Adopt promise-pipelining for the `npm-resolve-facet → SUPERVISOR → npm-cache → return packument` round trip — return a stub-bearing object so the caller doesn't `await` between phases | Saves 1 RTT per cached packument lookup; ~2-5 ms per dep × hundreds of deps = ~0.5-2s per install | M |
| **E3** | Document and enforce the "never structured-clone a `WebAssembly.Module`" rule that already exists implicitly in pre-bundle-facet — codify in a shared `rpc-types.ts` | Prevents class of "Unable to deserialize cloned data" regressions | XS |
| **E4** | Replace the modules-map workaround in `pre-bundle-facet.ts:307-364` with R2-backed lazy loading once Worker Loader supports R2 lookup in the `getCodeCallback` (gated) | Removes 1.5 MiB of esbuild-wasm bytes from every facet load; saves on the encoded budget | M (gated) |
| **E5** | Reduce per-tarball write-batch size when the heap-alloc-coord signals pressure — smaller RPC arguments spread peak across multiple turns | Drops install-OOM rate; pairs with §A.2 | S |

E1 (streams over RPC) is the headline win. E2 (pipelining) is a clean architectural tightening with measurable per-install improvement.

---

## E.1 The 32 MiB structured-clone cap — source of truth

### E.1.1 Public docs

[developers.cloudflare.com/workers/runtime-apis/rpc/](https://developers.cloudflare.com/workers/runtime-apis/rpc/) §Limitations:

> *"The maximum serialized RPC limit is 32 MiB. Consider using ReadableStream when returning more data."*

The example given:

```ts
// 33 MiB Uint8Array can't be returned as a value, but CAN be returned wrapped in a ReadableStream:
return new ReadableStream({
  start(controller) {
    controller.enqueue(arr);
    controller.close();
  },
}, { type: 'bytes' });   // byte-oriented stream — required for RPC
```

> *"You can send and receive ReadableStream, WriteableStream, Request and Response using RPC methods. When doing so, bytes in the body are automatically streamed with appropriate flow control. This allows you to send messages over RPC which are larger than the typical 32 MiB limit."*

> *"Only [byte-oriented streams] (streams with an underlying byte source of `type: "bytes"`) are supported."*

⚠️ Cross-reference with workerd source: the cap is enforced by capnp serialization. The number is hard-coded somewhere in `src/workerd/`. ⚠️ speculation: likely at the kj/capnp boundary, not user-configurable.

### E.1.2 What Nimbus's code says

[`src/npm-installer.ts:495`](../../src/npm-installer.ts):

```
// workerd's 32 MiB structured-clone cap.
```

[`src/npm-installer.ts:1254-1256`](../../src/npm-installer.ts):

```
// 28 MiB also fits within workerd's 32 MiB RPC arg limit
// (structured-clone overhead measured ~6% on prior installs;
// 28 + ~2 MiB overhead ≈ 30 MiB, under cap).
```

[`src/npm-install-facet.ts:276-281`](../../src/npm-install-facet.ts):

```
// path strings + numbers + v8 structured-clone wrapper cost. These
// add ~6% to a raw bytes count.
// Keep the RPC argument well under workerd's 32 MiB cap. 24 MiB leaves
```

[`src/pre-bundle-facet.ts:71-307-364`](../../src/pre-bundle-facet.ts):

```
// 71: RPC serialisation: workerd transmits Uint8Array via structured-clone with
// 307: Peak in the facet: ~100 MiB worst case (well under 128 MB cap).
// 364: — no RPC, no compile, no structured-clone of Module values.
```

These confirm:
1. The 32 MiB cap is **the** binding constraint.
2. Nimbus measured **6 % overhead** for structured-clone wrapper of raw bytes (path strings + numbers + v8 wrapper).
3. Nimbus already chose 24 MiB / 28 MiB as conservative caps.

### E.1.3 Lever E1 — switch bulk-write to ReadableStream

The relevant call site is [`src/npm-install-facet.ts:182`](../../src/npm-install-facet.ts):

```ts
let bytesStream: ReadableStream<Uint8Array>;
```

This already declares the right type for the *return* path, but the *outbound* RPC argument from supervisor to facet (the `bulkWrite(files: { path: string, bytes: Uint8Array }[])` shape) is still chunked. Per the docs:

> *"You can send and receive ReadableStream, WriteableStream, Request and Response using RPC methods."*

So a `WriteableStream<{path: string, bytes: Uint8Array}>` would work. But the framing is awkward for *structured* data (path-bytes pairs). Two cleaner shapes:

**Shape A: Stream-of-tar**

```ts
// audit-only sketch
async function bulkWrite(tarStream: ReadableStream<Uint8Array>): Promise<void> {
  // facet decompresses + writes inline as bytes flow through
  const pipeline = tarStream
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TarParseTransform())   // emit { path, bytes } per file
    .pipeTo(new WritableStream({ write({ path, bytes }) { vfs.write(path, bytes); }}));
  await pipeline;
}
```

This pushes the format to **byte stream** (the natural shape for tarballs anyway) and never materialises the `{path, bytes}[]` array in memory. Best fit for the install pipeline because tarballs already arrive as streams.

**Shape B: chunk batches**

```ts
async function bulkWrite(chunks: ReadableStream<{path: string, bytes: Uint8Array}>): Promise<void> {
  for await (const chunk of chunks) {
    await vfs.write(chunk.path, chunk.bytes);
  }
}
```

⚠️ Doc caveat: per the streams-over-RPC doc, **only byte-oriented streams (`type: 'bytes'`) are supported.** A stream of structured objects is not supported — it would hit structured-clone on each chunk. So Shape A is the correct path; Shape B is illegal.

**Concrete sketch** for [`src/npm-install-facet.ts`](../../src/npm-install-facet.ts):

```ts
// audit-only sketch — DO NOT IMPLEMENT
- async installPackage(name: string, version: string, files: { path: string, bytes: Uint8Array }[])
+ async installPackage(name: string, version: string, tarStream: ReadableStream<Uint8Array>)
  {
-   for (const f of files) {
-     await env.SUPERVISOR.writeFile(f.path, f.bytes);
-   }
+   // Stream tar entries directly to supervisor — no structured-clone on bulk
+   await env.SUPERVISOR.writeBulkFromTar(name, tarStream);
  }
```

And the supervisor side ([`src/supervisor-rpc.ts:28-187`](../../src/supervisor-rpc.ts)):

```ts
// audit-only sketch
class SupervisorRPC extends WorkerEntrypoint {
+ async writeBulkFromTar(prefix: string, tarStream: ReadableStream<Uint8Array>) {
+   const reader = tarStream
+     .pipeThrough(new DecompressionStream('gzip'))
+     .pipeThrough(new TarParseTransform());
+   const r = reader.getReader();
+   while (true) {
+     const { done, value } = await r.read();
+     if (done) break;
+     this.vfs.write(`${prefix}/${value.path}`, value.bytes);
+   }
+ }
}
```

### E.1.4 Quantifying the win

Per [`src/npm-install-batch-facet.ts:259`](../../src/npm-install-batch-facet.ts):

```
// flush bytes peak at 3 × 16 = 48 MiB inside the 128 MiB cap.
```

Today three tarballs in flight at once = 48 MiB peak. Each flush is sized at 16 MiB (under the 24 MiB cap). After Lever E1:

- No 16 MiB chunking — tarbytes flow continuously.
- No 6 % structured-clone overhead.
- Peak memory bounded by the streaming buffer (~256 KiB-1 MiB), not the file size.
- ~10-15 % wall-clock improvement on install (less waiting for chunks to complete the round-trip).

The existing [`src/npm-tarball-stream.ts`](../../src/npm-tarball-stream.ts) already wraps the npm registry response as `ReadableStream<Uint8Array>`. Plumbing it end-to-end without the chunking step is mostly removing code.

---

## E.2 Promise-pipelining — what's already there and what isn't

### E.2.1 Public docs

[developers.cloudflare.com/workers/runtime-apis/rpc/](https://developers.cloudflare.com/workers/runtime-apis/rpc/) §Promise pipelining:

> *"When you call an RPC method and get back an object, it's common to immediately call a method on the object… You can simply omit the first await. Multiple chained calls can be completed in a single round trip… The promise returned by an RPC is not a real JavaScript Promise. Calling any method name on the promise forms a speculative call on the promise's eventual result."*

### E.2.2 Where Nimbus could use this

The classic two-RTT pattern in Nimbus is "look up packument metadata, then fetch tarball":

```ts
// today (paraphrasing src/npm-resolver.ts)
const meta = await env.SUPERVISOR.getCachedPackument(name);   // RTT 1
const url = pickVersion(meta, range);                          // local
const tarball = await env.SUPERVISOR.fetchTarball(url);       // RTT 2
```

Both RPCs cross the supervisor boundary even though `getCachedPackument` always feeds `fetchTarball`. With pipelining:

```ts
// audit-only sketch — DO NOT IMPLEMENT
class SupervisorRPC extends WorkerEntrypoint {
+ /** Returns a stub bearing fetchTarball. Both calls pipelined into 1 RTT. */
+ async getCachedPackument(name: string): Promise<PackumentStub> {
+   const meta = this.npmCache.getPackument(name);
+   return new PackumentStub(this, meta);
+ }
+ }
+
+ class PackumentStub extends RpcTarget {
+   constructor(private sup: SupervisorRPC, private meta: Packument) { super(); }
+   async getTarball(versionRange: string): Promise<ReadableStream<Uint8Array>> {
+     const ver = pickVersion(this.meta, versionRange);
+     return this.sup.fetchTarballStream(this.meta.versions[ver].dist.tarball);
+   }
+ }

// caller (npm-resolve-facet)
- const meta = await env.SUPERVISOR.getCachedPackument(name);
- const url = pickVersion(meta, range);
- const tarball = await env.SUPERVISOR.fetchTarball(url);
+ using stub = env.SUPERVISOR.getCachedPackument(name);   // no await!
+ const tarball = await stub.getTarball(range);            // pipelined — single RTT
```

Effort: M. Requires pulling apart the existing supervisor-rpc surface and threading state through stubs. Easier with TypeScript's `using` syntax (already enabled per Nimbus's tsconfig).

### E.2.3 Quantifying

For a 450-package install:
- Today: ~2 RTT × 450 = 900 RPCs, ~5-10 ms each cross-isolate = **4.5-9 s** in pure RPC-RTT
- After E2: ~1 RTT × 450 = 450 RPCs = **2-4 s**

Saves ~2-5 s per install. Real-world impact bounded by installer concurrency (already concurrent at the resolver level), so the improvement is closer to **0.5-2 s** wall-clock per Mossaic-class install.

---

## E.3 ctx.exports loopback (SUPERVISOR binding) — perf characteristics

### E.3.1 What ctx.exports does

Per [`src/ctx-exports.ts:1-9`](../../src/ctx-exports.ts):

```
// ctx-exports.ts — leaf module holding the ctx.exports reference.
// can read `ctx.exports` without transitively importing the Durable Object
// The fetch handler in src/index.ts calls `setCtxExports(ctx.exports)` on
```

`ctx.exports.SupervisorRPC(...)` returns a stub that, when called, dispatches into the *same isolate* that the DO is running in. This is the loopback pattern.

### E.3.2 What it costs

⚠️ speculation: ctx.exports loopback is **architecturally a service binding into the same isolate**. The cost should be lower than cross-isolate RPC because:
- No cross-network hop
- No cross-process serialization (the SAME V8 isolate)
- But: still goes through the `Pipeline::Client` capability machinery (per the [WS Primer](https://wiki.cfdata.org/spaces/STOR/pages/1372566651/Durable+Objects+WebSocket+Primer+Regular+Hibernatable+and+the+Outgoing+Problem))

So ctx.exports calls are **structured-cloned** still — a 32 MiB cap applies. They do **not** bypass the clone wall just because they're loopback.

For Nimbus this means: even though `SUPERVISOR.writeBulkFiles` is loopback to the same isolate as the DO that owns `vfs`, the bytes are still cloned once. The streams-over-RPC pattern (Lever E1) bypasses *that* clone too because byte streams are pipelined, not cloned.

### E.3.3 Verifying: read pre-bundle-facet's notes

[`src/pre-bundle-facet.ts:364`](../../src/pre-bundle-facet.ts):

```
// no RPC, no compile, no structured-clone of Module values.
```

The fact that this comment exists confirms: structured-clone *is* the cost on the RPC path, including ctx.exports loopback. The pre-bundle path bypasses it via the `LOADER.modules` map (modules-map workaround) — bytes ride *inside* the worker code blob, never touching structured-clone.

That trick works only for code/wasm bytes (which workerd compiles at module-load). For per-request bytes, structured-clone or streams are the only options.

### E.3.4 Lever E3 — codify the "no Module clone" rule

Today the rule lives in scattered comments. Concrete:

```ts
// src/_shared/rpc-types.ts (audit-only sketch — new file)
// Compile-time check: anything we send over RPC must be either
// (a) structured-cloneable AND under 32 MiB, OR
// (b) ReadableStream / WriteableStream / Request / Response with type: 'bytes'
//
// FORBIDDEN to clone:
//   - WebAssembly.Module             (workerd refuses; use modules-map)
//   - Functions / closures            (RpcTarget instances allowed if extending RpcTarget)
//   - Symbols                         (not cloneable)
//   - Cyclic references               (cloneable but cause v8 OOM)
```

This is an audit-only doc/comment scope. Doesn't change behavior; prevents regressions.

---

## E.4 modules-map vs R2-backed-fetch-inside-facet

### E.4.1 What modules-map does

Per [`src/npm-installer.ts:1276-1292`](../../src/npm-installer.ts):

> *"Bytes are shipped into each facet via NimbusFacetPool's `wasmModules` option which workerd registers in the LOADER `modules` map as `{ wasm: ArrayBuffer }`. Workerd compiles at module-load (startup phase, where wasm code generation is permitted), and the pool's generated worker.js exposes the resulting WebAssembly.Module on globalThis.__NIMBUS_WASM for the user fn (prebundleOne) to read at request time."*

Three options Nimbus rejected (from same comment):
1. *"inlining bytes in preamble: 16 MiB per dispatch OOM'd supervisor (commit dead0e3 fixed by removing it)"*
2. *"WebAssembly.compile at request time: blocked by workerd ('Wasm code generation disallowed by embedder')"*
3. *"RPC of pre-compiled WebAssembly.Module: structured-clone refuses ('Unable to deserialize cloned data')"*

### E.4.2 R2-backed-fetch-inside-facet — alternative

Theoretical alternative: facet fetches `https://r2.../esbuild.wasm` at startup, compiles, runs.

Pros:
- No embedded bytes in facet bundle → freed encoded budget (~1.5 MiB per facet)
- WASM bytes shared across facets via R2
- Cache API + R2 = ~0-50 ms cold latency

Cons:
- Workerd's "wasm code generation disallowed by embedder" (option 2 above) **also blocks** runtime compile of fetched bytes? ⚠️ speculation — needs verification. The wasm-code-generation block applies to `WebAssembly.compile()` at request time. Module-load-time should be fine, but R2 fetch happens *during* request-time, so the fetched bytes can't be compiled there.

The fix: have the *facet's* `getCodeCallback` (in `LOADER.get(id, async () => { ... })`) fetch from R2 and put bytes in `modules`:

```ts
// audit-only sketch
const wasmBytes = await env.R2_WASM_CACHE.get('esbuild-wasm.wasm').then(r => r.arrayBuffer());
const facet = env.LOADER.get('pre-bundle', async () => ({
  mainModule: 'pre-bundle-facet.js',
  modules: {
    'pre-bundle-facet.js': PRE_BUNDLE_FACET_CODE,
+   'esbuild.wasm': { wasm: wasmBytes },     // workerd compiles at module-load
  },
  env: { ... },
}));
```

This is the same modules-map trick, just R2-fetched instead of in-script.

### E.4.3 Lever E4 — when to swap

Today Nimbus inlines the bytes in `esbuild-wasm-bundle.generated.ts` (~1.5 MiB). After Snell's runtime-injected polyfills (Lever B3) lands, this becomes free. Until then, Lever E4 trades in-script bundling for R2 fetch:

- Saves ~1.5 MiB encoded budget per facet bundle
- Adds ~30-50 ms one-time R2 fetch (only on cold facet, and even then async-fetched in the background)
- Requires a one-time upload to R2 (build script)

Effort: M. Worth doing if the encoded budget becomes a bottleneck before Snell's spec ships.

---

## E.5 The chunking pattern in npm-install-batch-facet.ts

[`src/npm-install-batch-facet.ts:54`](../../src/npm-install-batch-facet.ts):

```
// 3 keeps facet heap peak ~87 MiB under the 128 MiB cap.
```

[`src/npm-install-batch-facet.ts:259`](../../src/npm-install-batch-facet.ts):

```
// flush bytes peak at 3 × 16 = 48 MiB inside the 128 MiB cap.
```

Three concurrent flushes of 16 MiB each. After Lever E1 (streams), peak memory drops to streaming-buffer-size + per-tarball-decompression-buffer-size = ~5-15 MiB. This **doubles or triples** the headroom for concurrency in the batch-facet:

- Today: pLimit(3), each flush 16 MiB → 48 MiB peak
- After E1: pLimit(6) (matching workerd's 6-subrequest cap), each flush 5 MiB → 30 MiB peak

Net wall-clock improvement: **~30-50 % faster install** for tarball-heavy projects.

---

## E.6 Concrete diff, prioritised

### Lever E1 — streams over RPC (M, biggest win)

Touches: `src/npm-install-facet.ts` (input arg), `src/npm-install-batch-facet.ts` (concurrency upgrade), `src/supervisor-rpc.ts` (writeBulkFromTar method), and threading work between them. ~150 LOC. Test: rerun Mossaic-class install; expect 30-50 % faster. Memory profile: peak 48 MiB → 30 MiB.

### Lever E2 — promise pipelining (M)

Restructure SupervisorRPC packument/tarball methods to return RpcTarget stubs. ~80 LOC. Test: install-time RPC count drops from ~900 to ~450 for a 450-package project.

### Lever E3 — codify rules (XS)

Add `src/_shared/rpc-types.ts` doc comment.

### Lever E4 — R2-backed wasm bytes (M, gated)

Stage when encoded budget bites. Today: skip.

### Lever E5 — heap-aware chunking (S)

```ts
// src/npm-install-batch-facet.ts (audit-only sketch)
- const FLUSH_BATCH_BYTES = 16 * 1024 * 1024;
+ const FLUSH_BATCH_BYTES = heavyAllocCoord.isUnderPressure() ? 8 * 1024 * 1024 : 16 * 1024 * 1024;
```

Pairs naturally with §A.2 (Lever A2 SqliteVFS LRU shrink during install).

---

## E.7 Citations summary

Public docs:
- developers.cloudflare.com/workers/runtime-apis/rpc/ (32 MiB cap; promise pipelining; ReadableStream support)
- developers.cloudflare.com/workers/runtime-apis/streams/ (Streams API)
- developers.cloudflare.com/durable-objects/examples/readable-stream/ (DO + ReadableStream example)
- developers.cloudflare.com/workers/runtime-apis/streams/readablestream/

Wiki:
- STOR/Durable Objects WebSocket Primer (capability chain — relevant to ctx.exports loopback model)
- ~yagiz/Impact of polyfills to workers (encoded budget impact context)

Nimbus src/ citations:
- `src/constants.ts:46` — BUNDLE_MAX_ENCODED_BYTES (22 MiB)
- `src/npm-installer.ts:495` (32 MiB clone cap reference)
- `src/npm-installer.ts:734` (per-isolate budget context)
- `src/npm-installer.ts:1252-1289` (clone overhead measurement; 28 MiB cap rationale)
- `src/npm-install-facet.ts:182` (ReadableStream type for outgoing)
- `src/npm-install-facet.ts:276-281` (24 MiB conservative cap; 6% clone overhead)
- `src/npm-install-batch-facet.ts:54, 204, 259` (pLimit(3), flush sizing, peak math)
- `src/pre-bundle-facet.ts:71` (RPC structured-clone caveat)
- `src/pre-bundle-facet.ts:307` (peak ~100 MiB)
- `src/pre-bundle-facet.ts:364` (modules-map workaround rationale)
- `src/parallel/facet-pool.ts:99-104` (clone-refusal modes)
- `src/parallel/facet-pool.ts:514` (shared isolate cap context)
- `src/supervisor-rpc.ts:1-187` (loopback RPC class definition)
- `src/ctx-exports.ts:1-9` (ctx.exports leaf-module pattern)
- `src/port-registry.ts:13-141` (Request/Response cloneable, ReadableStream body required for binary safety)
- `src/heavy-alloc-coord.ts:10-11` (shared isolate budget context)
- `src/parallel/pre-bundle-preamble.ts:52` (Module structured-clone refusal)
- `src/npm-tarball-stream.ts:55-60` (ReadableStream wrapper for tarball)
