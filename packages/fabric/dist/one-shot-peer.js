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
 * delivery incarnation and way back), so every syscall, stdio byte and write
 * reaches the session as that process, under the session's own filesystem
 * rules. The peer keeps nothing of a call past it: each call builds its pool
 * there from what it carries, and what a call receives ends with it. That is
 * also why a one-shot whose network goes out through an egress stays in the
 * session: a warm worker keeps the outbound it was loaded with, and on the
 * peer that would be one call's capability, ended with that call.
 */
import { z } from 'zod/v4';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { unsettledEnd } from '@nimbus-sh/core/_shared/process-fs-client.js';
import { ISOLATE_NETWORK } from '@nimbus-sh/core/_shared/workspace-network.js';
import { facetTaskSource, requireFacetTaskSource } from '@nimbus-sh/core/runtime/facet-task.js';
import { acquireSupervisorLoad } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { classifyDoCall } from '@nimbus-sh/platform/oom-classify.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { hostNamespaceBinding, hostOpDispatch } from './host-dispatch.js';
import { IsolatePool } from './isolate-pool.js';
import { HostRouteSchema, isolateToken, RESIDENT_READ_RANGE_BYTES, WorkspaceEgressSchema } from './peer-host.js';
import { hashSource } from './vendor/serialize.js';
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
/** What the peer's side answers when the task failed: what the session's own pool would have thrown. */
const OneShotFailureSchema = z.object({ ok: z.literal(false), message: z.string(), code: z.string().optional(), unsettled: z.boolean() });
/** The peer's answer to a call that named a preamble it does not hold: the call is sent again carrying it. */
const PreambleMissingSchema = z.object({ ok: z.literal('preamble missing') });
/**
 * A call's answer: the task's value, or what it failed with, which the peer
 * caught. The value is the task's own, what its source returns
 * (FacetTaskSource), which no RPC can check, as the session's own pool
 * cannot.
 */
function answerSchema() {
    return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.custom(() => true) }), OneShotFailureSchema, PreambleMissingSchema]);
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
    tag: z.string().min(1),
    preamble: z.string().optional(),
    /** The preamble's hash (preambleHash): a call carries the preamble only until the peer holds it. */
    preambleHash: z.string().min(1),
    concurrency: z.number().int().positive().optional(),
    supervisor: SupervisorBindingPropsSchema.optional(),
    reuse: z.enum(['session', 'global']).optional(),
    scope: z.string().min(1).optional(),
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
    /** Advanced when the peer is forgotten: what answers a call made before is not news of the peer chosen after. */
    #generation = 0;
    #calls = [];
    #warmFailure = null;
    /**
     * The preambles the peer holds, by hash. A runtime's preamble is some
     * hundreds of KB (the WASI layer is ~600 KB), and carrying it costs a call
     * ~27 ms (verdict 20261021T150831-0394183537ae), so a call carries it only
     * until the peer has it.
     */
    #carried = new Set();
    constructor(ctx, env) {
        this.#ctx = ctx;
        this.#env = env;
    }
    /**
     * A one-shot's facet: each call runs on the peer when the peer is warm for
     * its worker, else in this session. A local pool is opened either way: a
     * call the peer refused before it took it runs there. One whose network
     * goes out through an egress always runs here (the module's header says why).
     */
    facet(spec, images, network) {
        const local = new IsolatePool(this.#env, this.#ctx, oneShotPoolOptions(spec, network, images));
        if (network.forProcess(spec.supervisor?.pid ?? 0).egress !== undefined)
            return local;
        return {
            submit: async (fn, args, options) => {
                const began = Date.now();
                const callImages = imagesOfCall(images, options?.wasmModules);
                const worker = workerOf(spec, callImages, fn);
                const peer = this.#warmFor(worker);
                if (peer === null || options?.signal?.aborted === true) {
                    if (peer === null)
                        this.#warm(spec, callImages, fn, worker);
                    try {
                        return await local.submit(fn, args, options);
                    }
                    finally {
                        this.#note(spec.tag, worker, 'session', began);
                    }
                }
                let answer;
                try {
                    answer = await this.#submit(peer, spec, callImages, worker, fn, args, options);
                }
                catch (error) {
                    // Lost on the peer: it ran there.
                    this.#note(spec.tag, worker, 'peer', began);
                    throw error;
                }
                if (answer === null) {
                    try {
                        return await local.submit(fn, args, options);
                    }
                    finally {
                        this.#note(spec.tag, worker, 'session', began);
                    }
                }
                this.#note(spec.tag, worker, 'peer', began);
                if (answer.ok === true)
                    return answer.value;
                throw failedAs(answer);
            },
            dispose: () => local.dispose(),
        };
    }
    /**
     * One call on `peer`: its answer, or null when the peer refused it before
     * taking it (overloaded), which runs it here. A peer lost after it took
     * the call ends the run as a lost worker does: it may have done things,
     * so it is never run again, and its error says what may be lost.
     */
    async #submit(peer, spec, images, worker, fn, args, options) {
        const callId = crypto.randomUUID();
        const generation = this.#generation;
        // One stub for the call and its kill: calls on one stub arrive in order, so the kill never overtakes the call.
        const stub = this.#stub(peer);
        const dispatch = hostOpDispatch(stub, `one-shot peer '${peer}'`);
        // No signal crosses: a kill reaches the peer's call as its own.
        const cancel = () => { this.#ctx.waitUntil(Promise.resolve(dispatch({ op: 'oneShotCancel', args: [callId] })).catch(() => { })); };
        options?.signal?.addEventListener('abort', cancel, { once: true });
        const hash = preambleHash(spec.preamble);
        try {
            // Sent again carrying the preamble when the peer no longer holds it (it was reset since it took it).
            for (;;) {
                const carries = !this.#carried.has(hash);
                let raw;
                try {
                    raw = await dispatch({ op: 'oneShotSubmit', args: [this.#wire(spec, carries), callId, fn, args, { timeoutMs: options?.timeoutMs }, this.#images(spec, images, options?.signal)] });
                }
                catch (error) {
                    this.forgetPeer();
                    if (classifyDoCall(error) === 'overloaded')
                        return null;
                    const lost = new Error(`the session's one-shot host was lost while it ran: ${errorText(error)}`, { cause: error });
                    throw spec.supervisor === undefined ? lost : unsettledEnd(lost);
                }
                try {
                    const answer = answerSchema().parse(raw);
                    if (answer.ok === 'preamble missing') {
                        if (carries)
                            throw new BindingError(`one-shot peer '${peer}' did not hold the preamble the call carried`);
                        this.#carried.delete(hash);
                        // Killed before the peer took it: it never started, and is not sent again.
                        options?.signal?.throwIfAborted();
                        continue;
                    }
                    if (generation === this.#generation)
                        this.#carried.add(hash);
                    this.#heard(generation, worker);
                    return answer;
                }
                finally {
                    disposeRpcResource(raw);
                }
            }
        }
        finally {
            options?.signal?.removeEventListener('abort', cancel);
            disposeRpcResource(stub);
        }
    }
    /** `spec` as a call carries it: its preamble by hash, and the text too unless the peer holds it (`carries`). */
    #wire(spec, carries) {
        return { ...spec, preamble: carries ? spec.preamble : undefined, preambleHash: preambleHash(spec.preamble) };
    }
    /** The peer when it is warm for `worker`, else null. */
    #warmFor(worker) {
        this.#expire();
        return this.#peer !== null && this.#answered.has(worker) ? this.#peer : null;
    }
    /** What the peer answered longer than ONE_SHOT_WARM_MS ago is no longer warm, and is forgotten. */
    #expire() {
        const now = Date.now();
        for (const [worker, at] of this.#answered)
            if (now - at >= ONE_SHOT_WARM_MS)
                this.#answered.delete(worker);
    }
    /**
     * The peer warmed for `warmth`'s worker, beside the call that found it
     * cold: its object started, and a warm facet's worker loaded and its
     * images compiled (IsolatePool.warm), so the next call of it finds it
     * warm. One at a time per worker and peer.
     */
    #warm(spec, images, fn, worker) {
        const generation = this.#generation;
        const warming = `${generation}\n${worker}`;
        if (this.#warming.has(warming))
            return;
        this.#warming.add(warming);
        this.#ctx.waitUntil((async () => {
            const peer = await this.#choose();
            if (peer === null || spec.scope === undefined)
                return;
            await this.#call(peer, 'oneShotWarm', [this.#wire(spec, true), fn, this.#images(spec, images, undefined)]);
            if (generation === this.#generation)
                this.#carried.add(preambleHash(spec.preamble));
            this.#heard(generation, worker);
        })().catch((error) => {
            // The call that found the peer cold ran here; the next one finds it cold too, and warms it again.
            this.#warmFailure = { worker, message: errorText(error), at: Date.now() };
        }).finally(() => { this.#warming.delete(warming); }));
    }
    /**
     * The peer: the first of its candidate names whose object runs outside
     * this isolate. One that shares it shares the thread it was chosen to
     * free, so when every candidate does, the session has no peer.
     */
    #choose() {
        if (this.#peer !== null)
            return Promise.resolve(this.#peer);
        const generation = this.#generation;
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
                if (generation !== this.#generation)
                    return null;
                this.#peer = name;
                this.#heard(generation, ANY_WORKER);
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
        this.#generation++;
        this.#answered.clear();
        this.#carried.clear();
        this.#peer = null;
        this.#choosing = null;
    }
    /** The peer answered a call of `worker`, made in `generation`: warm for it, unless forgotten since. */
    #heard(generation, worker) {
        if (generation !== this.#generation)
            return;
        const now = Date.now();
        this.#answered.set(worker, now).set(ANY_WORKER, now);
    }
    /**
     * `images` as they cross: each read in this session, under its load
     * admission, when the peer's load opens it; a call's kill (`signal`) ends
     * its wait for admission, as it ends the session's own pool's.
     */
    #images(spec, images, signal) {
        const owner = { owner: `facet '${spec.tag}' images for its peer`, pid: spec.supervisor?.pid, session: this.#ctx.id.toString() };
        return Object.fromEntries(Object.entries(images).map(([name, image]) => [name, {
                path: image.path, identity: image.identity, size: image.size, peak: image.peak,
                open: async () => {
                    const lease = await acquireSupervisorLoad(owner.owner, image.peak, signal, owner);
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
    #stub(peer) {
        this.#namespace ??= hostNamespaceBinding(this.#env, 'one-shot placement');
        return this.#namespace.get(this.#namespace.idFromName(peer));
    }
    async #call(peer, op, args) {
        const stub = this.#stub(peer);
        try {
            return await hostOpDispatch(stub, `one-shot peer '${peer}'`)({ op, args });
        }
        finally {
            disposeRpcResource(stub);
        }
    }
    #note(tag, worker, host, began) {
        this.#calls.push({ tag, worker, host, ms: Date.now() - began, at: began });
        if (this.#calls.length > PLACEMENT_CALLS_KEPT)
            this.#calls.shift();
    }
    diagnostics() {
        this.#expire();
        const now = Date.now();
        return {
            peer: this.#peer,
            warm: Object.fromEntries([...this.#answered].map(([key, at]) => [key === ANY_WORKER ? '(object)' : key, now - at])),
            calls: [...this.#calls],
            warmFailure: this.#warmFailure,
        };
    }
}
/**
 * The peer's worker a call runs on, as far as warmth goes: what its pool's
 * loader id is made of on either host, but the host's own object (the tag,
 * the reuse scope and warm scope, the preamble, the task and its images),
 * since the peer's pool is the session's spec over the same task and images.
 * A facet with no warm scope has a worker of its own, cold on either host,
 * so only the peer object's warmth matters for it.
 */
function workerOf(spec, images, fn) {
    if (spec.scope === undefined)
        return ANY_WORKER;
    const identities = Object.entries(images).map(([name, image]) => `${name}=${image.identity}`).sort().join(',');
    const supervisor = spec.supervisor === undefined ? 's-none' : 's-call';
    return [spec.tag, spec.reuse ?? 'session', spec.scope, supervisor, preambleHash(spec.preamble), hashSource(requireFacetTaskSource(fn)), identities].join('\n');
}
/** A preamble's hash, once per preamble: a runtime's is a constant of the deploy, some hundreds of KB. None, or an empty one, is '0', as the pool has it. */
const preambleHashes = new Map();
function preambleHash(preamble) {
    if (!preamble)
        return '0';
    let hash = preambleHashes.get(preamble);
    if (hash === undefined)
        preambleHashes.set(preamble, hash = hashSource(preamble));
    return hash;
}
/** A failure the peer caught, thrown as the session's own pool throws it. */
function failedAs(failure) {
    return Object.assign(new Error(failure.message), failure.code === undefined ? {} : { code: failure.code }, failure.unsettled ? { unsettled: true } : {});
}
/**
 * A call's images on the peer: its facet's and its own, all carried by the
 * call, since what a call receives ends with it. A name of the facet's that
 * the call names again is refused, as the session's own pool refuses it.
 */
function imagesOfCall(facet, call) {
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
 * peer: each call on a pool of its own, built from what the call carries
 * and gone with it, so nothing a call received outlives it. Only the
 * loader's warm workers stay, as they do for the session's own pools.
 */
export class OneShotHost {
    ctx;
    env;
    #calls = new Map();
    /** The preambles calls carried, by hash: constants of the deploy, one per runtime that ran here. */
    #preambles = new Map();
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
    }
    /** One call of a session's facet: its answer, whatever the task did. */
    async submit(spec, callId, fn, args, options, images) {
        const id = z.string().uuid().parse(callId);
        const pool = this.#pool(spec);
        if (pool === null)
            return { ok: 'preamble missing' };
        const controller = new AbortController();
        this.#calls.set(id, controller);
        try {
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
            pool.dispose();
        }
    }
    /** A facet's worker loaded here and left warm (IsolatePool.warm), running nothing. */
    async warm(spec, fn, images) {
        const pool = this.#pool(spec);
        if (pool === null)
            throw new BindingError('a warming carries its preamble');
        try {
            await pool.warm(facetTaskSource(FacetTaskSchema.parse(fn).source), { wasmModules: facetImages(images) });
            return { warmed: true };
        }
        finally {
            pool.dispose();
        }
    }
    /** A call's pool, its preamble the one it carried or one held by its hash; null when it is neither. */
    #pool(spec) {
        const wire = OneShotSpecSchema.parse(spec);
        let preamble = wire.preamble;
        if (preamble !== undefined) {
            if (preambleHash(preamble) !== wire.preambleHash)
                throw new BindingError('a call carried a preamble whose hash it misnamed');
            this.#preambles.set(wire.preambleHash, preamble);
        }
        else if (wire.preambleHash !== preambleHash(undefined)) {
            preamble = this.#preambles.get(wire.preambleHash);
            if (preamble === undefined)
                return null;
        }
        return new IsolatePool(this.env, this.ctx, oneShotPoolOptions({ ...wire, preamble }, ISOLATE_NETWORK));
    }
    /** A call's kill: its wait for admission ends, as a session's own call's does. */
    cancel(callId) {
        const controller = this.#calls.get(z.string().uuid().parse(callId));
        controller?.abort(new Error('the process was killed'));
        return { cancelled: controller !== undefined };
    }
}
/**
 * The images a call carries, each read through its session when the load
 * opens it: the session's own read, which refuses bytes its identity no
 * longer names.
 */
function facetImages(images) {
    return Object.fromEntries(Object.entries(OneShotImagesSchema.parse(images)).map(([name, image]) => [name, {
            path: image.path, identity: image.identity, size: image.size, peak: image.peak,
            read: async () => new Uint8Array(await new Response(await image.open()).arrayBuffer()),
        }]));
}
