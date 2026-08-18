/**
 * process-fabric.ts — the resident-process scheduler, and the process half of
 * the substrate it runs on.
 *
 * Every long-lived process Nimbus runs — node servers, python/ruby socket
 * servers, an agent TUI and its headless server — runs as a **DO Facet**:
 * a named child actor whose class comes from a dynamic worker, opened by
 * `openResidentFacet` in `workerd-facet-host.ts`.
 *
 *   ctx.facets.get(`proc-${pid}`, () => ({
 *     class: env.LOADER.get(workerKey, buildConfig)
 *              .getDurableObjectClass('NimbusProcess'),
 *   }))
 *
 * There is ONE process implementation. What varies is WHOSE `ctx` and `env`
 * that call runs against — the user's own session DO, or a sibling DO acting
 * as a host — and that choice is a single deployment-wide config value read in
 * `process-host.ts`. Nothing here, and nothing above here, branches on
 * which program is running: no spawn site picks its own substrate, and no
 * program name, mode or payload size reaches the selection.
 *
 * What each substrate costs, all of it measured on the production
 * compatibility shape (see `process-host.ts` for the operator-facing
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
 *            1.06 s (p50 231 ms), an attached full-screen TUI held them at the
 *            77 ms idle baseline, and a deliberate 9,956 ms CPU burn stalled
 *            them for 9,966 ms.
 *   peer   — spawn 242-359 ms, because every spawn pays a DO create plus a
 *            SQLite open. Memory AND CPU both independent: the process runs
 *            in a different workerd process, verified per placement rather
 *            than assumed (see `_place` in `process-host.ts`).
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
 *   staged — an embedder-defined stage spec; the registered
 *            {@link StagedBootAssembler} fetches the artifact sources
 *            (Nimbus's staged artifacts come from ASSETS).
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
import type { RouteableFacetTarget } from '@nimbus-sh/core/runtime/os-contracts.js';
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
 *              only at exit (an attached TUI or its held-open server, attached-TTY node).
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
/**
 * The boot-spec union, with the staged arm's payload validated by the
 * embedder's own stage schema. The fabric defines the SHAPE of the union —
 * `staged` boots assemble through the registered {@link StagedBootAssembler},
 * `code` boots through {@link residentLoaderConfig} — but what a stage IS
 * belongs to whoever registered the assembler, so the schema is composed
 * rather than fixed. The embedder parses with this at its RPC trust boundary;
 * the assembler re-validates at use either way.
 */
export declare function residentBootSpecSchema<Stage extends z.ZodType>(stageSchema: Stage): z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"staged">;
    stage: Stage;
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
export type ResidentBootSpec = {
    kind: 'staged';
    stage: unknown;
} | {
    kind: 'code';
    code: ResidentCodeSpec;
};
/**
 * Assemble a complete Worker Loader config from a staged-artifact spec. The
 * embedder supplies this: a stage names artifact sources only the embedder
 * knows how to fetch (Nimbus's largest staged artifact is a ~23 MB module map from
 * ASSETS), and the assembler runs inside the loader's cache-miss callback so
 * those sources are materialized only while the facet actually loads.
 * `env` is whichever hosting actor's env the facet is opened with.
 */
export type StagedBootAssembler = (env: unknown, stage: unknown) => Promise<object>;
/** Registered once at composition time, first-write-wins. */
export declare function setStagedBootAssembler(assembler: StagedBootAssembler): void;
export declare function requireStagedBootAssembler(): StagedBootAssembler;
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
    /**
     * Rejects if the HOST dies under a process that is already up — the one
     * failure a substrate can suffer that the process itself never reports.
     *
     * It is not symmetric, and pretending otherwise is what leaks a process. A
     * facet dies only with the Durable Object that owns it, which takes the
     * coordinator and this handle with it, so there is nothing to observe and
     * this never settles; its death shows up at the next use, loudly. A peer can
     * die on its own, the held host leg says so, and throwing that away would
     * leave a `boot`-contract process routing to a corpse until someone killed
     * it by hand.
     */
    readonly lost: Promise<never>;
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
 * How a whole session-filesystem image can reach a process on a substrate, and
 * what stops it.
 *
 * This is the one place the two substrates are NOT interchangeable, so it is
 * stated rather than smoothed over. Everything else about a process is the
 * same code either way; this is not, and an operator flipping the config is
 * changing it.
 */
export interface ProcessImageDelivery {
    /**
     * Whether the hosting actor can hand a process its whole SQLite by
     * copy-on-write, present before the process's first instruction.
     *
     * `same-object` — possible in principle: the host and the source live in one
     *   Durable Object, which is the only scope `ctx.facets.clone` works in.
     *   Measured on production workerd at 18-31 ms for a 45.73 MB pi-shaped
     *   corpus and 34-54 ms for 1 GB — flat across a 256x size range, because
     *   nothing is copied.
     * `impossible` — and not for want of an implementation. Clone is
     *   same-Durable-Object, bookmarks are same-Durable-Object, and workerd
     *   exposes no `VACUUM INTO`, no `ATTACH` and no `sqlite3_backup` to reach
     *   across one. A peer-hosted process can only ever receive an image
     *   through `moduleCeilingBytes` below, or by streaming it.
     *
     * Reachable in PRODUCTION but not from a type checker or `wrangler dev`, and
     * the difference is worth stating precisely because inferring one from the
     * other is how a wrong claim gets written down. `@cloudflare/workers-types`
     * 4.20260605.1 declares `get`/`abort`/`delete` and no `clone`, and the pinned
     * workerd is 1.20260603.1 — but the deployed runtime is Cloudflare's, not the
     * one wrangler bundles, and there it is present and works: enumerating the
     * binding on a live Worker at this repo's own compatibility_date returns
     * `["abort","clone","constructor","delete","get"]`, and a clone into a
     * destination of a DIFFERENT class had all 500 seeded files readable from the
     * destination's CONSTRUCTOR. No compat-date gate. So calling it is a
     * lockfile-and-types problem, not a platform one.
     *
     * The hazard that comes with it, measured rather than assumed: ANY `src`
     * that does not resolve to a populated facet — a typo, a name not created
     * yet, not merely the obvious `''`/`'.'`/`'/'` — silently EMPTIES the
     * destination and reports success. Validation has to be positive on both
     * ends: the source exists and is populated before, the destination is
     * non-empty after. A blocklist of bad names would pass a typo straight
     * through and wipe a process's filesystem while returning ok. Enforced by
     * `cloneFacetStorage` in the workerd host, which is the one way the fabric
     * calls clone.
     */
    readonly reflink: 'same-object' | 'impossible';
    /**
     * Bytes one process's whole module map may carry — the channel that does
     * work today, on both substrates, because the loader runs on whichever actor
     * hosts the facet. Enforced where the map is assembled, since the loader's
     * own refusal names no member.
     */
    readonly moduleCeilingBytes: number;
    /**
     * Whether the process's SQLite is spent out of the SESSION's storage budget
     * or its own. This cuts the opposite way from `reflink` and is why neither
     * substrate simply wins: a facet shares roughly 10 GiB with the session root
     * and every sibling and clone under it, with no copy-on-write credit — N
     * forks of an X-byte image need X*(N+1) — and crossing it does not raise an
     * error, it resets the object with "Internal error in Durable Object storage
     * caused object to be reset". A peer brings its own budget per host.
     */
    readonly storageSharedWithSession: boolean;
}
/**
 * The substrate a resident process runs on. One implementation per hosting
 * mechanism, one selection for the whole deployment — see
 * `process-host.ts`.
 */
/**
 * A one-shot's module map: every member inline.
 *
 * Deliberately without {@link ResidentCodeSpec}'s by-path members. A resident
 * process names its large members by VFS path because the map has to reach
 * whichever actor ends up hosting it; a one-shot's is assembled and consumed
 * inside a single call, so a path buys nothing and a host that accepted one
 * would be promising a read it never performs.
 */
export interface OneShotCodeSpec {
    compatibilityDate: string;
    compatibilityFlags: string[];
    mainModule: string;
    modules: Record<string, string | {
        wasm: ArrayBuffer;
    }>;
}
/**
 * Everything a host needs to run one program to completion.
 *
 * Separate from {@link ProcessHostParams} because the two differ in whether
 * anything survives the call, and every other difference follows from that: a
 * one-shot has no route target, no independent death to observe and no
 * residency to release. One spec carrying all of it would leave three members
 * meaningless for half its uses.
 */
export interface OneShotParams {
    /** Supervisor-assigned pid — the identity the callback capability reports as. */
    pid: number;
    /**
     * Binds this run's VFS appends to this concrete incarnation. Supplied by the
     * caller rather than minted here so it can revoke the identity it authorised
     * instead of one it has to read back.
     */
    writerId: string;
    /**
     * The module map, assembled on demand.
     *
     * A thunk, and that is load-bearing rather than stylistic. The map is the
     * largest thing a session builds — pi's is ~23 MB — and it is dead the moment
     * the loader has taken it. Building it inside the load is what keeps it out
     * of the caller's frame, which would otherwise hold a second full copy of the
     * program for as long as the program runs.
     */
    code(): Promise<OneShotCodeSpec>;
    /** The invocation. Its body carries argv/env/cwd; its signal bounds the run. */
    request: Request;
    /**
     * Called before any capability able to write as `writerId` exists, and only
     * if this host can mint one at all. Granting append authority to an identity
     * nothing will ever present would leave a writer live with no writer.
     */
    onWriterActivated(writerId: string): void;
    /**
     * Called once the program is loaded and about to be entered.
     *
     * The boundary between paying for the isolate and paying for the program.
     * They are separate costs with separate fixes — a 12 s exec was once read as
     * a slow load and was a fresh isolate parsing a 23 MB map — and only the host
     * can see where one ends and the other begins.
     */
    onLoaded?(): void;
}
export interface ProcessHost {
    /** What this substrate can and cannot deliver, for operators and callers. */
    readonly imageDelivery: ProcessImageDelivery;
    /**
     * Run one program to completion and hand its response to `consume`.
     *
     * Scoped to the call rather than returned, because the isolate that produced
     * the response must outlive the reading of its body. A host that released its
     * stubs before the caller had read would sever a body still streaming, and
     * one that buffered instead would hold a second copy of every result — the
     * cost the thunk above exists to avoid. `consume` runs while the program's
     * resources are still held; they are released as it returns.
     */
    runOnce<T>(params: OneShotParams, consume: (response: Response) => Promise<T>): Promise<T>;
    open(params: ProcessHostParams): Promise<HostedProcess>;
}
/**
 * How a caller supplies the substrate a process manager will run programs on.
 *
 * A factory rather than a finished {@link ProcessHost}, because the substrate
 * needs the disk its processes boot from and only the manager can produce one:
 * that reader answers as the credential that WROTE the boot images and
 * deliberately uncached, since they are the largest files a session holds.
 * Demanding a finished host would make every caller reproduce that policy, and
 * a second copy of a credential rule is a second thing to keep in step.
 *
 * The parameters are exactly what a manager already holds, so the deployment's
 * own selector (`processHostFor`) satisfies this type as it stands — the
 * workerd substrate is named, not wrapped.
 */
export type ProcessHostFactory = (ctx: DurableObjectState, env: unknown, disk: () => ResidentDiskReader) => ProcessHost;
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
//# sourceMappingURL=process-fabric.d.ts.map