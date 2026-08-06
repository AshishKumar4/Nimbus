/**
 * process-fabric.ts — the resident-process scheduler, and the process half of
 * the substrate it runs on.
 *
 * Every long-lived process Nimbus runs — node servers, python/ruby socket
 * servers, the opencode TUI and its headless server — runs as a **DO Facet**:
 * a named child actor whose class comes from a dynamic worker, opened by
 * `openResidentFacet` below.
 *
 *   ctx.facets.get(`proc-${pid}`, () => ({
 *     class: env.LOADER.get(workerKey, buildConfig)
 *              .getDurableObjectClass('NimbusProcess'),
 *   }))
 *
 * There is ONE process implementation. What varies is WHOSE `ctx` and `env`
 * that call runs against — the user's own session DO, or a sibling DO acting
 * as a host — and that choice is a single deployment-wide config value read in
 * `loaders/process-host.ts`. Nothing here, and nothing above here, branches on
 * which program is running: no spawn site picks its own substrate, and no
 * program name, mode or payload size reaches the selection.
 *
 * What each substrate costs, all of it measured on the production
 * compatibility shape (see `loaders/process-host.ts` for the operator-facing
 * version of this table):
 *
 *   facet  — spawn 8-16 ms warm. Memory independent: its OWN ~208 MiB
 *            envelope, identical whether the coordinator holds 0 or 128 MiB,
 *            with 1,664 MiB live across 8 facets + parent. CPU SHARED with
 *            its siblings, because facets are separate isolates inside one
 *            actor thread: awaiting I/O yields that thread completely (a
 *            sibling's RPC latency while a facet parks on a socket, on stdin
 *            or on an outbound call is indistinguishable from idle) but
 *            sustained CPU stalls every sibling for its full duration —
 *            a python HTTP server at 32-way saturation held siblings under
 *            1.06 s (p50 231 ms), the opencode attach TUI held them at the
 *            77 ms idle baseline, and a deliberate 9,956 ms CPU burn stalled
 *            them for 9,966 ms.
 *   peer   — spawn 242-359 ms, because every spawn pays a DO create plus a
 *            SQLite open. Memory AND CPU both independent: the process runs
 *            in a different workerd process, verified per placement rather
 *            than assumed (see `_placeDistinctPeer`).
 *
 * Both give the process its own SQLite. Neither changes what the process is:
 * the runner, the boot spec, the class name, the writer handshake and the
 * lifecycle contract are the same code either way.
 *
 * The facet's SUPERVISOR binding is minted for the COORDINATOR's doId, so
 * every syscall — VFS read/write, stdout/stderr frames, stdin pump,
 * registerPort, loopback HTTP — lands on the user's session DO wherever the
 * process runs. Because that binding is minted by an actor rather than by a
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
 *
 * By-path is what lets a boot spec reach EITHER substrate. Inline, pi's node
 * snapshot serialized to 44,252,709 bytes and died at workerd's 32 MiB RPC
 * ceiling the moment it had to cross to a peer; named by path it sends zero
 * bytes, and the host reads them off the coordinator's own disk through the
 * `ResidentDiskReader` it was given.
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
        const bytes = await disk.readFile(path);
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
    const source = new TextDecoder().decode(await disk.readFile(path));
    const actual = await facetImageDigest(source);
    if (actual !== expected) {
        throw new Error(`Nimbus: facet image '${path}' does not match its digest (read ${actual}); `
            + 'the image store is corrupt and the process cannot boot from it');
    }
    return source;
}
function facetContainer(ctx) {
    const facets = ctx.facets;
    if (!facets || typeof facets.get !== 'function') {
        throw new Error('Nimbus: ctx.facets is unavailable in this Durable Object; '
            + 'resident processes cannot be hosted');
    }
    return facets;
}
/** The facet name for a process. Unique per pid, and pids never repeat. */
export function residentFacetName(pid) {
    return `proc-${pid}`;
}
/**
 * Open a resident process as a facet of the actor whose `ctx` and `env` are
 * given, and start its runner.
 *
 * This is the ONE way a resident process comes into existence, and every
 * substrate goes through it: the facet host calls it with the coordinator's
 * own `ctx`, the peer host calls it — over one RPC — with a sibling session
 * DO's. Everything a substrate could plausibly want to special-case is a
 * PARAMETER here rather than a branch: which actor hosts the child, and how
 * the boot spec's by-path members are read.
 */
export function openResidentFacet(ctx, env, disk, supervisor, params) {
    const facets = facetContainer(ctx);
    const name = residentFacetName(params.pid);
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
            throw new Error(`Nimbus: resident process ${params.pid} is no longer running`);
        }
        if (evaluated) {
            throw new Error(`Nimbus: resident process ${params.pid} is no longer loaded (its facet was lost); `
                + 'it is not restarted');
        }
        evaluated = true;
        return { class: residentProcessClass(env, disk, supervisor, params) };
    };
    const facet = facets.get(name, start);
    let disposed = false;
    const release = async () => {
        if (disposed)
            return;
        disposed = true;
        released = true;
        try {
            facets.abort(name, new Error('Nimbus: resident process released'));
        }
        catch { /* already gone */ }
        try {
            facets.delete(name);
        }
        catch { /* already gone */ }
    };
    let started;
    try {
        started = facet.startProcess(params.startArgs);
    }
    catch (error) {
        void release();
        throw error;
    }
    // A caller reads whichever of `started` and the lifecycle it needs, so keep
    // the runtime from reporting the other as an unhandled rejection.
    started.catch(() => { });
    return {
        started,
        handleHttpRequest: (request) => facet.handleHttpRequest(request),
        release,
    };
}
/**
 * The dynamic worker's Durable Object class, minted in the caller's request
 * context. `LOADER.get` runs its callback only on a cache miss, so a process
 * assembles its module map at most once and the bytes never stay resident in
 * the hosting DO's heap.
 */
function residentProcessClass(env, disk, supervisor, params) {
    const loader = env.LOADER;
    if (!loader || typeof loader.get !== 'function') {
        throw new Error('Nimbus: env.LOADER binding missing or invalid. Resident processes require '
            + 'the Worker Loader binding; add it via worker_loaders in wrangler.jsonc.');
    }
    return loader
        .get(params.workerKey, () => residentWorkerConfig(env, disk, supervisor, params.boot))
        .getDurableObjectClass(RESIDENT_PROCESS_CLASS);
}
async function residentWorkerConfig(env, disk, supervisor, boot) {
    const config = boot.kind === 'staged'
        ? await assembleOpencodeFacetConfig(env, boot.stage)
        : await residentLoaderConfig(boot.code, disk());
    const ctxExports = getNimbusCtxExports();
    if (!ctxExports.SupervisorRPC) {
        throw new Error('Nimbus: ctx.exports.SupervisorRPC unavailable');
    }
    return { ...config, env: { SUPERVISOR: ctxExports.SupervisorRPC({ props: supervisor }) } };
}
// ── Handle ──────────────────────────────────────────────────────────────────
/**
 * Resource handle for one resident process — the whole surface the kernel
 * above this module sees: `booted()` for the boot payload, `done` for death,
 * `kill()` for teardown, `routeTarget` for inbound HTTP. Substrate-free: the
 * kernel cannot tell from it where the process is running, and never asks.
 *
 * `done` settles when the process ends: for a `lifetime` runner that is its
 * held-open startProcess settling (resolve on exit, reject on host death);
 * for a `boot` runner it is the kill that releases the host.
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
    host;
    constructor(host) {
        this.host = host;
    }
    /**
     * Boot a resident process on this deployment's substrate and return its
     * handle. Resolves once the process is up and its runner has been started;
     * rejects on boot failure.
     *
     * There is no decision in here. The substrate was chosen once, for the
     * deployment, and the only thing this method knows about it is the
     * `ProcessHost` interface.
     */
    async startResidentProcess(spawn) {
        // The facet-local append sequence starts at one when its module evaluates.
        // Bind that sequence to this concrete incarnation, then retire it only
        // after the host is released; a later incarnation must use a fresh one.
        const writerId = crypto.randomUUID();
        spawn.onWriterActivated(writerId);
        let hosted;
        try {
            hosted = await this.host.open({
                pid: spawn.pid,
                workerKey: spawn.workerKey,
                boot: spawn.boot,
                writerId,
                startArgs: spawn.startArgs,
            });
        }
        catch (error) {
            spawn.onWriterRetired(writerId);
            throw error;
        }
        const held = heldUntilKilled();
        // Runs at most once, however it is reached — the lifecycle ending, a kill,
        // or both. Retiring the writer twice would revoke an identity a later
        // incarnation had already been granted.
        let releasing = null;
        const release = () => {
            if (!releasing) {
                releasing = (async () => {
                    try {
                        await hosted.release();
                    }
                    finally {
                        spawn.onWriterRetired(writerId);
                    }
                })();
                releasing.catch(() => { });
            }
            return releasing;
        };
        // `lifetime`: the runner's startProcess IS the process, so its settlement
        // is the lifecycle. `boot`: the runner returns once it is up and the
        // process stays resident on its host, so residency ends only when the host
        // is released (kill) or the boot failed.
        const done = (spawn.startContract === 'lifetime'
            ? hosted.started.then(() => undefined)
            : hosted.started.then(() => held.promise)).finally(() => release());
        done.catch(() => { });
        return new ResidentProcessHandle({
            done,
            booted: () => hosted.started,
            routeTarget: { handleHttpRequest: (request) => hosted.handleHttpRequest(request) },
            kill: () => { held.release(); void release(); },
            describe: () => hosted.describe(),
        });
    }
}
