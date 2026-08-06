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
import { type OpencodeAssetsEnv, type OpencodeStageSpec } from '../facets/opencode-staging.js';
import type { RouteableFacetTarget } from '../runtime/port-registry.js';
/**
 * The class every generated resident runner exports. One name for every
 * runtime: the fabric names it unconditionally, so nothing about which program
 * is running reaches this module.
 */
export declare const RESIDENT_PROCESS_CLASS = "NimbusProcess";
/**
 * Runner contract for `startProcess()`. A property of the generated runner,
 * not of placement:
 *
 *   lifetime — the call is held open for the process's whole life and settles
 *              only at exit (opencode attached + server, attached-TTY node).
 *   boot     — the call returns a boot payload once the process is up and the
 *              facet stays resident as the coordinator's named child actor
 *              (node servers, the python/ruby socket runners).
 */
export type StartContract = 'lifetime' | 'boot';
/**
 * A generated module map. Only bounded, fixed-size module text rides inline;
 * anything whose size is a function of the user's disk is named by VFS path
 * and read when the facet loads, so the bytes are transient rather than
 * resident in the coordinator's heap.
 */
export declare const ResidentCodeSpecSchema: z.ZodObject<{
    compatibilityDate: z.ZodString;
    compatibilityFlags: z.ZodArray<z.ZodString>;
    mainModule: z.ZodString;
    modules: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        wasm: z.ZodCustom<ArrayBuffer, ArrayBuffer>;
    }, z.core.$strip>]>>;
    vfsWasmModules: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    vfsTextModules: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
export type ResidentCodeSpec = z.infer<typeof ResidentCodeSpecSchema>;
export declare const ResidentBootSpecSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"staged">;
    stage: z.ZodObject<{
        mode: z.ZodEnum<{
            oneshot: "oneshot";
            attached: "attached";
            server: "server";
        }>;
        argv: z.ZodArray<z.ZodString>;
        env: z.ZodRecord<z.ZodString, z.ZodString>;
        cred: z.ZodObject<{
            uid: z.ZodNumber;
            gid: z.ZodNumber;
            groups: z.ZodArray<z.ZodNumber>;
            umask: z.ZodNumber;
        }, z.core.$strip>;
        cwd: z.ZodString;
        stdin: z.ZodString;
        vfsBundle: z.ZodString;
        vfsManifest: z.ZodString;
        vfsMetadata: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"code">;
    code: z.ZodObject<{
        compatibilityDate: z.ZodString;
        compatibilityFlags: z.ZodArray<z.ZodString>;
        mainModule: z.ZodString;
        modules: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            wasm: z.ZodCustom<ArrayBuffer, ArrayBuffer>;
        }, z.core.$strip>]>>;
        vfsWasmModules: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        vfsTextModules: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strip>;
}, z.core.$strip>], "kind">;
export type ResidentBootSpec = z.infer<typeof ResidentBootSpecSchema>;
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
export declare const FACET_IMAGE_DIR = "var/lib/nimbus/facet-images";
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
export declare function facetImageDigest(source: string): Promise<string>;
export declare function facetImagePath(digest: string): string;
/**
 * The digest an image path claims, for the reader's verify-on-read. Content
 * addressing only holds if the bytes are checked against the name they were
 * fetched under; without that a truncated or overwritten image boots as
 * silently-wrong code, which in a facet surfaces as an unattributable
 * "Cannot find module" a long way from the corruption.
 */
export declare function facetImagePathDigest(path: string): string | null;
/** Structural surface of a NimbusLoadedEntrypoint RPC stub. */
export interface LoadedWorkerEntrypointStub {
    handleHttpRequest?: (request: Request) => Promise<Response>;
    fetch?(request: Request): Promise<Response>;
}
export interface NimbusCtxExports {
    SupervisorRPC?: (options: {
        props: {
            doId: string;
            pid: number;
            writerId: string;
        };
    }) => unknown;
    NimbusLoadedEntrypoint?: (options: {
        props: {
            key: string;
            name: string | null;
            depth: number;
            supervisor: {
                doId: string;
                pid: number;
                writerId: string;
            };
            stage?: OpencodeStageSpec;
        };
    }) => LoadedWorkerEntrypointStub;
}
export declare function getNimbusCtxExports(): NimbusCtxExports;
/**
 * Mint a NimbusLoadedEntrypoint stub for a keyed dynamic worker. Used by the
 * one-shot runtime paths, which run a program to completion inside a single
 * request rather than leaving it resident: their module map is assembled in
 * that stateless entrypoint's own isolate, never in a session DO.
 */
export declare function createLoadedWorkerEntrypoint(ctxExports: NimbusCtxExports, supervisor: {
    doId: string;
    pid: number;
    writerId: string;
}, stage: OpencodeStageSpec, name?: string | null): Promise<LoadedWorkerEntrypointStub>;
/**
 * Reads the members a boot spec named by path off the SESSION's disk — the
 * coordinator's, always, whichever substrate is doing the reading.
 *
 * The session supplies it, because it owns the filesystem and the credential
 * the kernel reads its own image store with; the fabric never learns either.
 * A host that runs inside the coordinator answers synchronously off the local
 * VFS; a host that runs elsewhere answers over the supervisor RPC. That is the
 * whole of the difference, and it is why the return type is widened rather
 * than the reader duplicated.
 */
export interface ResidentDiskReader {
    readFile(path: string): Uint8Array | Promise<Uint8Array>;
}
/**
 * Complete a resident-process module map: read every member the spec named by
 * path, verifying each generated image against the digest its own path claims.
 * Runs inside the loader's cache-miss callback, so the bytes exist only for
 * the duration of the load.
 */
export declare function residentLoaderConfig(spec: ResidentCodeSpec, disk: ResidentDiskReader): Promise<Record<string, unknown>>;
/**
 * The identity a resident process's SUPERVISOR binding is minted for. Always
 * the COORDINATOR's — a process hosted somewhere else still reads and writes
 * the user's disk, and still reports to the user's process table.
 */
export interface ResidentSupervisorProps {
    doId: string;
    pid: number;
    writerId: string;
}
/** Everything a host needs to run one process. Substrate-free by construction. */
export interface ProcessHostParams {
    /** Supervisor-assigned pid of the process entry on the coordinator. */
    pid: number;
    /** Keyed dynamic-worker identity (`nimbus-process:${doId}:${pid}`). */
    workerKey: string;
    /** What the process boots from. */
    boot: ResidentBootSpec;
    /** Binds the facet-local append sequence to this concrete incarnation. */
    writerId: string;
    /** Forwarded verbatim to the runner's startProcess. */
    startArgs: unknown;
}
/**
 * One resident process, as its coordinator sees it. Identical in meaning on
 * every substrate — that identity IS the abstraction, so a divergence here is
 * a bug rather than a documented difference.
 */
export interface HostedProcess {
    /**
     * The runner's startProcess payload. The runner is started as part of
     * opening the host, so this is a handle on that one boot — awaiting it twice
     * is safe and never re-starts anything. A `lifetime` runner settles it at
     * exit; a host that dies before then rejects it.
     */
    readonly started: Promise<unknown>;
    /** Inbound HTTP for the process's registered ports. */
    handleHttpRequest(request: Request): Promise<Response>;
    /**
     * Idempotent teardown. Settles only once the process is actually gone —
     * on a remote host that is a round trip, and the writer identity this
     * incarnation holds may not be retired before it completes.
     */
    release(): Promise<void>;
    /** Human-readable placement, for the NIMBUS_DEBUG process-log line. */
    describe(): string;
}
/**
 * The substrate a resident process runs on. One implementation per hosting
 * mechanism, one selection for the whole deployment — see
 * `loaders/process-host.ts`.
 */
export interface ProcessHost {
    open(params: ProcessHostParams): Promise<HostedProcess>;
}
/** `env.LOADER` — the Worker Loader binding, as used from inside a DO. */
interface WorkerLoaderBinding {
    get(id: string, code: () => Promise<unknown>): {
        getDurableObjectClass(name: string): unknown;
    };
}
/** The bindings `openResidentFacet` needs off whichever DO is hosting. */
export interface ResidentFacetEnv extends Partial<OpencodeAssetsEnv> {
    LOADER?: WorkerLoaderBinding;
}
/** The facet name for a process. Unique per pid, and pids never repeat. */
export declare function residentFacetName(pid: number): string;
/** What `openResidentFacet` hands back: a running process, minus its placement. */
export type ResidentFacet = Omit<HostedProcess, 'describe'>;
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
export declare function openResidentFacet(ctx: DurableObjectState, env: ResidentFacetEnv, disk: () => ResidentDiskReader, supervisor: ResidentSupervisorProps, params: ProcessHostParams): ResidentFacet;
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
export declare class ResidentProcessHandle {
    #private;
    readonly done: Promise<void>;
    /**
     * Inbound-HTTP target for PortRegistry: the running facet's own stub. A
     * facet is a child actor, so its stub stays usable in request contexts long
     * after the one that created it — which is the whole reason a resident
     * process can serve a port at all.
     */
    readonly routeTarget: RouteableFacetTarget;
    constructor(init: {
        done: Promise<void>;
        booted: () => Promise<unknown>;
        routeTarget: RouteableFacetTarget;
        kill: () => void;
        describe: () => string;
    });
    /**
     * The runner's startProcess payload. The runner is started as part of the
     * spawn, so this is a handle on that one boot — awaiting it twice is safe
     * and never re-starts anything. For a `lifetime` runner it settles at exit.
     */
    booted(): Promise<unknown>;
    get killed(): boolean;
    /** Human-readable placement, for the NIMBUS_DEBUG process-log line. */
    describePlacement(): string;
    /** Idempotent: abort the facet and release its isolate. */
    kill(): void;
}
export interface ResidentProcessSpawn {
    /** Declared by the runner the primitive generates. */
    startContract: StartContract;
    /** Supervisor-assigned pid of the process entry on the coordinator. */
    pid: number;
    /** Keyed dynamic-worker identity (`nimbus-process:${doId}:${pid}`). */
    workerKey: string;
    /** What the facet boots from. */
    boot: ResidentBootSpec;
    /** Forwarded verbatim to the runner's startProcess. */
    startArgs?: unknown;
    /**
     * Called before any concrete host capability can expose this writer.
     * A spawn must not proceed unless the supervisor accepts the authority.
     */
    onWriterActivated: (writerId: string) => void;
    /** Called only after the concrete host resources for this writer are revoked. */
    onWriterRetired: (writerId: string) => void;
}
export declare class ProcessFabric {
    private readonly host;
    constructor(host: ProcessHost);
    /**
     * Boot a resident process on this deployment's substrate and return its
     * handle. Resolves once the process is up and its runner has been started;
     * rejects on boot failure.
     *
     * There is no decision in here. The substrate was chosen once, for the
     * deployment, and the only thing this method knows about it is the
     * `ProcessHost` interface.
     */
    startResidentProcess(spawn: ResidentProcessSpawn): Promise<ResidentProcessHandle>;
}
export {};
//# sourceMappingURL=process-fabric.d.ts.map