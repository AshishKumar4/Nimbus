export const HOST_WATCH_HEADER = 'x-nimbus-host-watch';
export const HOST_INCARNATION_HEADER = 'x-nimbus-host-incarnation';
/** A data request's per-open capability; with the pinned incarnation, it admits the request at the leaf. */
export const HOST_REQUEST_HEADER = 'x-nimbus-host-request';
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
            close: () => { this.observations.delete(observation); observation.current?.abort.abort(); },
        };
    }
    acquire(signal) {
        return this.hold(signal);
    }
    hold(signal, dependency) {
        signal?.throwIfAborted();
        let rejectReady;
        const cancel = () => {
            signal?.removeEventListener('abort', release);
            rejectReady?.(signal?.aborted ? signal.reason : new DOMException('Host validation aborted', 'AbortError'));
        };
        const release = () => {
            if (!this.owners.delete(cancel))
                return;
            cancel();
            if (this.owners.size === 0)
                this.stop();
        };
        this.owners.add(cancel);
        for (const observation of this.observations)
            if (!observation.failed)
                this.start(observation);
        const ready = dependency ? new Promise((resolve, reject) => {
            rejectReady = reject;
            this.start(dependency).then(resolve, reject);
        }) : undefined;
        ready?.catch(() => { });
        signal?.addEventListener('abort', release, { once: true });
        return { ready, release };
    }
    /** End every old lease; a reused session starts with a fresh ownership epoch. */
    close() {
        for (const cancel of this.owners)
            cancel();
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
 * The requests a host sent a handler on another actor, by id, so it can
 * abandon one: before its response's headers as well as after. Workers RPC
 * carries no signal, and asking per request costs a round trip; abandoning is
 * the rare path, so only it sends anything. Each call carries the ids that
 * ended since the last (`ended`), which the handler then forgets; an abandon
 * that overtakes its request is kept until its request, or its end, arrives.
 */
export class HandledRequests {
    #requests = new Map();
    /** The signal of request `id`, its own if it was abandoned first; `ended` are forgotten first. */
    admit(id, ended) {
        for (const done of ended)
            this.#requests.delete(done);
        let request = this.#requests.get(id);
        if (!request)
            this.#requests.set(id, request = new AbortController());
        return request.signal;
    }
    abandon(id) {
        let request = this.#requests.get(id);
        if (!request)
            this.#requests.set(id, request = new AbortController());
        request.abort(new DOMException('The caller left the request', 'AbortError'));
    }
}
/** The sending host's side: ids for its requests, the ended ones to report, and an abandon on `scope`'s abort. */
export class SentRequests {
    #next = 0;
    #ended = [];
    /** An id for a request with `scope`, the ids to report, and abandon(id) sent if the scope aborts first. */
    send(scope, abandon) {
        const id = this.#next++;
        const ended = this.#ended;
        this.#ended = [];
        // Reported as ended only once any abandon was delivered: a report that
        // overtook it would leave the handler holding the late abandon for good.
        const end = () => { this.#ended.push(id); };
        const left = () => { void abandon(id).then(end, end); };
        if (scope.signal.aborted)
            left();
        else {
            scope.signal.addEventListener('abort', left, { once: true });
            void scope.settled.then(() => {
                scope.signal.removeEventListener('abort', left);
                if (!scope.signal.aborted)
                    end();
            });
        }
        return { id, ended };
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
    return config;
}
/**
 * The bytes observeResidentConfig adds to a resident's map whose main module
 * is `mainModule`: part of what the map's ceiling holds beside its own text.
 */
export function hostAdapterBytes(mainModule) {
    return new TextEncoder().encode(hostAdapter(mainModule, crypto.randomUUID())).byteLength;
}
function hostAdapter(mainModule, capability) {
    const [watch, request, incarnation, key] = [HOST_WATCH_HEADER, HOST_REQUEST_HEADER, HOST_INCARNATION_HEADER, capability].map((value) => JSON.stringify(value));
    // Module scope, not the class's text: a guest reads its class's source
    // (this.constructor.toString()), and with the capability could forge a refusal.
    return `import { NimbusProcess as Base } from ${JSON.stringify('./' + mainModule)};
export * from ${JSON.stringify('./' + mainModule)};
const capability = ${key};
export class NimbusProcess extends Base {
  #incarnation = crypto.randomUUID();
  #watchers = new Set();
  // A guest's fetch may hand its request on to its own handleHttpRequest.
  #admitted = new WeakSet();
  // Its host's requests by id, as HandledRequests keeps them.
  #requests = new Map();
  #request(id, ended) {
    for (const done of ended) this.#requests.delete(done);
    let request = this.#requests.get(id);
    if (!request) this.#requests.set(id, request = new AbortController());
    return request;
  }
  #admit(request) {
    if (this.#admitted.has(request)) return request;
    if (request.headers.get(${request}) !== capability) return new Response('Not found', { status: 404 });
    if (request.headers.get(${incarnation}) !== this.#incarnation) return this.#replaced();
    const headers = new Headers(request.headers);
    headers.delete(${request});
    headers.delete(${incarnation});
    const admitted = new Request(request, { headers });
    this.#admitted.add(admitted);
    return admitted;
  }
  #replaced() {
    return new Response('the instance that ran this process was replaced', { status: 410, headers: { [${request}]: capability } });
  }
  handleHttpRequest(request) {
    const admitted = this.#admit(request);
    return admitted instanceof Request ? super.handleHttpRequest(admitted) : admitted;
  }
  // The host's HTTP entry. Its admission travels as arguments, and request
  // \`id\` is one its host can abandon (HandledRequests): the guest sees its
  // caller leave as its request's signal.
  hostHttpRequest(request, key, pinned, id, ended) {
    if (key !== capability) return new Response('Not found', { status: 404 });
    if (pinned !== this.#incarnation) return this.#replaced();
    const admitted = new Request(request, { signal: this.#request(id, ended).signal });
    this.#admitted.add(admitted);
    return super.handleHttpRequest(admitted);
  }
  abandonHttpRequest(key, id) {
    if (key === capability) this.#request(id, []).abort(new DOMException('The caller left the request', 'AbortError'));
  }
  fetch(request) {
    if (request.headers.get(${watch}) !== capability) {
      const admitted = this.#admit(request);
      return admitted instanceof Request ? super.fetch(admitted) : admitted;
    }
    const watchers = this.#watchers;
    let current;
    const body = new ReadableStream({ start(controller) { current = controller; watchers.add(controller); }, cancel() { watchers.delete(current); } });
    return new Response(body, { headers: { [${incarnation}]: this.#incarnation } });
  }
}`;
}
