import type { WorkerCode } from '@nimbus-sh/platform/worker-code.js';
import type { ResponseScope } from '@nimbus-sh/core/runtime/os-contracts.js';

/** A host-loss watch exists only while somebody owns work on this actor. */
export interface HostActivityLease {
  readonly ready?: Promise<void>;
  release(): void;
}

export interface HostObservation {
  acquire(signal?: AbortSignal): HostActivityLease;
  /** A watch on the host is open now and found the pinned incarnation. */
  validated(): boolean;
  close(): void;
}

export const HOST_WATCH_HEADER = 'x-nimbus-host-watch';
export const HOST_INCARNATION_HEADER = 'x-nimbus-host-incarnation';
/** A data request's per-open capability; with the pinned incarnation, it admits the request at the leaf. */
export const HOST_REQUEST_HEADER = 'x-nimbus-host-request';
/** On a leaf's 500, its capability: the guest's handler failed, and the call arrived. */
export const HOST_FAILED_HEADER = 'x-nimbus-host-failed';
export const HOST_WATCH_MODULE = '__nimbus_host_watch.js';

interface Observation {
  readonly open: (signal: AbortSignal) => Promise<Response>;
  readonly lost: (error: Error) => void;
  /** The host's incarnation, pinned when the process opened; a watch never changes it. */
  readonly incarnation: string | Promise<string>;
  current?: { abort: AbortController; ready: Promise<void>; validated?: true };
  failed: Error | null;
}

export class HostActivity {
  private readonly observations = new Set<Observation>();
  private readonly owners = new Set<() => void>();

  observe(open: Observation['open'], lost: Observation['lost'], incarnation: Observation['incarnation']): HostObservation {
    const observation: Observation = { open, lost, incarnation, failed: null };
    this.observations.add(observation);
    if (this.owners.size) this.start(observation);
    return {
      acquire: (signal) => {
        if (!this.observations.has(observation)) throw new Error('Nimbus: the process is no longer running');
        return this.hold(signal, observation);
      },
      validated: () => !observation.failed && observation.current?.validated === true,
      close: () => { this.observations.delete(observation); observation.current?.abort.abort(); },
    };
  }

  acquire(signal?: AbortSignal): HostActivityLease {
    return this.hold(signal);
  }

  private hold(signal?: AbortSignal, dependency?: Observation): HostActivityLease {
    signal?.throwIfAborted();
    let rejectReady: ((reason: unknown) => void) | undefined;
    let ready: Promise<void> | undefined;
    let ended = false;
    const reason = () => signal?.aborted ? signal.reason : new DOMException('Host validation aborted', 'AbortError');
    const cancel = () => {
      ended = true;
      signal?.removeEventListener('abort', release);
      rejectReady?.(reason());
    };
    const release = () => {
      if (!this.owners.delete(cancel)) return;
      cancel();
      if (this.owners.size === 0) this.stop();
    };
    const idle = this.owners.size === 0;
    this.owners.add(cancel);
    // While anything holds the host its observations already run.
    if (idle) for (const observation of this.observations) if (!observation.failed) this.start(observation);
    signal?.addEventListener('abort', release, { once: true });
    const validated = () => {
      if (!dependency) return undefined;
      if (!ready) {
        ready = ended ? Promise.reject(reason()) : new Promise<void>((resolve, reject) => {
          rejectReady = reject;
          this.start(dependency).then(resolve, reject);
        });
        ready.catch(() => {});
      }
      return ready;
    };
    // Made only for a holder that waits on validation; a request never does.
    return { get ready() { return validated(); }, release };
  }

  /** End every old lease; a reused session starts with a fresh ownership epoch. */
  close(): void {
    for (const cancel of this.owners) cancel();
    this.owners.clear();
    this.stop();
  }

  private stop(): void {
    for (const observation of this.observations) {
      observation.current?.abort.abort();
      observation.current = undefined;
    }
  }

  private start(observation: Observation): Promise<void> {
    if (observation.failed) return Promise.reject(observation.failed);
    if (observation.current) return observation.current.ready;
    const abort = new AbortController();
    const ready = Promise.resolve().then(() => observation.open(abort.signal)).then(async (response) => {
      const socket = response.webSocket;
      const close = async () => {
        if (socket) { socket.accept(); socket.close(1000, 'watch released'); }
        else await response.body?.cancel();
      };
      if (abort.signal.aborted) { await close(); throw abort.signal.reason; }
      const incarnation = response.headers.get(HOST_INCARNATION_HEADER);
      if (!incarnation || !((response.status === 101 && socket) || (response.status === 200 && response.body))) {
        await close();
        throw new Error('Nimbus: the process host did not validate its incarnation');
      }
      if (incarnation !== await observation.incarnation) {
        await close();
        throw new Error('Nimbus: the process host restarted without its process');
      }
      if (observation.current?.abort === abort) observation.current.validated = true;
      if (socket) {
        const cancel = () => socket.close(1000, 'watch released');
        const ended = () => {
          abort.signal.removeEventListener('abort', cancel);
          socket.removeEventListener('close', ended);
          socket.removeEventListener('error', ended);
          if (!abort.signal.aborted) this.failed(observation, abort, new Error('Nimbus: the process host ended its active watch'));
        };
        socket.addEventListener('close', ended);
        socket.addEventListener('error', ended);
        abort.signal.addEventListener('abort', cancel, { once: true });
        socket.accept();
        return;
      }
      if (!response.body) throw new Error('Nimbus: the process host has no watch body');
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      abort.signal.addEventListener('abort', cancel, { once: true });
      void (async () => {
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) {
              if (!abort.signal.aborted) throw new Error('Nimbus: the process host ended its active watch');
              return;
            }
          }
        } catch (error) { this.failed(observation, abort, error); }
        finally { abort.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
      })();
    }).catch((error) => {
      this.failed(observation, abort, error);
      throw error;
    });
    ready.catch(() => {});
    observation.current = { abort, ready };
    return ready;
  }

  private failed(observation: Observation, abort: AbortController, error: unknown): void {
    if (abort.signal.aborted || observation.failed || !this.observations.has(observation)) return;
    observation.failed = error instanceof Error ? error : new Error(String(error));
    observation.lost(observation.failed);
  }
}

/**
 * The requests a host sends a resident's leaf, by id, so it can abandon one:
 * before its response's headers as well as after. Workers RPC carries no
 * signal, and asking per request costs a round trip; abandoning is the rare
 * path, so only it sends anything (the leaf's abandonHttpRequest). Each call
 * carries the ids that ended since the last (`ended`), which the leaf then
 * forgets, and those whose abandon did not arrive (`abandoned`), which it
 * abandons and forgets; it keeps an abandon that overtakes its request until
 * its request, or its end, arrives (observeResidentConfig).
 */
export class SentRequests {
  #next = 0;
  #ended: number[] = [];
  #abandoned: number[] = [];
  /** An id for a request with `scope`, the ids to report, and abandon(id) sent if it is not delivered. */
  send(scope: ResponseScope, abandon: (id: number) => Promise<unknown>): HostRequest {
    const id = this.#next++;
    const { ended, abandoned } = { ended: this.#ended, abandoned: this.#abandoned };
    this.#ended = [];
    this.#abandoned = [];
    // Reported as ended only once its abandon arrived: a report that overtook
    // it would leave the leaf holding the late abandon for good. One that did
    // not arrive rides the next request instead.
    void scope.settled.then((delivered) => {
      if (delivered) this.#ended.push(id);
      else void abandon(id).then(() => this.#ended.push(id), () => this.#abandoned.push(id));
    });
    return { id, ended, abandoned };
  }

  /** `request`'s call failed before its leaf saw what it carried (leafReceived): carry it again (each is idempotent there). */
  unsent(request: HostRequest): void {
    this.#ended.push(...request.ended);
    this.#abandoned.push(...request.abandoned);
  }
}

/**
 * The property a host sets on a guest failure its leaf answered: the call
 * arrived, and what it carried was seen; any other failure may not have
 * reached the leaf. It crosses only Nimbus's own RPC (a peer to its
 * coordinator), which composeFabric holds to enhanced_error_serialization.
 */
export const LEAF_RECEIVED = 'nimbusLeafReceived';
export function leafReceived(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, LEAF_RECEIVED) === true;
}
export function receivedFailure(failure: Error): Error {
  try { return Object.assign(failure, { [LEAF_RECEIVED]: true }); }
  catch { return Object.assign(new Error(failure.message, { cause: failure }), { [LEAF_RECEIVED]: true }); }
}

/** A request's id, and the earlier ones its leaf forgets (`ended`) or abandons first (`abandoned`). */
export interface HostRequest {
  id: number;
  ended: number[];
  abandoned: number[];
}

const activities = new WeakMap<object, HostActivity>();
export function hostActivity(host: object): HostActivity {
  let activity = activities.get(host);
  if (!activity) { activity = new HostActivity(); activities.set(host, activity); }
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
export function observeResidentConfig(config: WorkerCode, capability: string): WorkerCode {
  const modules = config.modules;
  const entry = HOST_WATCH_MODULE;
  if (Object.hasOwn(modules, entry)) throw new Error('resident worker uses a reserved module name');
  modules[entry] = hostAdapter(config.mainModule, capability);
  config.mainModule = entry;
  return config;
}

/**
 * The bytes observeResidentConfig adds to a resident's map whose main module
 * is `mainModule`: part of what the map's ceiling holds beside its own text.
 */
export function hostAdapterBytes(mainModule: string): number {
  return new TextEncoder().encode(hostAdapter(mainModule, crypto.randomUUID())).byteLength;
}

function hostAdapter(mainModule: string, capability: string): string {
  const [watch, request, incarnation, key, failed] = [HOST_WATCH_HEADER, HOST_REQUEST_HEADER, HOST_INCARNATION_HEADER, capability, HOST_FAILED_HEADER].map((value) => JSON.stringify(value));
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
  // Its host's requests by id (SentRequests).
  #requests = new Map();
  #request(id, ended, abandoned = []) {
    for (const done of ended) this.#requests.delete(done);
    for (const gone of abandoned) {
      this.#requests.get(gone)?.abort(new DOMException('The caller left the request', 'AbortError'));
      this.#requests.delete(gone);
    }
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
  // \`id\` is one its host can abandon (SentRequests): the guest sees its
  // caller leave as its request's signal.
  // A guest that fails answers a capability-branded 500 (HOST_FAILED_HEADER):
  // its host learns the call arrived, whatever the guest's compatibility date.
  async hostHttpRequest(request, id, ended, abandoned, admission) {
    // Its host sends the capability and the pinned incarnation while it has
    // no live watch that found this instance; with one, the watch admits it.
    if (admission !== undefined) {
      if (admission[0] !== capability) return new Response('Not found', { status: 404 });
      if (admission[1] !== this.#incarnation) return this.#replaced();
    }
    const admitted = new Request(request, { signal: this.#request(id, ended, abandoned).signal });
    this.#admitted.add(admitted);
    try { return await super.handleHttpRequest(admitted); }
    catch (error) { return new Response(error instanceof Error ? error.message : String(error), { status: 500, headers: { [${failed}]: capability } }); }
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
