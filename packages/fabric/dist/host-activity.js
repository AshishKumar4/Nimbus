import { utf8Length } from '@nimbus-sh/platform/utf8.js';
export const HOST_WATCH_HEADER = 'x-nimbus-host-watch';
export const HOST_INCARNATION_HEADER = 'x-nimbus-host-incarnation';
/** A data request's per-open capability; with the pinned incarnation, it admits the request at the leaf. */
export const HOST_REQUEST_HEADER = 'x-nimbus-host-request';
/** On a leaf's 500, its capability: the guest's handler failed, and the call arrived. */
export const HOST_FAILED_HEADER = 'x-nimbus-host-failed';
export const HOST_WATCH_MODULE = '__nimbus_host_watch.js';
export class HostActivity {
    observations = new Set();
    owners = new Set();
    observe(open, lost, incarnation) {
        const observation = { open, lost, incarnation, failed: null };
        this.observations.add(observation);
        if (this.owners.size)
            this.start(observation);
        return {
            acquire: (signal) => {
                if (!this.observations.has(observation))
                    throw new Error('Nimbus: the process is no longer running');
                return this.hold(signal, observation);
            },
            validated: () => !observation.failed && observation.current?.validated === true,
            close: () => { this.observations.delete(observation); observation.current?.abort.abort(); },
        };
    }
    acquire(signal) {
        return this.hold(signal);
    }
    hold(signal, dependency) {
        signal?.throwIfAborted();
        const lease = new Lease(this, signal, dependency);
        const idle = this.owners.size === 0;
        this.owners.add(lease);
        // While anything holds the host its observations already run.
        if (idle)
            for (const observation of this.observations)
                if (!observation.failed)
                    this.start(observation);
        signal?.addEventListener('abort', lease, { once: true });
        return lease;
    }
    /** `lease` let go: the last one stops the host's observations. */
    released(lease) {
        if (!this.owners.delete(lease))
            return false;
        if (this.owners.size === 0)
            this.stop();
        return true;
    }
    /** `dependency`'s validation, for a holder that waits on it. */
    validation(dependency) {
        return this.start(dependency);
    }
    /** End every old lease; a reused session starts with a fresh ownership epoch. */
    close() {
        for (const lease of this.owners)
            lease.cancel();
        this.owners.clear();
        this.stop();
    }
    stop() {
        for (const observation of this.observations) {
            observation.current?.abort.abort();
            observation.current = undefined;
        }
    }
    start(observation) {
        if (observation.failed)
            return Promise.reject(observation.failed);
        if (observation.current)
            return observation.current.ready;
        const abort = new AbortController();
        const ready = Promise.resolve().then(() => observation.open(abort.signal)).then(async (response) => {
            const socket = response.webSocket;
            const close = async () => {
                if (socket) {
                    socket.accept();
                    socket.close(1000, 'watch released');
                }
                else
                    await response.body?.cancel();
            };
            if (abort.signal.aborted) {
                await close();
                throw abort.signal.reason;
            }
            const incarnation = response.headers.get(HOST_INCARNATION_HEADER);
            if (!incarnation || !((response.status === 101 && socket) || (response.status === 200 && response.body))) {
                await close();
                throw new Error('Nimbus: the process host did not validate its incarnation');
            }
            if (incarnation !== await observation.incarnation) {
                await close();
                throw new Error('Nimbus: the process host restarted without its process');
            }
            if (observation.current?.abort === abort)
                observation.current.validated = true;
            if (socket) {
                const cancel = () => socket.close(1000, 'watch released');
                const ended = () => {
                    abort.signal.removeEventListener('abort', cancel);
                    socket.removeEventListener('close', ended);
                    socket.removeEventListener('error', ended);
                    if (!abort.signal.aborted)
                        this.failed(observation, abort, new Error('Nimbus: the process host ended its active watch'));
                };
                socket.addEventListener('close', ended);
                socket.addEventListener('error', ended);
                abort.signal.addEventListener('abort', cancel, { once: true });
                socket.accept();
                return;
            }
            if (!response.body)
                throw new Error('Nimbus: the process host has no watch body');
            const reader = response.body.getReader();
            const cancel = () => { void reader.cancel().catch(() => { }); };
            abort.signal.addEventListener('abort', cancel, { once: true });
            void (async () => {
                try {
                    for (;;) {
                        const part = await reader.read();
                        if (part.done) {
                            if (!abort.signal.aborted)
                                throw new Error('Nimbus: the process host ended its active watch');
                            return;
                        }
                    }
                }
                catch (error) {
                    this.failed(observation, abort, error);
                }
                finally {
                    abort.signal.removeEventListener('abort', cancel);
                    reader.releaseLock();
                }
            })();
        }).catch((error) => {
            this.failed(observation, abort, error);
            throw error;
        });
        ready.catch(() => { });
        observation.current = { abort, ready };
        return ready;
    }
    failed(observation, abort, error) {
        if (abort.signal.aborted || observation.failed || !this.observations.has(observation))
            return;
        observation.failed = error instanceof Error ? error : new Error(String(error));
        observation.lost(observation.failed);
    }
}
/**
 * The requests a coordinator sends the peer hosting a process, by id, so it
 * can abandon one: before its response's headers as well as after. Workers
 * RPC carries no signal, and asking per request costs a round trip;
 * abandoning is the rare path, so only it sends anything (the peer's
 * abandonHostedHttp). Each call carries `low`, below which every id is
 * retired (delivered, or abandoned where the peer heard it), so the peer
 * forgets them; and, only when there are any, the ids whose abandon did not
 * arrive (`abandoned`), which the peer abandons first (HandledRequests).
 */
export class SentRequests {
    #next = 0;
    #low = 0;
    /** Sent and not retired. */
    #open = new Set();
    #abandoned = [];
    /** An id for a request, the watermark below which its leaf forgets, and any abandons it must carry. */
    send() {
        const id = this.#next++;
        this.#open.add(id);
        if (this.#abandoned.length === 0)
            return { id, low: this.#low };
        const abandoned = this.#abandoned;
        this.#abandoned = [];
        return { id, low: this.#low, abandoned };
    }
    /**
     * Request `id` ended: retired when delivered, else once its abandon
     * arrived. A retirement that overtook the abandon would let the leaf forget
     * it unabandoned; an abandon that does not arrive rides the next request.
     */
    settled(id, delivered, abandon) {
        if (delivered)
            this.#retire(id);
        else
            void abandon(id).then(() => this.#retire(id), () => this.#abandoned.push(id));
    }
    /** `request`'s peer answered: the abandons it carried arrived. */
    received(request) {
        if (request.abandoned)
            for (const id of request.abandoned)
                this.#retire(id);
    }
    /** `request`'s call failed before its peer saw it (leafReceived): its abandons ride the next one. */
    unsent(request) {
        if (request.abandoned)
            this.#abandoned.push(...request.abandoned);
    }
    #retire(id) {
        this.#open.delete(id);
        while (this.#low < this.#next && !this.#open.has(this.#low))
            this.#low++;
    }
}
/**
 * The receiving end of SentRequests: one AbortController per request its
 * sender may still abandon, aborted when that abandon arrives, whether before
 * the request (kept until it comes) or after. Ids below the sender's `low`
 * are forgotten; a request that arrives already retired was abandoned, and
 * runs aborted.
 */
export class HandledRequests {
    #requests = new Map();
    #low = 0;
    /** The signal request `request.id` runs under, once the abandons it carried are applied. */
    signal(request) {
        if (request.abandoned !== undefined)
            for (const gone of request.abandoned)
                this.abandon(gone);
        const { id, low } = request;
        if (low > this.#low) {
            // Ids are sequential: forget each retired one, or scan when the step outruns the table.
            if (low - this.#low <= this.#requests.size)
                while (this.#low < low)
                    this.#requests.delete(this.#low++);
            else {
                for (const known of this.#requests.keys())
                    if (known < low)
                        this.#requests.delete(known);
                this.#low = low;
            }
        }
        // Retired before it arrived: only an abandon its sender heard retires a request not yet delivered.
        if (id < this.#low)
            return AbortSignal.abort(new DOMException('The caller left the request', 'AbortError'));
        let controller = this.#requests.get(id);
        if (!controller)
            this.#requests.set(id, controller = new AbortController());
        return controller.signal;
    }
    /** Its sender abandoned request `id`. */
    abandon(id) {
        if (id < this.#low)
            return;
        let controller = this.#requests.get(id);
        if (!controller)
            this.#requests.set(id, controller = new AbortController());
        controller.abort(new DOMException('The caller left the request', 'AbortError'));
    }
}
/**
 * The property a host sets on a guest failure its leaf answered: the call
 * arrived, and what it carried was seen; any other failure may not have
 * reached the leaf. It crosses only Nimbus's own RPC (a peer to its
 * coordinator), which composeFabric holds to enhanced_error_serialization.
 */
export const LEAF_RECEIVED = 'nimbusLeafReceived';
export function leafReceived(error) {
    return typeof error === 'object' && error !== null && Reflect.get(error, LEAF_RECEIVED) === true;
}
export function receivedFailure(failure) {
    try {
        return Object.assign(failure, { [LEAF_RECEIVED]: true });
    }
    catch {
        return Object.assign(new Error(failure.message, { cause: failure }), { [LEAF_RECEIVED]: true });
    }
}
/**
 * One holder's claim on a host's activity: an object of its own rather than a
 * set of closures, since every routed request takes one. Its validation
 * promise is made only for a holder that reads `ready`; a request never does.
 */
class Lease {
    activity;
    signal;
    dependency;
    #ended = false;
    #ready;
    #reject;
    constructor(activity, signal, dependency) {
        this.activity = activity;
        this.signal = signal;
        this.dependency = dependency;
    }
    get ready() {
        const dependency = this.dependency;
        if (!dependency)
            return undefined;
        if (!this.#ready) {
            this.#ready = this.#ended ? Promise.reject(this.#reason()) : new Promise((resolve, reject) => {
                this.#reject = reject;
                this.activity.validation(dependency).then(resolve, reject);
            });
            this.#ready.catch(() => { });
        }
        return this.#ready;
    }
    release() {
        if (this.activity.released(this))
            this.cancel();
    }
    /** The signal aborted. */
    handleEvent() { this.release(); }
    /** Ended without being released by its holder (HostActivity.close), or as it is released. */
    cancel() {
        this.#ended = true;
        this.signal?.removeEventListener('abort', this);
        this.#reject?.(this.#reason());
    }
    #reason() {
        return this.signal?.aborted ? this.signal.reason : new DOMException('Host validation aborted', 'AbortError');
    }
}
const activities = new WeakMap();
export function hostActivity(host) {
    let activity = activities.get(host);
    if (!activity) {
        activity = new HostActivity();
        activities.set(host, activity);
    }
    return activity;
}
/**
 * One native fetch endpoint, outside the guest's HTTP handler, on every
 * resident class, and the admission of both data entrypoints. A watch reports
 * this instance's incarnation; a data request runs only with the per-open
 * capability and the incarnation its host pinned at open, so an instance the
 * platform put in the original's place refuses it before any guest code runs
 * (its constructor and module scope still run: no subclass precedes them).
 * The refusal carries the capability, which no guest answer can.
 */
export function observeResidentConfig(config, capability) {
    const modules = config.modules;
    const entry = HOST_WATCH_MODULE;
    if (Object.hasOwn(modules, entry))
        throw new Error('resident worker uses a reserved module name');
    modules[entry] = hostAdapter(config.mainModule, capability);
    config.mainModule = entry;
    // The guest's request signal is its host's call: aborted when its caller
    // leaves, and carried by the guest's own fetch or clone of the request. A
    // program that turned either off keeps its choice.
    const flags = config.compatibilityFlags ?? [];
    config.compatibilityFlags = [...flags, ...RESIDENT_SIGNAL_FLAGS.filter(([on, off]) => !flags.includes(on) && !flags.includes(off)).map(([on]) => on)];
    return config;
}
/** The compatibility flags a resident's request signal needs, each beside the flag that turns it off. */
const RESIDENT_SIGNAL_FLAGS = [['enable_request_signal', 'disable_request_signal'], ['request_signal_passthrough', 'no_request_signal_passthrough']];
/**
 * The bytes observeResidentConfig adds to a resident's map whose main module
 * is `mainModule`: part of what the map's ceiling holds beside its own text.
 */
export function hostAdapterBytes(mainModule) {
    return utf8Length(hostAdapter(mainModule, crypto.randomUUID()));
}
function hostAdapter(mainModule, capability) {
    const [watch, request, incarnation, key, failed] = [HOST_WATCH_HEADER, HOST_REQUEST_HEADER, HOST_INCARNATION_HEADER, capability, HOST_FAILED_HEADER].map((value) => JSON.stringify(value));
    // Module scope, not the class's text: a guest reads its class's source
    // (this.constructor.toString()), and with the capability could forge a refusal.
    return `import { NimbusProcess as Base } from ${JSON.stringify('./' + mainModule)};
export * from ${JSON.stringify('./' + mainModule)};
const capability = ${key};
// A guest's fetch may hand its request on to its own handleHttpRequest: what
// this adapter admitted carries this mark, which only the adapter can name.
const admittedMark = Symbol('admitted');
const failed = (error) => new Response(error instanceof Error ? error.message : String(error), { status: 500, headers: { [${failed}]: capability } });
// The guest's encoded answer as HTTP carries it to its host: its bytes as
// they are, which its host fetches unencoded too, so the registry decodes
// them once, as it did the bytes an RPC hop carried.
const sent = (response) => {
  if (!(response instanceof Response) || response.body === null || response.headers.get('content-encoding') === null) return response;
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers, encodeBody: 'manual' });
};export class NimbusProcess extends Base {
  #incarnation = crypto.randomUUID();
  #watchers = new Set();
  #admit(request) {
    if (request[admittedMark] === true) return request;
    if (request.headers.get(${request}) !== capability) return new Response('Not found', { status: 404 });
    if (request.headers.get(${incarnation}) !== this.#incarnation) return this.#replaced();
    const headers = new Headers(request.headers);
    headers.delete(${request});
    headers.delete(${incarnation});
    const admitted = new Request(request, { headers });
    admitted[admittedMark] = true;
    return admitted;
  }
  #replaced() {
    return new Response('the instance that ran this process was replaced', { status: 410, headers: { [${request}]: capability } });
  }
  handleHttpRequest(request) {
    const admitted = this.#admit(request);
    return admitted instanceof Request ? super.handleHttpRequest(admitted) : admitted;
  }
  // Its host's call before it ends the process: what the process was told it
  // wrote and has not logged yet, logged into this facet's store
  // (globalThis.__nimbusSettle, its runtime's; a runtime that logs each
  // change as it makes it has none).
  settle() {
    globalThis.__nimbusSettle?.();
  }
  // The host's one entry. A watch reports this instance's incarnation; a data
  // request carries its admission in its headers until its host holds a live
  // watch that found this instance, and none after. An upgrade goes to the
  // guest's fetch, any other request to its HTTP handler, as it came: its
  // signal is this call's own, aborted when the host cancels it (its caller
  // left), and a guest's clone or fetch of it keeps it (request_signal_passthrough).
  // A guest that fails answers a capability-branded 500 (HOST_FAILED_HEADER):
  // its host learns the call arrived, whatever the guest's compatibility date.
  fetch(request) {
    const headers = request.headers;
    const watching = headers.get(${watch});
    if (watching !== null) {
      // Only its host watches: a watch with another key enters neither endpoint.
      if (watching !== capability) return new Response('Not found', { status: 404 });
      const watchers = this.#watchers;
      let current;
      const body = new ReadableStream({ start(controller) { current = controller; watchers.add(controller); }, cancel() { watchers.delete(current); } });
      return new Response(body, { headers: { [${incarnation}]: this.#incarnation } });
    }
    let admitted = request;
    if (headers.get(${request}) !== null) {
      admitted = this.#admit(request);
      if (!(admitted instanceof Request)) return admitted;
    }
    if (headers.get('upgrade')?.toLowerCase() === 'websocket') return super.fetch(admitted);
    admitted[admittedMark] = true;
    try { return Promise.resolve(super.handleHttpRequest(admitted)).then(sent, failed); }
    catch (error) { return failed(error); }
  }
}`;
}
