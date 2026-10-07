/**
 * local-facet-host.ts — a facet in a realm of its own, beside the caller.
 *
 * The {@link FacetHost} for every embedder that is not workerd. There is no
 * dynamic-worker substrate to reach for and no CSP forbidding a compile, so
 * each facet is a realm (runtime/realm.ts; its side is facet-guest.ts): the
 * wasm table filled, the preamble evaluated once there, and each submitted
 * function evaluated there inside it. The realm is a worker thread of this
 * process, or under Bun a process of its own: Bun 1.4 cannot end a worker
 * running WebAssembly, and a facet runs nothing else. A thread is handed its
 * modules compiled here (a compiled module crosses to a worker without a
 * second compile, and V8 reuses this isolate's compilation of the same
 * bytes); a process, which no compiled module crosses to, their bytes.
 *
 * A realm of its own because a facet used to be built in this realm, so what
 * its program reached of JavaScript was the host's: Ruby's `js` bridge
 * evaluates code (`JS.eval`) and reads and writes any global, so
 * `JS.eval("globalThis.Promise = null")` broke the host's shell, and a guest
 * spinning without a syscall held the host's only thread for good. Now the
 * program reaches the facet's realm, and a call's timeout or abort ends it,
 * even in a loop that never yields.
 *
 * The function is SERIALIZED rather than called in place, as on workerd. A
 * runner's facet function reads names the preamble declares —
 * `__wasiMakeImports`, `__bashBoot` — which exist only in the scope the
 * preamble was evaluated in. Its arguments and answer cross as plain data, and
 * the session capability as calls to this side: each supervisor method, and
 * each of its synchronous view's, is answered here from the facet's
 * filesystem.
 *
 * A facet's network is the workspace's. A realm cannot be handed a Fetcher,
 * so under an egress its `fetch` crosses to this side, which sends it out
 * through the egress (realm-egress.ts, as the inline `node` does); a
 * WebSocket, which cannot cross, is refused by name.
 */
import { requireNetwork } from '../_shared/workspace-network.js';
import { isEgressGuestEvent, RealmEgress } from './realm-egress.js';
import { fromRealmError, isRealmAnswer, startRealm } from './realm.js';
import { FILESYSTEM_RPC_METHODS, vfsSupervisor } from './vfs-supervisor.js';
const record = (value) => typeof value === 'object' && value !== null;
const strings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
export function isFacetPayload(value) {
    if (!record(value) || typeof value.tag !== 'string' || (value.parking !== 'jspi' && value.parking !== 'none'))
        return false;
    if (value.preamble !== undefined && typeof value.preamble !== 'string')
        return false;
    if (typeof value.egress !== 'boolean')
        return false;
    const supervisor = value.supervisor;
    return supervisor === undefined
        || (record(supervisor) && strings(supervisor.methods) && (supervisor.synchronous === null || strings(supervisor.synchronous)));
}
export function isFacetSubmit(value) {
    return record(value) && value.type === 'submit' && Number.isSafeInteger(value.id) && typeof value.source === 'string'
        && 'args' in value && record(value.modules) && Object.values(value.modules).every((module) => module instanceof WebAssembly.Module || module instanceof ArrayBuffer);
}
function isSupervisorCall(value) {
    return record(value) && value.op === 'supervisor' && (value.view === 'supervisor' || value.view === 'synchronous')
        && typeof value.method === 'string' && Array.isArray(value.args);
}
function isFacetDone(value) {
    return record(value) && value.type === 'done' && typeof value.installed === 'boolean' && isRealmAnswer(value);
}
/** The supervisor's names, as a facet calls them. */
const SUPERVISOR_METHODS = Object.values(FILESYSTEM_RPC_METHODS);
/** Its synchronous view's: the bridge's names, but those with no synchronous form (os-contracts.ts). */
const SYNCHRONOUS_METHODS = Object.keys(FILESYSTEM_RPC_METHODS)
    .filter((name) => name !== 'writeStream' && name !== 'acquire' && name !== 'copyTree');
/**
 * The standard `WebAssembly.compile`, checked for rather than assumed.
 *
 * `@cloudflare/workers-types` declares no compiler and an abstract `Module`,
 * which is not an oversight: workerd forbids compiling at request time, and
 * that prohibition is the entire reason facets exist. Core is typed against
 * that surface, so the one host that DOES compile asks for the capability by
 * name and says so plainly when it is absent.
 */
export function wasmCompiler() {
    const compile = Reflect.get(WebAssembly, 'compile');
    if (typeof compile !== 'function') {
        throw new Error('Nimbus: this host cannot compile WebAssembly in place (no WebAssembly.compile), '
            + 'so it needs a facet host with its own isolates rather than this one');
    }
    return compile;
}
/**
 * Whether this engine can suspend a wasm guest mid-import: JSPI's
 * `WebAssembly.Suspending` and `WebAssembly.promising` (the ambient
 * declaration is in runtime/wasi/types.ts). Bun's JavaScriptCore ships them;
 * Node 22 does not, and V8 traps a call into a suspending import off a stack
 * `promising` did not enter, so the answer has to come from the engine at
 * hand, not from the process kind.
 */
function engineParks() {
    return typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function' ? 'jspi' : 'none';
}
/**
 * Where a facet runs: a worker thread, or, under Bun, a process. Bun 1.4 does
 * not terminate a worker that is running WebAssembly (its `terminate()` never
 * settles and the thread spins on, a core for good), and a facet's guest is
 * WebAssembly; Node ends one at once. Asked of the engine at hand, as
 * {@link engineParks} is.
 */
function facetIsolation() {
    return Reflect.get(globalThis, 'Bun') === undefined ? 'thread' : 'process';
}
/**
 * Run each facet in a realm of its own, a worker thread of this process.
 *
 * `parking` is the engine's (a worker's is the same engine): where it can
 * suspend a guest the facet is entered through `WebAssembly.promising` and a
 * syscall may park on a promise, so a plain-WASI child waits at a full pipe as
 * it would on Linux. Where it cannot, the guest is entered on an ordinary
 * stack, no syscall may suspend it, the supervisor it mints is the authority's
 * synchronous view, and a pipe buffers to the host's
 * {@link FacetHost.memoryBudgetBytes} instead (pipe-rules.ts).
 *
 * {@link FacetSubmitOptions.timeoutMs} and `signal` are honoured: either ends
 * the facet, as a substrate with isolates of its own does. A facet waiting for
 * no call holds no part of this process: it does not keep it alive.
 *
 * `network` is the workspace's (`workspace.network`, or
 * `workspaceNetwork(egress)` for the egress the workspace is created with,
 * `ISOLATE_NETWORK` without one): every facet goes out through it.
 */
export function localFacetHost(network) {
    requireNetwork(network, 'localFacetHost');
    return {
        parking: engineParks(),
        // A worker of a Bun or Node process, not a Worker isolate.
        memoryBudgetBytes: 1024 * 1024 * 1024,
        open: (spec) => new RealmFacet(spec, network),
    };
}
/** Why a call ended without its answer. */
const ended = (tag, why) => new Error(`Nimbus: facet '${tag}' ${why}`);
class RealmFacet {
    spec;
    network;
    /** The realm, started on the first call. */
    realm = null;
    /** The image each name is in the facet's table as: what a call need not send again. */
    installed = new Map();
    /** Each image compiled for a thread, once, whether or not a call that sent it succeeded. */
    compiled = new WeakMap();
    /** Submits are serialized: one scope, and a facet's calls are ordered. */
    queue = Promise.resolve();
    waiting = new Map();
    ids = 0;
    disposed = false;
    /** Why the realm ended, once it has. */
    over = null;
    supervisor;
    supervisorMethods;
    synchronous;
    isolation = facetIsolation();
    constructor(spec, network) {
        this.spec = spec;
        this.network = network;
        this.supervisor = spec.syscalls ? vfsSupervisor(spec.syscalls.vfs) : null;
        this.supervisorMethods = SUPERVISOR_METHODS;
        const processes = spec.syscalls?.processes;
        if (this.supervisor && processes && spec.syscalls) {
            const pid = spec.syscalls.pid;
            Object.assign(this.supervisor, {
                stdout: (bytes) => processes.appendOutputBytes(pid, 'stdout', bytes),
                stderr: (bytes) => processes.appendOutputBytes(pid, 'stderr', bytes),
                cpReadStdin: async (_child, waitMs, _acquire, maxBytes) => {
                    const packet = await processes.readInput(pid, waitMs, maxBytes);
                    return { ...packet, data: typeof packet.data === 'string' ? new TextEncoder().encode(packet.data) : packet.data };
                },
            });
            this.supervisorMethods = [...SUPERVISOR_METHODS, 'stdout', 'stderr', 'cpReadStdin'];
        }
        this.synchronous = spec.syscalls?.vfs.synchronous;
    }
    submit(fn, args, options) {
        const run = this.queue.then(() => this.call(fn, args, options));
        // The chain must survive a rejected call, or one failure poisons the facet.
        this.queue = run.catch(() => undefined);
        return run;
    }
    started() {
        this.realm ??= this.start();
        return this.realm;
    }
    async start() {
        const payload = {
            tag: this.spec.tag,
            parking: engineParks(),
            preamble: this.spec.preamble,
            supervisor: this.supervisor ? { methods: this.supervisorMethods, synchronous: this.synchronous ? SYNCHRONOUS_METHODS : null } : undefined,
            egress: this.network.egress !== undefined,
        };
        let post = () => false;
        const egress = this.network.egress === undefined ? null : new RealmEgress(this.network, (event) => { post(event); });
        const realm = await startRealm({
            entry: new URL('./facet-guest.js', import.meta.url),
            isolation: this.isolation,
            payload,
            serve: (call) => this.serve(call),
            onEvent: (event) => {
                if (isEgressGuestEvent(event)) {
                    egress?.handle(event);
                    return;
                }
                if (!isFacetDone(event))
                    return;
                const settle = this.waiting.get(event.id);
                this.waiting.delete(event.id);
                settle?.(event);
            },
        });
        if ('unavailable' in realm)
            throw ended(this.spec.tag, `has no realm: ${realm.unavailable}`);
        post = (event) => realm.post(event);
        realm.hold(false);
        void realm.ended.then((end) => {
            egress?.close();
            this.over = ended(this.spec.tag, end.terminated ? 'was ended' : `ended (${end.failure?.message ?? `exit ${end.code}`})`);
            for (const settle of this.waiting.values())
                settle(this.over);
            this.waiting.clear();
        });
        return realm;
    }
    /** One call the facet makes on its capability: only the methods it was handed, of the view it names. */
    serve(call) {
        if (!isSupervisorCall(call))
            throw new TypeError('Nimbus: a facet called nothing its host answers');
        const target = call.view === 'synchronous' ? this.synchronous : this.supervisor;
        const names = call.view === 'synchronous' ? SYNCHRONOUS_METHODS : this.supervisorMethods;
        const method = target && names.includes(call.method) ? Reflect.get(target, call.method) : undefined;
        if (typeof method !== 'function')
            throw new TypeError(`Nimbus: a facet's ${call.view} has no method ${JSON.stringify(call.method)}`);
        return Reflect.apply(method, target, call.args);
    }
    /**
     * The images a call adds to the facet's table (the spec's, per-call ones
     * over them, but those it holds already), by name, and each as it is sent.
     * Nothing is recorded as held here: only the guest's answer that it
     * installed them does that, so a call that fails sends them all again.
     */
    async modules(callModules) {
        const images = {};
        const sent = {};
        for (const [name, bytes] of Object.entries({ ...this.spec.wasmModules, ...callModules })) {
            if (this.installed.get(name) === bytes)
                continue;
            images[name] = bytes;
            sent[name] = this.isolation === 'thread' ? await this.compile(bytes) : bytes;
        }
        return { images, sent };
    }
    async compile(bytes) {
        const cached = this.compiled.get(bytes);
        if (cached)
            return cached;
        const module = await wasmCompiler()(bytes);
        this.compiled.set(bytes, module);
        return module;
    }
    async call(fn, args, options) {
        if (this.disposed)
            throw ended(this.spec.tag, 'is disposed');
        const signal = options?.signal;
        signal?.throwIfAborted();
        // From here a timeout or an abort ends the call, and the facet with it,
        // at whatever step it has reached: starting, compiling, or running. Every
        // step waits racing it.
        const state = { stopped: null };
        let stop = () => { };
        const stopping = new Promise((_, reject) => {
            stop = (why) => {
                if (state.stopped)
                    return;
                state.stopped = why;
                reject(why);
                this.dispose();
            };
        });
        stopping.catch(() => { });
        const onAbort = () => stop(signal?.reason instanceof Error ? signal.reason : ended(this.spec.tag, 'was aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        // An abort that came between the check above and the listener.
        if (signal?.aborted)
            onAbort();
        const timer = options?.timeoutMs === undefined ? undefined
            : setTimeout(() => stop(ended(this.spec.tag, `timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
        let realm = null;
        const id = ++this.ids;
        try {
            realm = await Promise.race([this.started(), stopping]);
            if (this.over)
                throw this.over;
            const { images, sent } = await Promise.race([this.modules(options?.wasmModules), stopping]);
            // Stopped in the turn the modules were ready: not posted.
            if (state.stopped)
                throw state.stopped;
            const submit = { type: 'submit', id, source: fn.toString(), args, modules: sent };
            const answered = new Promise((resolve) => this.waiting.set(id, resolve));
            if (!realm.post(submit))
                throw ended(this.spec.tag, 'was submitted arguments that cannot cross to its realm');
            // The call holds this process while it runs.
            realm.hold(true);
            const outcome = await Promise.race([answered, stopping]);
            if (outcome instanceof Error)
                throw outcome;
            if (outcome.installed)
                for (const [name, bytes] of Object.entries(images))
                    this.installed.set(name, bytes);
            if ('error' in outcome)
                throw fromRealmError(outcome.error);
            return outcome.value;
        }
        finally {
            this.waiting.delete(id);
            if (timer !== undefined)
                clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            realm?.hold(false);
        }
    }
    dispose() {
        this.disposed = true;
        void this.realm?.then((realm) => realm.terminate(), () => { });
    }
}
