export const HOST_WATCH_HEADER = 'x-nimbus-host-watch';
export const HOST_INCARNATION_HEADER = 'x-nimbus-host-incarnation';
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
            if (observation.incarnation !== undefined && observation.incarnation !== incarnation) {
                await close();
                throw new Error('Nimbus: the process host restarted without its process');
            }
            observation.incarnation = incarnation;
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
const activities = new WeakMap();
export function hostActivity(host) {
    let activity = activities.get(host);
    if (!activity) {
        activity = new HostActivity();
        activities.set(host, activity);
    }
    return activity;
}
/** Target validation and response work share one lease through native body completion. */
export async function hostResponse(ctx, observation, request, dispatch) {
    const lease = observation.acquire(request.signal);
    try {
        await lease.ready;
        request.signal.throwIfAborted();
        const response = await dispatch();
        // An upgrade transfers native socket ownership to its caller at the handshake.
        if (response.webSocket || response.body === null) {
            lease.release();
            return response;
        }
        const declared = request.method === 'HEAD' ? null : response.headers.get('Content-Length');
        const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : NaN;
        const { readable, writable } = Number.isSafeInteger(length)
            ? new FixedLengthStream(length)
            : new IdentityTransformStream();
        ctx.waitUntil(response.body.pipeTo(writable).finally(lease.release).catch(() => { }));
        return new Response(readable, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    catch (error) {
        lease.release();
        throw error;
    }
}
/** One native fetch endpoint, outside the guest's HTTP handler, on every resident class. */
export function observeResidentConfig(config, capability) {
    const modules = config.modules;
    const entry = HOST_WATCH_MODULE;
    if (Object.hasOwn(modules, entry))
        throw new Error('resident worker uses a reserved module name');
    modules[entry] = `import { NimbusProcess as Base } from ${JSON.stringify('./' + config.mainModule)};
export * from ${JSON.stringify('./' + config.mainModule)};
export class NimbusProcess extends Base {
  #incarnation = crypto.randomUUID();
  #watchers = new Set();
  fetch(request) {
    if (request.headers.get(${JSON.stringify(HOST_WATCH_HEADER)}) !== ${JSON.stringify(capability)}) return super.fetch(request);
    const watchers = this.#watchers;
    let current;
    const body = new ReadableStream({ start(controller) { current = controller; watchers.add(controller); }, cancel() { watchers.delete(current); } });
    return new Response(body, {headers:{${JSON.stringify(HOST_INCARNATION_HEADER)}:this.#incarnation}});
  }
}`;
    config.mainModule = entry;
    return config;
}
