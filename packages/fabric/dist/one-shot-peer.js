/**
 * one-shot-peer.ts — a session's one-shots on its warm peer, and the wire
 * both sides speak.
 *
 * A one-shot's facet is a Loader worker its session calls, and that worker's
 * synchronous work runs on the session's own thread: while it runs, the
 * session answers nothing. Measured 2026-10-21 on throwaways: during a python
 * one-shot importing ten stdlib modules, a second terminal's echo, a request
 * to a running server and a file save each waited 3.1-3.4 s, against
 * 0.04-0.12 s with the same run on another Durable Object, whose worker runs
 * on that object's thread (verdict 20261021T111038-40692a3b802a).
 *
 * So a session keeps one sibling, its peer, and runs a one-shot there when
 * the peer is warm for it: when the peer answered a call of the same worker
 * within ONE_SHOT_WARM_MS. When it is not, the call runs in the session as
 * before, and the peer is warmed for the next one beside it. A cold peer's
 * first call cost 2.4-3.1 s against 0.5-0.7 s warm, more than most runs
 * hold the session, so it is never paid on a call.
 *
 * The run is the session's wherever it runs. Its SUPERVISOR binding is the
 * one the session minted for it (its pid, and so its credential; its
 * delivery incarnation, way back and egress), so every syscall, stdio byte
 * and write reaches the session as that process, under the session's own
 * filesystem rules. The peer keeps nothing of a run but in memory, for as
 * long as the run's facet is open.
 */
import { z } from 'zod/v4';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { unsettledEnd } from '@nimbus-sh/core/_shared/process-fs-client.js';
import { ISOLATE_NETWORK, networkRef, workspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { facetTaskSource } from '@nimbus-sh/core/runtime/facet-task.js';
import { acquireSupervisorLoad } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { classifyDoCall } from '@nimbus-sh/platform/oom-classify.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { hostNamespaceBinding, hostOpDispatch } from './host-dispatch.js';
import { IsolatePool } from './isolate-pool.js';
import { HostRouteSchema, isolateToken, RESIDENT_READ_RANGE_BYTES, WorkspaceEgressSchema } from './peer-host.js';
import { PEER_PLACEMENT_MAX_ATTEMPTS } from './process-host.js';
import { BindingError } from './vendor/errors.js';
/**
 * How long a peer stays warm for a worker after it last answered a call of
 * it: the longest idle gap after which every measured peer was still warm.
 * Measured 2026-10-21 with a python one-shot on a peer after each gap:
 * - after 60, 75, 90, 105, 120 and 135 s idle, warm in 3 of 3 sessions
 *   (0.46-1.39 s, against 2.3-3.5 s for the same peer's first call;
 *   verdict 20261021T134050-9f15a2864f23);
 * - after 150 s idle, cold (2.2 s; verdict 20261021T111038-40692a3b802a).
 */
export const ONE_SHOT_WARM_MS = 135_000;
/** `spec`'s pool on `network`, its images the constructor's (`images`) or each call's. */
export function oneShotPoolOptions(spec, network, images) {
    return {
        tag: spec.tag,
        concurrency: spec.concurrency,
        preamble: spec.preamble,
        wasmModules: images,
        omitSupervisor: spec.supervisor === undefined,
        supervisorPid: spec.supervisor?.pid,
        processSupervisor: spec.supervisor,
        cacheScope: spec.reuse,
        scope: spec.scope,
        supervisorPerCall: spec.scope !== undefined,
        network,
    };
}
const SupervisorBindingPropsSchema = z.object({
    doId: z.string().min(1),
    pid: z.number().int().nonnegative(),
    route: HostRouteSchema.optional(),
    hostIncarnation: z.string().optional(),
    waveWriter: z.string().optional(),
    waveWriterMintedAt: z.number().optional(),
    bindingKind: z.literal('process'),
    writerId: z.string().min(1),
    egress: WorkspaceEgressSchema.optional(),
    networkId: z.string().optional(),
});
const OneShotSpecSchema = z.object({
    key: z.string().uuid(),
    tag: z.string().min(1),
    preamble: z.string().optional(),
    concurrency: z.number().int().positive().optional(),
    supervisor: SupervisorBindingPropsSchema.optional(),
    reuse: z.enum(['session', 'global']).optional(),
    scope: z.string().min(1).optional(),
    network: z.object({ egress: WorkspaceEgressSchema, id: z.string().min(1) }).optional(),
});
const OneShotImagesSchema = z.record(z.string(), z.object({
    path: z.string(),
    identity: z.string().min(1),
    size: z.number().int().nonnegative(),
    peak: z.number().int().nonnegative(),
    open: z.custom((value) => typeof value === 'function'),
}));
const FacetTaskSchema = z.object({ kind: z.literal('nimbus-facet-task'), source: z.string().min(1) });
const CallOptionsSchema = z.object({ timeoutMs: z.number().int().nonnegative().optional() });
const ProbeAnswerSchema = z.object({ isolateToken: z.string().min(1) });
function isAnswer(value) {
    if (typeof value !== 'object' || value === null || !('ok' in value))
        return false;
    return value.ok === true ? 'value' in value : value.ok === false && 'message' in value && typeof value.message === 'string';
}
// ── The session's side ──────────────────────────────────────────────────────
/** Warmth a peer has for any call: it answered one (its object is up). */
const ANY_WORKER = '';
const PLACEMENT_CALLS_KEPT = 16;
const placements = new WeakMap();
/** The placement of the one-shots of the Durable Object whose state is `ctx`, its peers in `env`'s host namespace. */
export function oneShotPlacement(ctx, env) {
    let placement = placements.get(ctx);
    if (placement === undefined)
        placements.set(ctx, placement = new OneShotPlacement(ctx, env));
    return placement;
}
/** Its peer and the last calls it placed, for /api/_diag/session; null before its first one-shot. */
export function oneShotPlacementDiagnostics(ctx) {
    return placements.get(ctx)?.diagnostics() ?? null;
}
/**
 * Where each one-shot of one session runs. One per session object: what it
 * knows (which peer, and when it last answered a call of each worker) is
 * this incarnation's memory, and a new incarnation learns it again.
 */
export class OneShotPlacement {
    #ctx;
    #env;
    #namespace = null;
    /** The peer, once a probe found one outside this isolate. */
    #peer = null;
    #choosing = null;
    /** Each worker's warmth key, and when the peer last answered a call of it. */
    #answered = new Map();
    #warming = new Set();
    #calls = [];
    constructor(ctx, env) {
        this.#ctx = ctx;
        this.#env = env;
    }
    /**
     * A one-shot's facet: each call runs on the peer when the peer is warm for
     * its worker, else in this session. A local pool is opened either way: a
     * call the peer refused before it took it runs there.
     */
    facet(spec, images, network) {
        const local = new IsolatePool(this.#env, this.#ctx, oneShotPoolOptions(spec, network, images));
        const wire = { ...spec, key: crypto.randomUUID(), network: networkRef(network.forProcess(spec.supervisor?.pid ?? 0)) };
        const warmth = warmthOf(spec, images);
        let opened = null;
        return {
            submit: async (fn, args, options) => {
                const began = Date.now();
                const peer = this.#warmFor(warmth);
                if (peer === null || options?.signal?.aborted === true) {
                    if (peer === null)
                        this.#warm(wire, images, fn, warmth);
                    try {
                        return await local.submit(fn, args, options);
                    }
                    finally {
                        this.#note(spec.tag, 'session', began);
                    }
                }
                opened = peer;
                const answer = await this.#submit(peer, wire, callImages(images, options?.wasmModules), warmth, fn, args, options);
                if (answer === null) {
                    try {
                        return await local.submit(fn, args, options);
                    }
                    finally {
                        this.#note(spec.tag, 'session', began);
                    }
                }
                this.#note(spec.tag, 'peer', began);
                if (answer.ok)
                    return answer.value;
                throw Object.assign(new Error(answer.message), answer.code === undefined ? {} : { code: answer.code }, answer.unsettled ? { unsettled: true } : {});
            },
            dispose: () => {
                local.dispose();
                if (opened !== null)
                    this.#ctx.waitUntil(this.#call(opened, 'oneShotDispose', [wire.key]).catch(() => { }));
            },
        };
    }
    /**
     * One call on `peer`: its answer, or null when the peer refused it before
     * taking it (overloaded), which runs it here. A peer lost after it took
     * the call ends the run as a lost worker does: it may have done things,
     * so it is never run again, and its error says what may be lost.
     */
    async #submit(peer, wire, images, warmth, fn, args, options) {
        const callId = crypto.randomUUID();
        // No signal crosses: a kill reaches the peer's call as its own.
        const cancel = () => this.#ctx.waitUntil(this.#call(peer, 'oneShotCancel', [callId]).catch(() => { }));
        options?.signal?.addEventListener('abort', cancel, { once: true });
        let raw;
        try {
            raw = await this.#call(peer, 'oneShotSubmit', [wire, callId, fn, args, { timeoutMs: options?.timeoutMs }, this.#images(wire, images)]);
        }
        catch (error) {
            this.forgetPeer();
            if (classifyDoCall(error) === 'overloaded')
                return null;
            const lost = new Error(`the session's one-shot host was lost while it ran: ${errorText(error)}`, { cause: error });
            throw wire.supervisor === undefined ? lost : unsettledEnd(lost);
        }
        finally {
            options?.signal?.removeEventListener('abort', cancel);
        }
        try {
            if (!isAnswer(raw))
                throw new BindingError(`one-shot peer '${peer}' answered no result`);
            this.#answered.set(warmth, Date.now()).set(ANY_WORKER, Date.now());
            return raw;
        }
        finally {
            disposeRpcResource(raw);
        }
    }
    /** The peer when it is warm for `warmth`'s worker, else null. */
    #warmFor(warmth) {
        const at = this.#answered.get(warmth);
        return this.#peer !== null && at !== undefined && Date.now() - at < ONE_SHOT_WARM_MS ? this.#peer : null;
    }
    /**
     * The peer warmed for `warmth`'s worker, beside the call that found it
     * cold: its object started, and a warm facet's worker loaded and its
     * images compiled (IsolatePool.warm), so the next call of it finds it
     * warm. One at a time per worker.
     */
    #warm(wire, images, fn, warmth) {
        if (this.#warming.has(warmth))
            return;
        this.#warming.add(warmth);
        this.#ctx.waitUntil((async () => {
            const peer = await this.#choose();
            if (peer === null || wire.scope === undefined)
                return;
            await this.#call(peer, 'oneShotWarm', [{ ...wire, key: crypto.randomUUID() }, fn, this.#images(wire, images)]);
            this.#answered.set(warmth, Date.now()).set(ANY_WORKER, Date.now());
        })().catch(() => { }).finally(() => { this.#warming.delete(warmth); }));
    }
    /**
     * The peer: the first of its candidate names whose object runs outside
     * this isolate. One that shares it shares the thread it was chosen to
     * free, so when every candidate does, the session has no peer.
     */
    #choose() {
        if (this.#peer !== null)
            return Promise.resolve(this.#peer);
        this.#choosing ??= (async () => {
            for (let attempt = 0; attempt < PEER_PLACEMENT_MAX_ATTEMPTS; attempt++) {
                const name = `${this.#ctx.id.toString()}:one-shot:${attempt}`;
                const raw = await this.#call(name, 'processHostProbe', []);
                try {
                    if (ProbeAnswerSchema.parse(raw).isolateToken === isolateToken())
                        continue;
                }
                finally {
                    disposeRpcResource(raw);
                }
                this.#peer = name;
                this.#answered.set(ANY_WORKER, Date.now());
                return name;
            }
            return null;
        })().catch(() => {
            // A probe that failed is tried again by the next warming.
            this.#choosing = null;
            return null;
        });
        return this.#choosing;
    }
    /** The peer is cold for every worker, and found again by the next warming: a call to it failed. */
    forgetPeer() {
        this.#answered.clear();
        this.#peer = null;
        this.#choosing = null;
    }
    /** `images` as they cross: each read in this session, under its load admission, when the peer's load opens it. */
    #images(wire, images) {
        const owner = { owner: `facet '${wire.tag}' images for its peer`, pid: wire.supervisor?.pid, session: this.#ctx.id.toString() };
        return Object.fromEntries(Object.entries(images).map(([name, image]) => [name, {
                path: image.path, identity: image.identity, size: image.size, peak: image.peak,
                open: async () => {
                    const lease = await acquireSupervisorLoad(owner.owner, image.peak, undefined, owner);
                    try {
                        return chunked(await image.read(), () => lease.release());
                    }
                    catch (error) {
                        lease.release();
                        throw error;
                    }
                },
            }]));
    }
    async #call(peer, op, args) {
        this.#namespace ??= hostNamespaceBinding(this.#env, 'one-shot placement');
        const stub = this.#namespace.get(this.#namespace.idFromName(peer));
        try {
            return await hostOpDispatch(stub, `one-shot peer '${peer}'`)({ op, args });
        }
        finally {
            disposeRpcResource(stub);
        }
    }
    #note(tag, host, began) {
        this.#calls.push({ tag, host, ms: Date.now() - began, at: began });
        if (this.#calls.length > PLACEMENT_CALLS_KEPT)
            this.#calls.shift();
    }
    diagnostics() {
        const now = Date.now();
        return {
            peer: this.#peer,
            warm: Object.fromEntries([...this.#answered].map(([key, at]) => [key === ANY_WORKER ? '(object)' : key, now - at])),
            calls: [...this.#calls],
        };
    }
}
/**
 * Which of the peer's workers a facet's call runs on, as far as warmth
 * goes: a warm facet's is its scope's, the same for every call of it; any
 * other facet's worker is its own, cold on either host, so only the peer
 * object's warmth matters for it.
 */
function warmthOf(spec, images) {
    if (spec.scope === undefined)
        return ANY_WORKER;
    const identities = Object.entries(images).map(([name, image]) => `${name}=${image.identity}`).sort().join(',');
    return `${spec.tag}\n${spec.scope}\n${identities}`;
}
/**
 * A call's images on the peer: its facet's and its own, all carried by the
 * call, since what a call receives ends with it. A name of the facet's that
 * the call names again is refused, as the session's own pool refuses it.
 */
function callImages(facet, call) {
    for (const name of Object.keys(call ?? {})) {
        if (Object.hasOwn(facet, name))
            throw new BindingError(`per-call wasm module '${name}' is already the facet's`);
    }
    return { ...facet, ...call };
}
/** `bytes` as a stream of ranges no larger than a value crossing RPC may be, `done` once read or cancelled. */
function chunked(bytes, done) {
    let offset = 0;
    return new ReadableStream({
        pull(controller) {
            if (offset >= bytes.byteLength) {
                controller.close();
                done();
                return;
            }
            const end = Math.min(bytes.byteLength, offset + RESIDENT_READ_RANGE_BYTES);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
        },
        cancel() { done(); },
    });
}
// ── The peer's side ─────────────────────────────────────────────────────────
const hosts = new WeakMap();
/** The one-shots the Durable Object whose state is `ctx` runs as a session's peer. */
export function oneShotHost(ctx, env) {
    let host = hosts.get(ctx);
    if (host === undefined)
        hosts.set(ctx, host = new OneShotHost(ctx, env));
    return host;
}
/**
 * The one-shots this Durable Object runs for its session, as that session's
 * peer: one pool per open facet of the session's, its calls, and nothing
 * stored.
 */
export class OneShotHost {
    ctx;
    env;
    #pools = new Map();
    #calls = new Map();
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
    }
    /** One call of a session's facet: its answer, whatever the task did. */
    async submit(spec, callId, fn, args, options, images) {
        const id = z.string().uuid().parse(callId);
        const controller = new AbortController();
        this.#calls.set(id, controller);
        try {
            const wire = OneShotSpecSchema.parse(spec);
            let pool = this.#pools.get(wire.key);
            if (pool === undefined)
                this.#pools.set(wire.key, pool = new IsolatePool(this.env, this.ctx, oneShotPoolOptions(wire, networkOf(wire))));
            const value = await pool.submit(facetTaskSource(FacetTaskSchema.parse(fn).source), args, {
                ...CallOptionsSchema.parse(options), wasmModules: facetImages(images), signal: controller.signal,
            });
            return { ok: true, value };
        }
        catch (error) {
            const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
            return {
                ok: false,
                message: errorText(error),
                ...(typeof code === 'string' ? { code } : {}),
                unsettled: typeof error === 'object' && error !== null && Reflect.get(error, 'unsettled') === true,
            };
        }
        finally {
            this.#calls.delete(id);
        }
    }
    /** A facet's worker loaded here and left warm (IsolatePool.warm), running nothing. */
    async warm(spec, fn, images) {
        const wire = OneShotSpecSchema.parse(spec);
        const pool = new IsolatePool(this.env, this.ctx, oneShotPoolOptions(wire, networkOf(wire)));
        try {
            await pool.warm(facetTaskSource(FacetTaskSchema.parse(fn).source), { wasmModules: facetImages(images) });
            return { warmed: true };
        }
        finally {
            pool.dispose();
        }
    }
    /** A call's kill: its wait for admission ends, as a session's own call's does. */
    cancel(callId) {
        const controller = this.#calls.get(z.string().uuid().parse(callId));
        controller?.abort(new Error('the process was killed'));
        return { cancelled: controller !== undefined };
    }
    /** A session's facet closed: its pool goes. */
    dispose(key) {
        const id = z.string().uuid().parse(key);
        this.#pools.get(id)?.dispose();
        this.#pools.delete(id);
    }
}
function networkOf(wire) {
    return wire.network === undefined ? ISOLATE_NETWORK : workspaceNetwork(wire.network.egress, wire.network.id);
}
/** The images a call carries, each read through its session when the load opens it. */
function facetImages(images) {
    return Object.fromEntries(Object.entries(OneShotImagesSchema.parse(images)).map(([name, image]) => [name, {
            path: image.path, identity: image.identity, size: image.size, peak: image.peak,
            read: async () => {
                const bytes = new Uint8Array(await new Response(await image.open()).arrayBuffer());
                if (bytes.byteLength !== image.size)
                    throw Object.assign(new Error(`ESTALE: '${image.path}' changed while its peer read it`), { code: 'ESTALE' });
                return bytes;
            },
        }]));
}
