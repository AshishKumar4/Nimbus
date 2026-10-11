/** A host-loss watch exists only while somebody owns work on this actor. */
export interface HostActivityLease {
  readonly ready?: Promise<void>;
  release(): void;
}

export const HOST_WATCH_HEADER = 'x-nimbus-host-watch';
export const HOST_INCARNATION_HEADER = 'x-nimbus-host-incarnation';

interface Observation {
  readonly open: (signal: AbortSignal) => Promise<Response>;
  readonly lost: (error: Error) => void;
  incarnation?: string;
  current?: { abort: AbortController; ready: Promise<void> };
  failed: Error | null;
}

export class HostActivity {
  private readonly observations = new Set<Observation>();
  private owners = 0;
  private generation = 0;

  observe(open: Observation['open'], lost: Observation['lost']): () => void {
    const observation: Observation = { open, lost, failed: null };
    this.observations.add(observation);
    if (this.owners) this.start(observation);
    return () => { this.observations.delete(observation); observation.current?.abort.abort(); };
  }

  acquire(): HostActivityLease {
    const generation = this.generation;
    this.owners++;
    let released = false;
    const ready = this.observations.size ? Promise.all([...this.observations].map((observation) => this.start(observation))).then(() => undefined) : undefined;
    ready?.catch(() => {});
    return { ready, release: () => {
      if (released) return;
      released = true;
      if (generation !== this.generation || --this.owners !== 0) return;
      this.stop();
    } };
  }

  async run<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const lease = this.acquire();
    signal?.addEventListener('abort', lease.release, { once: true });
    try { await lease.ready; signal?.throwIfAborted(); return await work(); }
    finally { signal?.removeEventListener('abort', lease.release); lease.release(); }
  }

  /** End every old lease; a reused session starts with a fresh ownership epoch. */
  close(): void {
    this.generation++;
    this.owners = 0;
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
      if (abort.signal.aborted) { await response.body?.cancel(); return; }
      const incarnation = response.headers.get(HOST_INCARNATION_HEADER);
      if (response.status !== 200 || !incarnation || !response.body) {
        await response.body?.cancel();
        throw new Error('Nimbus: the process host did not validate its incarnation');
      }
      if (observation.incarnation !== undefined && observation.incarnation !== incarnation) {
        await response.body.cancel();
        throw new Error('Nimbus: the process host restarted without its process');
      }
      observation.incarnation = incarnation;
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
      const cancelled = abort.signal.aborted;
      this.failed(observation, abort, error);
      if (!cancelled) throw error;
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

const activities = new WeakMap<object, HostActivity>();
export function hostActivity(host: object): HostActivity {
  let activity = activities.get(host);
  if (!activity) { activity = new HostActivity(); activities.set(host, activity); }
  return activity;
}

/** One native fetch endpoint, outside the guest's HTTP handler, on every resident class. */
export function observeResidentConfig(config: Record<string, unknown>, capability: string): Record<string, unknown> {
  if (typeof config.mainModule !== 'string' || typeof config.modules !== 'object' || config.modules === null) throw new TypeError('resident worker has no module map');
  const modules = config.modules as Record<string, unknown>;
  const entry = '__nimbus_host_watch.js';
  if (Object.hasOwn(modules, entry)) throw new Error('resident worker uses a reserved module name');
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
