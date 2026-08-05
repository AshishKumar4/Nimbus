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
import { type OpencodeStageSpec } from '../facets/opencode-staging.js';
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
 * Reads the members a boot spec named by path off the session's own disk.
 * Supplied by the session, which owns the filesystem and the credential the
 * kernel reads its own image store with; the fabric never learns either.
 */
export interface ResidentDiskReader {
    readFile(path: string): Uint8Array;
}
/**
 * Complete a resident-process module map: read every member the spec named by
 * path, verifying each generated image against the digest its own path claims.
 * Runs inside the loader's cache-miss callback, so the bytes exist only for
 * the duration of the load.
 */
export declare function residentLoaderConfig(spec: ResidentCodeSpec, disk: ResidentDiskReader): Promise<Record<string, unknown>>;
/** The facet name for a process. Unique per pid, and pids never repeat. */
export declare function residentFacetName(pid: number): string;
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
    private readonly ctx;
    private readonly env;
    private readonly disk;
    private readonly coordDoId;
    constructor(ctx: DurableObjectState, env: unknown, disk: () => ResidentDiskReader);
    /**
     * Boot a resident process as a facet of this session and return its handle.
     * Resolves once the facet is up and its runner has been started; rejects on
     * boot failure.
     */
    startResidentProcess(spawn: ResidentProcessSpawn): Promise<ResidentProcessHandle>;
    /**
     * The dynamic worker's Durable Object class, minted in the caller's request
     * context. `LOADER.get` runs its callback only on a cache miss, so a process
     * assembles its module map at most once and the bytes never stay resident in
     * this DO's heap.
     */
    private _processClass;
    private _loaderConfig;
}
//# sourceMappingURL=process-fabric.d.ts.map