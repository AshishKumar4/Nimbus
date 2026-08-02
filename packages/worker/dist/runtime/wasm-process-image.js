/**
 * wasm-process-image.ts — checkpoint and restore a live wasm process.
 *
 * Why this is possible at all, and where the line is
 * ──────────────────────────────────────────────────
 * Page-level demand paging is not available to us. A compiled wasm load or
 * store is a raw machine access with no host hook, `memory.grow` is an
 * instruction rather than an import, and an out-of-bounds access traps in a
 * way that destroys the stack instead of faulting a page in. do86 gets demand
 * paging only because it is an *emulator*: v86 implements the x86 MMU in
 * software, so its `do_page_walk` can call an imported `swap_page_in` on a
 * miss. Guest memory there is data inside the wasm heap, not the wasm heap
 * itself. Nothing in that design transfers to natively-compiled Ruby or bash.
 *
 * Checkpointing at defined points is a different problem and it IS solvable,
 * because of a property of the toolchain we control:
 *
 *   Asyncify's unwind writes the entire wasm call stack INTO the module's own
 *   linear memory. At a park point the process's execution state is ordinary
 *   bytes at a known address.
 *
 * So for an Asyncify-instrumented module, linear memory plus the exported
 * mutable globals IS the whole process, program counter included, and a
 * restore followed by `asyncify_start_rewind` resumes at the exact
 * instruction. This is not a new trick in Nimbus — bash's `fork` already
 * relies on precisely this, copying memory and globals into a sibling
 * instance and rewinding it. Checkpointing to storage is the same operation
 * with a different destination.
 *
 * JSPI is the opposite case. A JSPI-suspended stack lives in engine-owned
 * memory, not in the module's linear memory, and there is no way to read or
 * reconstruct it. A JSPI process is therefore checkpointable only when no
 * suspension is live — between top-level calls, not mid-await.
 *
 * What a caller must supply and what it cannot get back
 * ────────────────────────────────────────────────────
 * An image covers what lives INSIDE the instance: linear memory and exported
 * mutable globals. Everything a runtime keeps on the JS side about the
 * process — the fd table, WASI preopens, the pipe graph, socket handles, the
 * scheduler's runnable set, Asyncify arena addresses — lives in the runner,
 * not the instance, and this module cannot see it. Callers pass it as
 * `hostState` and get it back verbatim on restore; correctness of that blob
 * is the runner's responsibility, not ours.
 *
 * Three things genuinely cannot be restored, and no caller should be told
 * otherwise:
 *   - a live JSPI suspension (engine-owned stack, unreadable);
 *   - open host resources behind an fd — sockets, in-flight fetches — which
 *     can be re-described but not resumed mid-flight;
 *   - non-exported mutable globals, which the host cannot observe. Modules
 *     whose state depends on them are not checkpointable, and
 *     `captureProcessImage` reports what it found so a caller can check.
 *
 * Storage
 * ───────
 * Images go to `ctx.storage.kv`, not the VFS: they are kernel state and have
 * no business being visible to `ls`. Measured on prod workerd — values up to
 * 2 MiB are accepted and 4 MiB fails with SQLITE_TOOBIG, so images are
 * chunked at 2 MiB. The whole path is synchronous by construction, which is
 * also what makes it atomic: no await means no interleaving, so no torn
 * image. The commit point is a single manifest write that happens last;
 * a failure before it leaves unreferenced chunks, never a half-image.
 */
import { WASM_PAGE_BYTES, accountLinearMemory } from './wasm-memory.js';
/** Largest value `ctx.storage.kv` accepts. Measured, not assumed. */
export const SWAP_CHUNK_BYTES = 2 * 1024 * 1024;
const IMAGE_VERSION = 1;
export class WasmImageIntegrityError extends Error {
    key;
    expected;
    actual;
    constructor(key, expected, actual) {
        super(`swap image '${key}' failed integrity check: expected ${expected}, got ${actual}`);
        this.key = key;
        this.expected = expected;
        this.actual = actual;
        this.name = 'WasmImageIntegrityError';
    }
}
export class WasmImageMissingError extends Error {
    key;
    constructor(key, detail) {
        super(`swap image '${key}' cannot be restored: ${detail}`);
        this.key = key;
        this.name = 'WasmImageMissingError';
    }
}
// ── integrity digest ─────────────────────────────────────────────────────────
//
// FNV-1a over 32-bit halves with a final avalanche. Synchronous on purpose:
// `crypto.subtle` is async, and an await inside capture would let another
// request touch the memory we are midway through reading. This is an
// integrity check against truncation and mis-assembly, not a security
// boundary — nothing here defends against a chosen-input attacker, and no
// caller should treat the content id as authentication.
function digestBytes(parts) {
    let h1 = 0x811c9dc5 | 0;
    let h2 = 0x01000193 | 0;
    for (const part of parts) {
        for (let i = 0; i < part.length; i++) {
            const b = part[i];
            h1 = Math.imul(h1 ^ b, 0x01000193);
            h2 = Math.imul(h2 + b + i, 0x85ebca6b) ^ (h1 >>> 13);
        }
        h2 = Math.imul(h2 ^ part.length, 0xc2b2ae35);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
    h1 ^= h1 >>> 13;
    h2 = Math.imul(h2 ^ (h2 >>> 16), 0xc2b2ae35);
    h2 ^= h2 >>> 16;
    const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
    return hex(h1) + hex(h2);
}
// ── capture ──────────────────────────────────────────────────────────────────
function requireMemory(instance) {
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
        throw new TypeError('wasm process image: instance does not export a `memory`');
    }
    return memory;
}
/**
 * Snapshot a parked wasm process.
 *
 * All-zero pages are elided: fresh wasm pages are zero-filled by the
 * specification, so a zero page restores identically whether it was written
 * or never touched. For a process like bash — which reserves a ~136 MiB
 * Asyncify arena it mostly never writes — this is the difference between a
 * 136 MiB image and a few MiB one.
 *
 * The caller is responsible for only calling this at a park point. This
 * module cannot verify that: `asyncify_get_state` reports whether an unwind
 * is in progress, but a module not built with Asyncify exports nothing to
 * check, and there is no honest way to detect a live JSPI suspension.
 */
export function captureProcessImage(instance, hostState = null) {
    const memory = requireMemory(instance);
    const view = new Uint8Array(memory.buffer);
    const pages = view.length / WASM_PAGE_BYTES;
    const residentPages = [];
    for (let page = 0; page < pages; page++) {
        const base = page * WASM_PAGE_BYTES;
        const end = base + WASM_PAGE_BYTES;
        for (let i = base; i < end; i++) {
            if (view[i] !== 0) {
                residentPages.push(page);
                break;
            }
        }
    }
    const body = new Uint8Array(residentPages.length * WASM_PAGE_BYTES);
    for (let i = 0; i < residentPages.length; i++) {
        const base = residentPages[i] * WASM_PAGE_BYTES;
        body.set(view.subarray(base, base + WASM_PAGE_BYTES), i * WASM_PAGE_BYTES);
    }
    const globals = [];
    const immutableGlobals = [];
    for (const [name, value] of Object.entries(instance.exports)) {
        if (!(value instanceof WebAssembly.Global))
            continue;
        let current;
        try {
            current = value.value;
        }
        catch {
            immutableGlobals.push(name);
            continue;
        }
        // An immutable global cannot be assigned on restore, so recording its
        // value would imply a fidelity we cannot deliver. Probe by writing it
        // back to itself: harmless for a mutable global, throws for a const one.
        try {
            value.value = current;
        }
        catch {
            immutableGlobals.push(name);
            continue;
        }
        globals.push(typeof current === 'bigint'
            ? { name, kind: 'bigint', value: current.toString() }
            : { name, kind: 'number', value: current });
    }
    return {
        image: {
            version: IMAGE_VERSION,
            pages,
            pageSize: WASM_PAGE_BYTES,
            residentPages,
            globals,
            immutableGlobals,
            contentId: digestBytes([body]),
            capturedAt: Date.now(),
            hostState,
        },
        body,
    };
}
/**
 * Write a captured image back into a fresh instance of the same module.
 *
 * The instance must be freshly created — restore writes the resident pages
 * but does NOT zero the rest, because a fresh wasm memory is already zero and
 * re-zeroing a 200 MiB address space costs more than the whole checkpoint.
 * Reusing a dirty instance would therefore leave its old bytes showing
 * through the elided pages, so that is rejected rather than silently allowed:
 * a restore target must be at or below the image's page count.
 */
export function restoreProcessImage(instance, image, body) {
    if (image.version !== IMAGE_VERSION) {
        throw new WasmImageMissingError(image.contentId, `unsupported image version ${image.version}`);
    }
    const expectedBody = image.residentPages.length * image.pageSize;
    if (body.length !== expectedBody) {
        throw new WasmImageIntegrityError(image.contentId, `${expectedBody} bytes`, `${body.length} bytes`);
    }
    const actual = digestBytes([body]);
    if (actual !== image.contentId) {
        throw new WasmImageIntegrityError(image.contentId, image.contentId, actual);
    }
    const memory = requireMemory(instance);
    const havePages = memory.buffer.byteLength / WASM_PAGE_BYTES;
    if (havePages > image.pages) {
        throw new WasmImageMissingError(image.contentId, `restore target has ${havePages} pages but the image describes ${image.pages}; ` +
            'a restore target must be a fresh instance no larger than its image');
    }
    if (havePages < image.pages)
        memory.grow(image.pages - havePages);
    const view = new Uint8Array(memory.buffer);
    for (let i = 0; i < image.residentPages.length; i++) {
        view.set(body.subarray(i * image.pageSize, (i + 1) * image.pageSize), image.residentPages[i] * image.pageSize);
    }
    for (const global of image.globals) {
        const target = instance.exports[global.name];
        if (!(target instanceof WebAssembly.Global)) {
            throw new WasmImageMissingError(image.contentId, `image expects an exported global '${global.name}' that this instance does not have`);
        }
        target.value = global.kind === 'bigint' ? BigInt(global.value) : global.value;
    }
    return image.hostState;
}
const MANIFEST_PREFIX = 'nimbus:swap:ref:';
const CHUNK_PREFIX = 'nimbus:swap:blob:';
/**
 * Durable swap space for parked wasm processes, over a DO's synchronous
 * sqlite key/value store.
 *
 * Images are content-addressed, so two processes checkpointed from the same
 * state share one copy of the bytes, and a re-checkpoint that changed nothing
 * writes nothing. The manifest write is the commit point and happens last: a
 * crash mid-write leaves chunks that no manifest references, which `sweep`
 * reclaims, rather than a manifest pointing at a partial image.
 */
export class WasmSwapStore {
    kv;
    chunkBytes;
    constructor(kv, chunkBytes = SWAP_CHUNK_BYTES) {
        this.kv = kv;
        this.chunkBytes = chunkBytes;
    }
    /** Checkpoint a parked process. Returns what it cost and what it elided. */
    swapOut(key, instance, hostState = null) {
        const { image, body } = captureProcessImage(instance, hostState);
        const liveBytes = accountLinearMemory(requireMemory(instance)).bytes;
        // Content addressing makes the blob write idempotent: identical bytes
        // already on disk need not be written again.
        const chunks = Math.ceil(body.length / this.chunkBytes) || 0;
        if (!this.kv.get(this.chunkKey(image.contentId, 0)) || chunks === 0) {
            for (let i = 0; i < chunks; i++) {
                const slice = body.subarray(i * this.chunkBytes, (i + 1) * this.chunkBytes);
                // Copy: a subarray shares the body's buffer, and storing a view would
                // persist the whole body under every chunk key.
                this.kv.put(this.chunkKey(image.contentId, i), slice.slice());
            }
        }
        const manifest = { image, chunks, bodyBytes: body.length };
        this.kv.put(MANIFEST_PREFIX + key, JSON.stringify(manifest));
        return {
            contentId: image.contentId,
            imageBytes: body.length,
            liveBytes,
            elidedBytes: liveBytes - body.length,
        };
    }
    /**
     * Restore a checkpointed process into a fresh instance, returning the
     * `hostState` the runner handed to `swapOut`.
     */
    swapIn(key, instance) {
        const { manifest, body } = this.read(key);
        return restoreProcessImage(instance, manifest.image, body);
    }
    /** Read an image without a restore target — for diagnostics and migration. */
    read(key) {
        const raw = this.kv.get(MANIFEST_PREFIX + key);
        if (typeof raw !== 'string') {
            throw new WasmImageMissingError(key, 'no manifest');
        }
        const manifest = JSON.parse(raw);
        const body = new Uint8Array(manifest.bodyBytes);
        let offset = 0;
        for (let i = 0; i < manifest.chunks; i++) {
            const chunk = this.kv.get(this.chunkKey(manifest.image.contentId, i));
            if (!chunk) {
                throw new WasmImageMissingError(key, `chunk ${i} of ${manifest.chunks} is absent`);
            }
            const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            body.set(bytes, offset);
            offset += bytes.length;
        }
        if (offset !== manifest.bodyBytes) {
            throw new WasmImageIntegrityError(key, `${manifest.bodyBytes} bytes`, `${offset} bytes`);
        }
        return { manifest, body };
    }
    has(key) {
        return typeof this.kv.get(MANIFEST_PREFIX + key) === 'string';
    }
    /** Drop a process's checkpoint. Shared chunks survive until `sweep`. */
    forget(key) {
        this.kv.delete(MANIFEST_PREFIX + key);
    }
    /**
     * Delete chunks no manifest references. Requires a `list`-capable store;
     * without one there is no way to enumerate orphans, and this reports so
     * rather than pretending it collected anything.
     */
    sweep() {
        if (!this.kv.list) {
            throw new TypeError('WasmSwapStore.sweep requires a kv store that supports list()');
        }
        const live = new Set();
        for (const [, raw] of this.kv.list({ prefix: MANIFEST_PREFIX })) {
            if (typeof raw !== 'string')
                continue;
            live.add(JSON.parse(raw).image.contentId);
        }
        let reclaimedChunks = 0;
        for (const [key] of this.kv.list({ prefix: CHUNK_PREFIX })) {
            const contentId = key.slice(CHUNK_PREFIX.length).split(':')[0];
            if (live.has(contentId))
                continue;
            this.kv.delete(key);
            reclaimedChunks++;
        }
        return { reclaimedChunks };
    }
    chunkKey(contentId, index) {
        return `${CHUNK_PREFIX}${contentId}:${index}`;
    }
}
