/**
 * process-fabric.ts — the resident-process scheduler.
 *
 * Every long-lived process Nimbus runs — node servers, python/ruby socket
 * servers, the opencode TUI and its headless server — runs as a **DO Facet**
 * of the user's session Durable Object: a named child actor whose class comes
 * from a dynamic worker the coordinator loads itself.
 *
 *   ctx.facets.get(`proc-${pid}`, () => ({
 *     class: env.LOADER.get(workerKey, buildConfig)
 *              .getDurableObjectClass('NimbusProcess'),
 *   }))
 *
 * There is ONE placement, so there is nothing to schedule and nothing above
 * this module may branch on. What a facet buys, all of it measured on the
 * production compatibility shape:
 *
 *   memory   — a facet gets its OWN ~208 MiB envelope, identical whether the
 *              coordinator holds 0 or 128 MiB; 8 facets + parent held
 *              1,664 MiB live under one DO. A facet OOM leaves the
 *              coordinator's memory and boot id intact, and a coordinator OOM
 *              leaves the facet's.
 *   spawn    — 8-16 ms warm, against 242-359 ms for a sibling DO (which pays
 *              a DO create + SQLite open on every single spawn).
 *   serving  — a facet is addressed by NAME, so the coordinator re-resolves it
 *              in any later request context and serves inbound HTTP, SSE and
 *              WebSockets straight through. Sibling DOs cannot: an entrypoint
 *              to a dynamically-loaded worker may not be transferred between
 *              Workers.
 *   payload  — the loader callback runs INSIDE the coordinator, so a boot spec
 *              never crosses an RPC boundary and workerd's 32 MiB argument
 *              limit does not apply to it.
 *
 * The honest cost: facets are separate isolates inside the parent's SINGLE
 * actor thread. A facet awaiting I/O yields it completely — a sibling's RPC
 * latency while a facet parks on a socket, on stdin or on an outbound call is
 * indistinguishable from idle — but a facet spending sustained CPU stalls
 * every sibling AND their syscalls for that duration. Measured on the real
 * workloads: a python HTTP server at 32-way saturation held siblings under
 * 1.06 s (median 231 ms, degrading proportionally), the opencode attach TUI
 * held them at the 77 ms idle baseline with a ~1.4 s boot spike, while a
 * deliberate 9,956 ms CPU burn in the same placement stalled them for
 * 9,966 ms. So this fabric hosts I/O-bound resident processes. Nimbus's
 * CPU-heavy work — clang, esbuild, npm install — does not route through it.
 *
 * The facet's SUPERVISOR binding is minted from the COORDINATOR's ctx.exports
 * for the COORDINATOR's doId, so every syscall — VFS read/write, stdout/stderr
 * frames, stdin pump, registerPort, loopback HTTP — lands on the user's
 * session DO. Because that binding is minted by an actor rather than by a
 * stateless entrypoint, it lives as long as the process does; nothing has to
 * hold a call open to keep it alive.
 *
 * Boot specs
 * ──────────
 * A resident process boots from one of two specs, and in both cases the module
 * map is assembled LAZILY inside the loader's cache-miss callback — so the
 * artifact sources are materialized only when the facet actually starts, and
 * only for as long as the load takes:
 *
 *   staged — an OpencodeStageSpec; `assembleOpencodeFacetConfig` fetches the
 *            artifact sources from ASSETS.
 *   code   — a generated module map (node / python / ruby runners). Fixed-size
 *            module text rides inline; anything sized by the user's disk is
 *            named BY VFS PATH and read through the injected disk reader. A
 *            ruby server's `ruby+stdlib.wasm` alone is 34.3 MiB and a node
 *            facet's disk snapshot reached 44 MB for pi.
 */
import { z } from 'zod/v4';
import { OpencodeStageSpecSchema, assembleOpencodeFacetConfig, } from '../facets/opencode-staging.js';
import { getCtxExports } from '../session/ctx-exports.js';
/**
 * The class every generated resident runner exports. One name for every
 * runtime: the fabric names it unconditionally, so nothing about which program
 * is running reaches this module.
 */
export const RESIDENT_PROCESS_CLASS = 'NimbusProcess';
/**
 * A generated module map. Only bounded, fixed-size module text rides inline;
 * anything whose size is a function of the user's disk is named by VFS path
 * and read when the facet loads, so the bytes are transient rather than
 * resident in the coordinator's heap.
 */
export const ResidentCodeSpecSchema = z.object({
    compatibilityDate: z.string().min(1),
    compatibilityFlags: z.array(z.string()),
    mainModule: z.string().min(1),
    /**
     * Inline modules: fixed-size generated source, plus small wasm sidecars that
     * come from the worker's own ASSETS rather than the user's disk.
     */
    modules: z.record(z.string(), z.union([z.string(), z.object({ wasm: z.instanceof(ArrayBuffer) })])),
    /**
     * Module name → absolute VFS path of a wasm image to materialize at load.
     * This is how the big user-installed runtimes travel: ruby's
     * interpreter+stdlib image alone is 34.3 MiB.
     */
    vfsWasmModules: z.record(z.string(), z.string()).optional(),
    /**
     * Module name → absolute VFS path of a GENERATED module source, read as
     * UTF-8 at load. The same by-path posture as `vfsWasmModules`, for module
     * text whose size is a function of the user's disk.
     *
     * A node facet carries a snapshot of that disk, and it is the largest thing
     * Nimbus generates: pi's is 3096 cells and inline it serialized to
     * 44,252,709 bytes. That text cannot be rebuilt from the user's files at
     * load time either — two thirds of the cells are esbuild ESM→CJS output, and
     * the manifest and metadata members are walks of the tree rather than files
     * in it. So the generator materializes its output in the content-addressed
     * image store below and the spec names it.
     */
    vfsTextModules: z.record(z.string(), z.string()).optional(),
});
export const ResidentBootSpecSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('staged'), stage: OpencodeStageSpecSchema }),
    z.object({ kind: z.literal('code'), code: ResidentCodeSpecSchema }),
]);
// ── Boot-image store ────────────────────────────────────────────────────────
/**
 * Where a generated module source is materialized so a boot spec can name it.
 *
 * Outside any user working tree on purpose. The passes that build a node
 * facet's snapshot enumerate the process's cwd, so an image written under one
 * would be swept into the next snapshot — and that snapshot is what produced
 * the image, so each spawn would grow the thing it just wrote.
 *
 * Kernel-owned and world-readable: the generator writes as CRED_KERNEL, and
 * every process reads through a supervisor binding that enforces its own
 * credential. Mode 0644 is what makes the read succeed for any process by
 * construction rather than by a privilege carve-out in the permission layer,
 * and leaves the bytes beyond reach of the user whose program they encode.
 */
export const FACET_IMAGE_DIR = 'var/lib/nimbus/facet-images';
/**
 * An image is named by the SHA-256 of its own bytes, so its name IS its
 * integrity check and a stale image is not something to invalidate but
 * something that cannot be addressed: different generated text is a different
 * path.
 *
 * What that actually dedups, measured on a deployed worker rather than
 * assumed: a RESTART resolves to the image already there, because the fabric
 * replays one unchanged boot spec. Two separate spawns of the same tool do
 * NOT, whenever the generated text carries anything per-process: an
 * attached-TTY spawn bakes `NIMBUS_CP_CHILD_PID` into `__NIMBUS_ARGS`, so `pi`
 * twice wrote two images (2c3a90ad… then c5b74f1a…). A spawn with no attached
 * TTY has no pid in its args and does dedup. Lifting argv/env/pid out of the
 * generated text into `startArgs` would make every image per-PROGRAM and
 * shareable across spawns and sessions; the sweep bounds the store either way.
 */
export async function facetImageDigest(source) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function facetImagePath(digest) {
    return `/${FACET_IMAGE_DIR}/${digest}.js`;
}
/**
 * The digest an image path claims, for the reader's verify-on-read. Content
 * addressing only holds if the bytes are checked against the name they were
 * fetched under; without that a truncated or overwritten image boots as
 * silently-wrong code, which in a facet surfaces as an unattributable
 * "Cannot find module" a long way from the corruption.
 */
export function facetImagePathDigest(path) {
    const match = /(?:^|\/)([0-9a-f]{64})\.js$/.exec(path);
    return match ? match[1] : null;
}
export function getNimbusCtxExports() {
    const ctxExports = getCtxExports();
    if (!ctxExports || typeof ctxExports !== 'object') {
        throw new Error('Nimbus: ctx.exports unavailable');
    }
    return ctxExports;
}
/**
 * Mint a NimbusLoadedEntrypoint stub for a keyed dynamic worker. Used by the
 * one-shot runtime paths, which run a program to completion inside a single
 * request rather than leaving it resident: their module map is assembled in
 * that stateless entrypoint's own isolate, never in a session DO.
 */
export async function createLoadedWorkerEntrypoint(ctxExports, supervisor, stage, name = null) {
    if (!ctxExports.NimbusLoadedEntrypoint) {
        throw new Error('Nimbus: ctx.exports.NimbusLoadedEntrypoint unavailable');
    }
    return await ctxExports.NimbusLoadedEntrypoint({
        props: {
            key: `nimbus-process:${supervisor.doId}:${supervisor.pid}`,
            name,
            depth: 0,
            supervisor,
            stage,
        },
    });
}
/**
 * Complete a resident-process module map: read every member the spec named by
 * path, verifying each generated image against the digest its own path claims.
 * Runs inside the loader's cache-miss callback, so the bytes exist only for
 * the duration of the load.
 */
export async function residentLoaderConfig(spec, disk) {
    const resolved = {};
    for (const [moduleName, path] of Object.entries(spec.vfsWasmModules ?? {})) {
        const bytes = disk.readFile(path);
        resolved[moduleName] = {
            wasm: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
    }
    for (const [moduleName, path] of Object.entries(spec.vfsTextModules ?? {})) {
        resolved[moduleName] = await readFacetImage(disk, path);
    }
    return {
        compatibilityDate: spec.compatibilityDate,
        compatibilityFlags: spec.compatibilityFlags,
        mainModule: spec.mainModule,
        modules: { ...spec.modules, ...resolved },
    };
}
/**
 * Read one content-addressed facet image and verify it against the digest its
 * path claims. Content addressing is only a guarantee if the bytes are checked
 * against the name they arrived under: an image that was truncated, or
 * replaced by something the generator never wrote, would otherwise be loaded
 * as the program and fail somewhere inside it with no way back to the cause.
 */
async function readFacetImage(disk, path) {
    const expected = facetImagePathDigest(path);
    if (!expected) {
        throw new Error(`Nimbus: '${path}' is not a content-addressed facet image path`);
    }
    const source = new TextDecoder().decode(disk.readFile(path));
    const actual = await facetImageDigest(source);
    if (actual !== expected) {
        throw new Error(`Nimbus: facet image '${path}' does not match its digest (read ${actual}); `
            + 'the image store is corrupt and the process cannot boot from it');
    }
    return source;
}
function facetHost(ctx) {
    const facets = ctx.facets;
    if (!facets || typeof facets.get !== 'function') {
        throw new Error('Nimbus: ctx.facets is unavailable in this session Durable Object; '
            + 'resident processes cannot be hosted');
    }
    return facets;
}
/** The facet name for a process. Unique per pid, and pids never repeat. */
export function residentFacetName(pid) {
    return `proc-${pid}`;
}
// ── Handle ──────────────────────────────────────────────────────────────────
/**
 * Resource handle for one resident process — the whole surface the kernel
 * above this module sees: `booted()` for the boot payload, `done` for death,
 * `kill()` for teardown, `routeTarget` for inbound HTTP.
 *
 * `done` settles when the process ends: for a `lifetime` runner that is its
 * held-open startProcess settling (resolve on exit, reject on facet death);
 * for a `boot` runner it is the kill that releases the facet.
 *
 * The handle is disposable so FacetManager's existing per-pid resource
 * tracking tears a process down exactly the way it releases any other
 * per-process resource.
 */
export class ResidentProcessHandle {
    done;
    /**
     * Inbound-HTTP target for PortRegistry: the running facet's own stub. A
     * facet is a child actor, so its stub stays usable in request contexts long
     * after the one that created it — which is the whole reason a resident
     * process can serve a port at all.
     */
    routeTarget;
    #booted;
    #kill;
    #killed = false;
    #describe;
    constructor(init) {
        this.done = init.done;
        this.#booted = init.booted;
        this.routeTarget = init.routeTarget;
        this.#kill = init.kill;
        this.#describe = init.describe;
        // Symbol.dispose may be absent from older lib targets; wire defensively
        // so disposeRpcResource() (which probes for it) finds the disposer.
        const disposeSym = Symbol.dispose;
        if (disposeSym) {
            Object.defineProperty(this, disposeSym, { value: () => this.kill() });
        }
    }
    /**
     * The runner's startProcess payload. The runner is started as part of the
     * spawn, so this is a handle on that one boot — awaiting it twice is safe
     * and never re-starts anything. For a `lifetime` runner it settles at exit.
     */
    booted() {
        return this.#booted();
    }
    get killed() {
        return this.#killed;
    }
    /** Human-readable placement, for the NIMBUS_DEBUG process-log line. */
    describePlacement() {
        return this.#describe();
    }
    /** Idempotent: abort the facet and release its isolate. */
    kill() {
        if (this.#killed)
            return;
        this.#killed = true;
        try {
            this.#kill();
        }
        catch { /* best-effort teardown */ }
    }
}
/** A promise that settles only when the process is killed. */
function heldUntilKilled() {
    let release = () => { };
    const promise = new Promise((resolve) => { release = resolve; });
    return { promise, release };
}
export class ProcessFabric {
    ctx;
    env;
    disk;
    coordDoId;
    constructor(ctx, env, disk) {
        this.ctx = ctx;
        this.env = (env ?? {});
        this.disk = disk;
        this.coordDoId = ctx.id.toString();
    }
    /**
     * Boot a resident process as a facet of this session and return its handle.
     * Resolves once the facet is up and its runner has been started; rejects on
     * boot failure.
     */
    async startResidentProcess(spawn) {
        // The facet-local append sequence starts at one when its module evaluates.
        // Bind that sequence to this concrete incarnation, then retire it only
        // after the facet is released; a later incarnation must use a fresh one.
        const writerId = crypto.randomUUID();
        spawn.onWriterActivated(writerId);
        const facets = facetHost(this.ctx);
        const name = residentFacetName(spawn.pid);
        // The start callback is the ONLY way this facet is ever created, and it
        // fires AT MOST ONCE. Every later use goes through the stub below, so the
        // callback running a second time means the facet was released or died —
        // and re-running it would evaluate the user's program again, answering a
        // request from a process they never started while the one they did start
        // is gone. Both cases are reported instead.
        let evaluated = false;
        let released = false;
        const start = async () => {
            if (released) {
                throw new Error(`Nimbus: resident process ${spawn.pid} is no longer running`);
            }
            if (evaluated) {
                throw new Error(`Nimbus: resident process ${spawn.pid} is no longer loaded (its facet was lost); `
                    + 'it is not restarted');
            }
            evaluated = true;
            return { class: this._processClass(spawn, writerId) };
        };
        const facet = facets.get(name, start);
        const release = () => {
            released = true;
            try {
                facets.abort(name, new Error('Nimbus: resident process released'));
            }
            catch { /* already gone */ }
            try {
                facets.delete(name);
            }
            catch { /* already gone */ }
            spawn.onWriterRetired(writerId);
        };
        let started;
        try {
            started = facet.startProcess(spawn.startArgs);
        }
        catch (error) {
            release();
            throw error;
        }
        const held = heldUntilKilled();
        // `lifetime`: the runner's startProcess IS the process, so its settlement
        // is the lifecycle. `boot`: the runner returns once it is up and the facet
        // stays resident as this session's named child actor, so residency ends
        // only when the facet is released (kill) or the boot failed.
        const done = (spawn.startContract === 'lifetime'
            ? started.then(() => undefined)
            : started.then(() => held.promise)).finally(release);
        // A caller reads whichever of these it needs — `booted()` for a boot
        // payload, `done` for the lifecycle — so keep the runtime from reporting
        // the other as an unhandled rejection when a boot fails.
        started.catch(() => { });
        done.catch(() => { });
        return new ResidentProcessHandle({
            done,
            booted: () => started,
            routeTarget: { handleHttpRequest: (request) => facet.handleHttpRequest(request) },
            kill: () => { held.release(); release(); },
            describe: () => `facet '${name}' of session ${this.coordDoId.slice(-12)}`,
        });
    }
    /**
     * The dynamic worker's Durable Object class, minted in the caller's request
     * context. `LOADER.get` runs its callback only on a cache miss, so a process
     * assembles its module map at most once and the bytes never stay resident in
     * this DO's heap.
     */
    _processClass(spawn, writerId) {
        const loader = this.env.LOADER;
        if (!loader || typeof loader.get !== 'function') {
            throw new Error('Nimbus: env.LOADER binding missing or invalid. Resident processes require '
                + 'the Worker Loader binding; add it via worker_loaders in wrangler.jsonc.');
        }
        const supervisor = { doId: this.coordDoId, pid: spawn.pid, writerId };
        return loader
            .get(spawn.workerKey, () => this._loaderConfig(spawn.boot, supervisor))
            .getDurableObjectClass(RESIDENT_PROCESS_CLASS);
    }
    async _loaderConfig(boot, supervisor) {
        const config = boot.kind === 'staged'
            ? await assembleOpencodeFacetConfig(this.env, boot.stage)
            : await residentLoaderConfig(boot.code, this.disk());
        const ctxExports = getNimbusCtxExports();
        if (!ctxExports.SupervisorRPC) {
            throw new Error('Nimbus: ctx.exports.SupervisorRPC unavailable');
        }
        return { ...config, env: { SUPERVISOR: ctxExports.SupervisorRPC({ props: supervisor }) } };
    }
}
