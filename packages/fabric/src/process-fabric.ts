/**
 * process-fabric.ts — the resident-process scheduler, and the process half of
 * the substrate it runs on.
 *
 * Every long-lived process Nimbus runs — node servers, python/ruby socket
 * servers, an agent TUI and its headless server — runs as a **DO Facet**:
 * a named child actor whose class comes from a dynamic worker, opened by
 * `processes(ctx, env).spawn` in `workerd-facet-host.ts`.
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

import type { WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import type { SupervisorBindingProps } from './supervisor-props.js';
import { z } from 'zod/v4';
import type { RouteableFacetTarget } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { ProcessFsJournalSource } from '@nimbus-sh/core/_shared/process-fs-journal.js';
import type { ServiceStub } from './vendor/types.js';

/**
 * The class every generated resident runner exports. One name for every
 * runtime: the fabric names it unconditionally, so nothing about which program
 * is running reaches this module.
 */
export const RESIDENT_PROCESS_CLASS = 'NimbusProcess';

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
  /**
   * VFS paths of generated CommonJS PACKS (encodeCommonJsPack): each image
   * carries many `{ cjs }` modules, and the map gains every one of them at
   * load. A node process's module cells travel this way — one module per
   * file, so the guest's registry compiles only what the program requires,
   * and one image per launch, so the boot spec names a path and not thousands.
   */
  vfsCommonJsPacks: z.array(z.string()).optional(),
  /**
   * The isolate's exact `env`: one entry per binding the embedder minted,
   * carried by reference so loopback stubs survive untouched. Defined —
   * even as `{}` — means the embedder takes the whole env and no
   * SUPERVISOR binding is injected; absent keeps the default (a SUPERVISOR
   * minted from the composed supervisor entrypoint).
   */
  env: z.record(z.string(), z.unknown()).optional(),
  /** Absent inherits outbound, null denies it, a binding mediates it by reference. */
  globalOutbound: z.custom<ServiceStub>((value) =>
    value !== null && (typeof value === 'object' || typeof value === 'function')
    && 'fetch' in value && typeof value.fetch === 'function',
  ).nullable().optional(),
});

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
export function residentBootSpecSchema<Stage extends z.ZodType>(stageSchema: Stage) {
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('staged'), stage: stageSchema }),
    z.object({ kind: z.literal('code'), code: ResidentCodeSpecSchema }),
  ]);
}

export type ResidentBootSpec =
  | { kind: 'staged'; stage: unknown }
  | { kind: 'code'; code: ResidentCodeSpec };

// ── Staged boots ────────────────────────────────────────────────────────────
//
// A 'staged' boot spec assembles through the embedder's composed
// StagedBootAssembler — see composition.ts. What a stage IS belongs to
// whoever composed the assembler.

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
export async function facetImageDigest(image: string | Uint8Array): Promise<string> {
  // An image is its UTF-8 bytes; a caller holding them is not made to encode a second copy.
  const bytes = typeof image === 'string' ? new TextEncoder().encode(image) : image;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function facetImagePath(digest: string): string {
  return `/${FACET_IMAGE_DIR}/${digest}.js`;
}

/**
 * The digest an image path claims, for the reader's verify-on-read. Content
 * addressing only holds if the bytes are checked against the name they were
 * fetched under; without that a truncated or overwritten image boots as
 * silently-wrong code, which in a facet surfaces as an unattributable
 * "Cannot find module" a long way from the corruption.
 */
export function facetImagePathDigest(path: string): string | null {
  const match = /(?:^|\/)([0-9a-f]{64})\.js$/.exec(path);
  return match ? match[1] : null;
}

// ── Module-map assembly ─────────────────────────────────────────────────────

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
 *
 * The spec's isolation posture rides along verbatim: an explicit `env` is
 * the isolate's whole env (loopback stubs by reference, never cloned or
 * re-minted). An absent env stays absent
 * so the worker config can tell "embedder takes the env" from the default.
 */
export async function residentLoaderConfig(
  spec: ResidentCodeSpec,
  disk: ResidentDiskReader,
): Promise<Record<string, unknown>> {
  const resolved: Record<string, string | { wasm: ArrayBuffer } | { cjs: string }> = {};
  for (const [moduleName, path] of Object.entries(spec.vfsWasmModules ?? {})) {
    const bytes = await disk.readFile(path);
    // The read's own buffer when it fits exactly, and only otherwise a copy.
    // These are the largest members a spec carries — ruby's interpreter image
    // is 34.3 MiB, esbuild's 13.3 — and an unconditional slice held both
    // copies at once in the coordinator's 128 MiB isolate, at the one moment
    // the module map is also resident.
    const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    resolved[moduleName] = {
      wasm: exact
        ? bytes.buffer as ArrayBuffer
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  }
  for (const [moduleName, path] of Object.entries(spec.vfsTextModules ?? {})) {
    resolved[moduleName] = await readFacetImage(disk, path);
  }
  for (const path of spec.vfsCommonJsPacks ?? []) {
    Object.assign(resolved, decodeCommonJsPack(await readFacetImage(disk, path)));
  }
  return {
    compatibilityDate: spec.compatibilityDate,
    compatibilityFlags: spec.compatibilityFlags,
    mainModule: spec.mainModule,
    modules: { ...spec.modules, ...resolved },
    ...(spec.env !== undefined ? { env: spec.env } : {}),
    ...(spec.globalOutbound !== undefined ? { globalOutbound: spec.globalOutbound } : {}),
  };
}

/**
 * One image holding many `{ cjs }` modules: a JSON index of `[name, length]`
 * rows, a newline, and the module texts back to back. Lengths are UTF-16 code
 * units, the unit the decoded text is sliced in, so decoding copies nothing:
 * each module is a slice of the one string read.
 *
 * Encoded as its parts, in order, never joined: the image store encodes them
 * straight into the image's bytes, and a joined copy would be a second full
 * copy of the program's code on the coordinator.
 */
export function encodeCommonJsPack(modules: Record<string, string>): string[] {
  const index: [string, number][] = [];
  const parts: string[] = [''];
  for (const [name, text] of Object.entries(modules)) {
    index.push([name, text.length]);
    parts.push(text);
  }
  parts[0] = JSON.stringify(index) + '\n';
  return parts;
}

export function decodeCommonJsPack(pack: string): Record<string, { cjs: string }> {
  const newline = pack.indexOf('\n');
  const index = z.array(z.tuple([z.string(), z.number().int().nonnegative()])).parse(JSON.parse(pack.slice(0, newline)));
  const modules: Record<string, { cjs: string }> = {};
  let offset = newline + 1;
  for (const [name, length] of index) {
    modules[name] = { cjs: pack.slice(offset, offset + length) };
    offset += length;
  }
  if (offset !== pack.length) throw new Error(`Nimbus: CommonJS pack holds ${pack.length - offset} bytes its index does not name`);
  return modules;
}

/**
 * Read one content-addressed facet image and verify it against the digest its
 * path claims. Content addressing is only a guarantee if the bytes are checked
 * against the name they arrived under: an image that was truncated, or
 * replaced by something the generator never wrote, would otherwise be loaded
 * as the program and fail somewhere inside it with no way back to the cause.
 */
async function readFacetImage(disk: ResidentDiskReader, path: string): Promise<string> {
  const expected = facetImagePathDigest(path);
  if (!expected) {
    throw new Error(`Nimbus: '${path}' is not a content-addressed facet image path`);
  }
  // Verified from the bytes read, and decoded only after: re-encoding the decoded string held a third copy of the largest member.
  const bytes = await disk.readFile(path);
  const actual = await facetImageDigest(bytes);
  if (actual !== expected) {
    throw new Error(
      `Nimbus: facet image '${path}' does not match its digest (read ${actual}); `
        + 'the image store is corrupt and the process cannot boot from it',
    );
  }
  return new TextDecoder().decode(bytes);
}

// ── The hosting substrate ───────────────────────────────────────────────────

/**
 * The identity a resident process's SUPERVISOR binding is minted for. Always
 * the COORDINATOR's — a process hosted somewhere else still reads and writes
 * the user's disk, and still reports to the user's process table. Minted by
 * `supervisorBindingProps` on the coordinator; `route` is absent only when
 * the coordinator's isolate composed nothing, in which case no supervisor
 * binding is minted either.
 */
export interface ResidentSupervisorProps extends SupervisorBindingProps {
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
  /**
   * Set only by the coordinator's durable-application path: an explicit facet
   * name (`app-slot-<n>`) allocated from DO storage, plus the release split
   * that keeps its SQLite across aborts. Absent, the host allocates an
   * ephemeral `proc-slot-<n>` name from its in-memory free list and deletes
   * the store on release.
   */
  facet?: { name: string; durable: boolean };
  /**
   * Bytes the process's store is filled with before it runs (its data plan).
   * The hosting actor's storage ledger (N18) admits them under the facet's
   * name before the facet starts: ENOSPC, and no facet, when they would cross
   * the storage limit.
   */
  storageBytes?: number;
  /**
   * The process logs its changes in its facet's store (process-fs-journal.ts):
   * the session is told the facet's name when it opens (`opened`), and
   * `drain` is handed the store's journal when the process is released,
   * before the store goes. A drain that throws keeps the store and its name.
   * Its class holds `held()` open while its isolate lives, so a death after
   * its boot (out of memory, CPU) is the process's `lost`.
   */
  journal?: {
    opened(facet: string): void;
    drain(journal: ProcessFsJournalSource): Promise<void>;
  };
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
   * Inbound WebSocket upgrade, on fetch semantics for every hop. A 101
   * Response owns a live socket, which the parts-based RPC path cannot carry.
   */
  handleWebSocketRequest(request: Request): Promise<Response>;
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
   * Present in production, and since the pins moved to
   * `@cloudflare/workers-types` 5.20260928.1 and workerd 1.20260926.1 also in
   * the type checker and `wrangler dev` (DurableObjectFacets.clone;
   * src/workerd/api/actor-state.h). Before that the types declared no `clone`
   * and the pinned workerd 1.20260603.1 lacked it, while on a live Worker the
   * binding enumerated `["abort","clone","constructor","delete","get"]` and a
   * clone into a destination of a DIFFERENT class had all 500 seeded files
   * readable from the destination's CONSTRUCTOR. No compat-date gate.
   *
   * The hazard that comes with it, measured rather than assumed: ANY `src`
   * that does not resolve to a populated facet — a typo, a name not created
   * yet, not merely the obvious `''`/`'.'`/`'/'` — silently EMPTIES the
   * destination and reports success. Validation has to be positive on both
   * ends: the source exists and is populated before, the destination is
   * non-empty after. A blocklist of bad names would pass a typo straight
   * through and wipe a process's filesystem while returning ok. Enforced by
   * `cloneStorage` in the workerd host, which is the one way the fabric
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
  modules: Record<string, string | { wasm: ArrayBuffer } | { cjs: string }>;
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
  /**
   * The program's network goes through its supervisor binding: the binding
   * is also its globalOutbound, so its fetch and connect reach the session,
   * which answers them (a program that can stop at a read of stdin, whose
   * reads of the network are recorded to be answered again). A host without
   * a supervisor binding leaves the network as it is.
   */
  outbound?: boolean;
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
export type ProcessHostFactory = (
  ctx: DurableObjectState,
  env: unknown,
  disk: () => ResidentDiskReader,
  network: () => WorkspaceNetwork,
) => ProcessHost;

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
  readonly done: Promise<void>;
  /**
   * Inbound-HTTP target for PortRegistry: the running facet's own stub. A
   * facet is a child actor, so its stub stays usable in request contexts long
   * after the one that created it — which is the whole reason a resident
   * process can serve a port at all.
   */
  readonly routeTarget: RouteableFacetTarget;
  #booted: () => Promise<unknown>;
  #kill: () => void;
  #killed = false;
  #describe: () => string;

  constructor(init: {
    done: Promise<void>;
    booted: () => Promise<unknown>;
    routeTarget: RouteableFacetTarget;
    kill: () => void;
    describe: () => string;
  }) {
    this.done = init.done;
    this.#booted = init.booted;
    this.routeTarget = init.routeTarget;
    this.#kill = init.kill;
    this.#describe = init.describe;
    // Symbol.dispose may be absent from older lib targets; wire defensively
    // so disposeRpcResource() (which probes for it) finds the disposer.
    const disposeSym = (Symbol as SymbolConstructor & { readonly dispose?: symbol }).dispose;
    if (disposeSym) {
      Object.defineProperty(this, disposeSym, { value: () => this.kill() });
    }
  }

  /**
   * The runner's startProcess payload. The runner is started as part of the
   * spawn, so this is a handle on that one boot — awaiting it twice is safe
   * and never re-starts anything. For a `lifetime` runner it settles at exit.
   */
  booted(): Promise<unknown> {
    return this.#booted();
  }

  get killed(): boolean {
    return this.#killed;
  }

  /** Human-readable placement, for the NIMBUS_DEBUG process-log line. */
  describePlacement(): string {
    return this.#describe();
  }

  /** Idempotent: abort the facet and release its isolate. */
  kill(): void {
    if (this.#killed) return;
    this.#killed = true;
    try { this.#kill(); } catch { /* best-effort teardown */ }
  }
}

// ── The fabric ──────────────────────────────────────────────────────────────

export interface ResidentProcessSpawn {
  /** Declared by the runner the primitive generates. */
  startContract: StartContract;
  /** Supervisor-assigned pid of the process entry on the coordinator. */
  pid: number;
  /** Keyed dynamic-worker identity (`nimbus-process:${doId}:${pid}`). */
  workerKey: string;
  /** What the process boots from. */
  boot: ResidentBootSpec;
  /** Forwarded verbatim to the runner's startProcess. */
  startArgs?: unknown;
  /**
   * A durable application's explicit facet name (`app-slot-<n>`) and the
   * release split that keeps its SQLite. Coordinator-allocated; absent for an
   * ephemeral process, which takes a `proc-slot-<n>` name from the book.
   */
  facet?: { name: string; durable: boolean };
  /** See {@link ProcessHostParams.storageBytes}. */
  storageBytes?: number;
  /**
   * A Nimbus runtime's process (node, python, ruby, opencode), whose class
   * logs its changes in its facet's store and holds `held()` open while its
   * isolate lives (ProcessHostParams.journal). Never an application's own
   * class, whose store is its own.
   */
  journaled?: boolean;
  /**
   * Called before any concrete host capability can expose this writer.
   * A spawn must not proceed unless the supervisor accepts the authority.
   */
  onWriterActivated: (writerId: string) => void;
  /** Called only after the concrete host resources for this writer are revoked. */
  onWriterRetired: (writerId: string) => void;
}

/** A promise that settles only when the process is killed. */
function heldUntilKilled(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export class ProcessFabric {
  /**
   * `journalFor`: the write-log hooks of a resident process's facet
   * (ProcessHostParams.journal), when its coordinator keeps them: every
   * resident it starts logs its changes in its facet's store.
   */
  constructor(
    private readonly host: ProcessHost,
    private readonly options: { journalFor?: (pid: number) => ProcessHostParams['journal'] } = {},
  ) {}

  /**
   * Boot a resident process on this deployment's substrate and return its
   * handle. Resolves once the process is up and its runner has been started;
   * rejects on boot failure.
   *
   * There is no decision in here. The substrate was chosen once, for the
   * deployment, and the only thing this method knows about it is the
   * `ProcessHost` interface.
   */
  async startResidentProcess(spawn: ResidentProcessSpawn): Promise<ResidentProcessHandle> {
    // The facet-local append sequence starts at one when its module evaluates.
    // Bind that sequence to this concrete incarnation, then retire it only
    // after the host is released; a later incarnation must use a fresh one.
    const writerId = crypto.randomUUID();
    spawn.onWriterActivated(writerId);
    const journal = spawn.journaled ? this.options.journalFor?.(spawn.pid) : undefined;

    let hosted: HostedProcess;
    try {
      hosted = await this.host.open({
        pid: spawn.pid,
        workerKey: spawn.workerKey,
        boot: spawn.boot,
        writerId,
        startArgs: spawn.startArgs,
        ...(spawn.facet !== undefined ? { facet: spawn.facet } : {}),
        ...(spawn.storageBytes !== undefined ? { storageBytes: spawn.storageBytes } : {}),
        ...(journal !== undefined ? { journal } : {}),
      });
    } catch (error) {
      spawn.onWriterRetired(writerId);
      throw error;
    }

    const held = heldUntilKilled();
    // Runs at most once, however it is reached — the lifecycle ending, a kill,
    // or both. Retiring the writer twice would revoke an identity a later
    // incarnation had already been granted.
    let releasing: Promise<void> | null = null;
    const release = (): Promise<void> => {
      if (!releasing) {
        releasing = (async () => {
          try { await hosted.release(); } finally { spawn.onWriterRetired(writerId); }
        })();
        releasing.catch(() => {});
      }
      return releasing;
    };
    // `lifetime`: the runner's startProcess IS the process, so its settlement
    // is the lifecycle — a host that dies under it rejects `started`.
    // `boot`: the runner returns once it is up and the process stays resident
    // on its host, so residency ends at a kill — or at the host dying, which
    // is the same thing happening to the process without anyone asking for it.
    const done = (spawn.startContract === 'lifetime'
      ? hosted.started.then(() => undefined)
      : hosted.started.then(() => Promise.race([held.promise, hosted.lost]))
    ).finally(() => release());
    done.catch(() => {});
    return new ResidentProcessHandle({
      done,
      booted: () => hosted.started,
      routeTarget: {
        handleHttpRequest: (request: Request) => hosted.handleHttpRequest(request),
        handleWebSocketRequest: (request: Request) => hosted.handleWebSocketRequest(request),
      },
      kill: () => { held.release(); void release(); },
      describe: () => hosted.describe(),
    });
  }
}
