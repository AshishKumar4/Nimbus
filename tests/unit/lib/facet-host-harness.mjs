// A session Durable Object's facet host, for tests.
//
// Models the two platform surfaces a resident process is built from and
// nothing else:
//
//   env.LOADER.get(id, config)          — the Worker Loader. The config
//                                         callback runs once per id, on the
//                                         miss, exactly as workerd caches it.
//   ctx.facets.get(name, start)         — a named child actor. `start` runs
//                                         only when the facet has to be
//                                         created; `abort`/`delete` drop it,
//                                         so a later use re-enters `start`.
//
// One EVALUATION of a program is one boot: `world.boots` is the ledger a ghost
// process would show up in, because a second boot means the user's module
// scope ran twice.
import { hostActivity, observeResidentConfig, HOST_WATCH_HEADER, HOST_INCARNATION_HEADER, HOST_REQUEST_HEADER } from '../../../packages/fabric/src/host-activity.ts';
import { memoryStorage } from './do-storage.mjs';
import { importModuleSet } from './module-map-bundle.mjs';
import { installHostWatchSocket } from './host-watch-socket.mjs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
installHostWatchSocket();

/** A guest the generated adapter extends, forwarding to the harness's instance. */
const GUEST_FORWARDER = `export class NimbusProcess {
  constructor(ctx) { this.guest = ctx.guest; }
  startProcess(args) { return this.guest.startProcess(args); }
  handleHttpRequest(request) { return this.guest.handleHttpRequest(request); }
  fetch(request) { return this.guest.fetch(request); }
}`;
/** The generated adapter class for `capability`, over GUEST_FORWARDER. */
async function adapterFor(capability) {
  const config = observeResidentConfig({ compatibilityDate: '2026-09-26', mainModule: 'guest.js', modules: { 'guest.js': GUEST_FORWARDER } }, capability);
  return (await importModuleSet(config.modules, config.mainModule)).NimbusProcess;
}

/**
 * @param {(config: unknown, info: { loaderId: string, facetName: string, className: string })
 *          => unknown} evaluate
 *   Stands in for the program: called once per module evaluation, returns the
 *   object whose `startProcess` / `handleHttpRequest` the facet stub exposes.
 * @param {{ resolveConfig?: boolean, evaluatesAdapter?: boolean }} [options]
 *   `resolveConfig: false` leaves the module map unbuilt — for tests whose
 *   subject is routing or readiness rather than what the map contains, so they
 *   need not stand up the artifact the assembler fetches.
 *   `evaluatesAdapter: true` says `evaluate` returns the generated host
 *   adapter itself (observeResidentConfig's entry), which answers watches and
 *   admits requests; otherwise the stub models that adapter around a guest.
 */
/**
 * `close`, once the test file has finished: its top level and every await of
 * it. A dynamic import of the entry module settles exactly then, and runs
 * nothing again. A test that leaves a resident running would otherwise sit
 * until that resident's timers fire (the uptime proof's 120 s).
 */
export const atTestEnd = (() => {
  const closes = [];
  return (close) => {
    if (closes.push(close) > 1 || process.argv[1] === undefined) return;
    const run = () => { for (const each of closes.splice(0)) each(); };
    import(pathToFileURL(resolvePath(process.argv[1])).href).then(run, run);
  };
})();

/**
 * A resident's runner as the real one keeps its start (process-fabric's
 * StartContract): an attached TTY's run holds its start call open for its
 * process's life, failing as its facet is aborted (a kill), as the platform
 * fails a dead facet's open calls; any other run answers once it is up. The
 * process table says which (`processes`), as the runner's own args do. A
 * runner that returned a lifetime start at once ended its residency ~20 ms
 * after its boot, and a test of that residency passed only by timing.
 * Every request is answered by `respond`. Every process it started that is
 * still running when the test ends is killed (atTestEnd), as a session's
 * teardown ends its residents.
 */
/**
 * @param {{ get(pid: number): { state?: string, attachedTty?: boolean } | undefined, kill(pid: number): void }} processes
 * @param {(request: Request) => Response | Promise<Response>} [respond]
 */
export function residentRunner(processes, respond = () => new Response('ok')) {
  const started = new Set();
  atTestEnd(() => {
    for (const pid of started) if (processes.get(pid)?.state === 'running') processes.kill(pid);
  });
  return (_config, { died }) => ({
    async startProcess(args) {
      if (typeof args?.pid === 'number') started.add(args.pid);
      if (processes.get(args?.pid)?.attachedTty === true) await died;
      return { ok: true };
    },
    async handleHttpRequest(request) { return respond(request); },
  });
}

export function createFacetWorld(evaluate, { resolveConfig = true, evaluatesAdapter = false } = {}) {
  /** One entry per module evaluation — the ledger a ghost boot lands in. */
  const boots = [];
  const bootSpecs = [];
  /** loaderId → the resolved loader config (the module map that was built). */
  const configs = new Map();
  /** facetName → the live instance, or a promise for it while it starts. */
  const live = new Map();
  /** facetName → its death: rejected as it is aborted or deleted, as the platform fails a dead facet's open calls. */
  const deaths = new Map();
  const deathOf = (name) => {
    let death = deaths.get(name);
    if (death === undefined) {
      death = Promise.withResolvers();
      death.promise.catch(() => {});
      deaths.set(name, death);
    }
    return death;
  };
  const kill = (name, error) => {
    deaths.get(name)?.reject(error);
    deaths.delete(name);
  };

  const loader = {
    // The one unkeyed load: the journal reader a released resident's store
    // is opened with (process-fs-journal-reader.ts), over that facet's store.
    load(code) {
      if (!code?.modules?.['reader.js']) throw new Error('a resident process is never loaded through LOADER.load');
      return {
        getDurableObjectClass: (className) => ({
          className,
          async instantiate(facetName) {
            const journal = sqlJournal(createProcessFacetCtx(facetName).storage.sql);
            return {
              numberings: () => journal.numberings(),
              number: (numbering) => journal.number(numbering),
              readAfter: (after, maxBytes) => journal.readAfter(after, maxBytes),
              dropThrough: (jid) => journal.dropThrough(jid),
            };
          },
        }),
      };
    },
    get(loaderId, config) {
      return {
        getDurableObjectClass(className) {
          return {
            className,
            async instantiate(facetName) {
              if (resolveConfig && !configs.has(loaderId)) configs.set(loaderId, await config());
              const resolved = configs.get(loaderId);
              const instance = await evaluate(resolved, { loaderId, facetName, className, died: deathOf(facetName).promise });
              boots.push({ loaderId, facetName, className, config: resolved, instance });
              return instance;
            },
          };
        },
      };
    },
  };

  /** facetName → the class its start returned, which the platform can instantiate again. */
  const classes = new Map();
  const ensure = (name, start) => {
    let instance = live.get(name);
    if (!instance) {
      instance = (async () => {
        const started = (await start()).class;
        classes.set(name, started);
        return started.instantiate(name);
      })();
      // A failed start must not be remembered as a live facet.
      instance.catch(() => { if (live.get(name) === instance) live.delete(name); });
      live.set(name, instance);
    }
    return instance;
  };

  // The real generated adapter (observeResidentConfig) around each guest
  // instance, for the capability its host opened it with: the harness models
  // the facet transport, never the receiver.
  const adapters = new Map();
  const receivers = new WeakMap();
  const receiverOf = (instance, capability) => {
    let receiver = receivers.get(instance);
    if (!receiver) {
      let adapter = adapters.get(capability);
      if (!adapter) adapters.set(capability, adapter = adapterFor(capability));
      receivers.set(instance, receiver = adapter.then((Adapter) => new Adapter({ guest: instance }, {})));
    }
    return receiver;
  };
  const watches = new Map();
  const die = (name, error) => {
    for (const controller of watches.get(name) ?? []) controller.error(error);
    watches.delete(name);
  };

  const facets = {
    get(name, start) {
      return {
        async startProcess(args) { return (await ensure(name, start)).startProcess(args); },
        // A resident's one entrypoint (observeResidentConfig): its watch, its
        // upgrades and its HTTP. The call's signal is its request's, as the
        // platform makes a fetch's: cancelling the call aborts it.
        async fetch(request, init) {
          const instance = await ensure(name, start);
          const sent = init?.signal ? new Request(request, { signal: init.signal }) : request;
          if (evaluatesAdapter) return instance.fetch(sent);
          const capability = request.headers.get(HOST_WATCH_HEADER) ?? request.headers.get(HOST_REQUEST_HEADER) ?? undefined;
          const response = await (await receiverOf(instance, capability)).fetch(sent);
          if (!request.headers.has(HOST_WATCH_HEADER) || response.status !== 200 || !response.body) return response;
          // A watch rides a stream the platform can end: its death errors it.
          let active = watches.get(name);
          if (!active) watches.set(name, active = new Set());
          let held;
          const relay = new TransformStream({ start(controller) { held = controller; active.add(controller); } });
          void response.body.pipeTo(relay.writable).catch(() => {}).finally(() => active.delete(held));
          return new Response(relay.readable, { headers: response.headers });
        },
        // The journal reader's (LOADER.load above).
        async numberings() { return (await ensure(name, start)).numberings(); },
        async number(numbering) { return (await ensure(name, start)).number(numbering); },
        async readAfter(after, maxBytes) { return (await ensure(name, start)).readAfter(after, maxBytes); },
        async dropThrough(jid) { return (await ensure(name, start)).dropThrough(jid); },
      };
    },
    // abort ends the process; the store stays. delete is the only call that
    // drops a facet's SQLite — mirroring workerd's split, which is what the
    // durable release relies on.
    // Whoever aborts or deletes a facet ended it, and what held it open
    // hears nothing (a release ignores it; a previous incarnation is gone).
    abort(name) { live.delete(name); die(name, new Error('facet aborted')); kill(name, new Error('facet aborted')); },
    delete(name) { live.delete(name); die(name, new Error('facet deleted')); kill(name, new Error('facet deleted')); resetProcessFacetStorage(name); },
  };

  return {
    boots, bootSpecs,
    configs,
    facets,
    loader,
    /** Facet names currently running. */
    liveFacets: () => [...live.keys()],
    /** Drop a running facet the way a platform reset would, without releasing it. */
    lose: (name) => live.delete(name),
    /** The platform puts a fresh instance of the facet's class in its place, without its host's start: the old one's watches end. */
    replace: (name) => { live.set(name, classes.get(name).instantiate(name)); die(name, new Error('the facet was replaced')); },
    /** The facet dies on its own; every active native observation rejects. */
    die: (name, error = new Error('Worker exceeded memory limit.')) => { live.delete(name); die(name, error); },
  };
}

/**
 * A DurableObjectState with a facet host, for a FacetManager or ProcessFabric.
 *
 * `storage` is the key-value half only — enough for the resident-launch
 * journal, which is the one thing a FacetManager keeps outside its own memory.
 * Pass a `storage` map to share one across instances, which is how an instance
 * reset is modelled: the object is new, the rows it left behind are not.
 *
 * `crashable: true` models the platform's real commit semantics instead of a
 * Map's: a put or delete lands in a PENDING overlay that only `sync()` — the
 * storage layer's durability barrier — promotes to the durable map, because
 * `await put()` resolves before durability and the reset that destroys an
 * instance rolls back everything its turns still had outstanding. `crash()`
 * is that reset, dropping every write sync has not flushed. The instant-commit
 * default is how the resident-launch recovery test stayed green while the
 * production journal it modelled was being destroyed with its writer; an
 * instance a test resets must be crashable, or the test is asserting against
 * storage guarantees the platform does not give.
 *
 * Reads see pending writes in either mode — an instance always reads its own
 * (do-storage.mjs).
 */
export function createFacetCtx(world, doId = 'do-test', storage = new Map(), { crashable = false } = {}) {
  const waited = [];
  return {
    id: { toString: () => doId },
    facets: world.facets,
    waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})); },
    waited,
    storage: memoryStorage({ rows: storage, crashable }),
  };
}

// ── Substrates ──────────────────────────────────────────────────────────────
//
// A `ProcessHost` of either kind, over the SAME facet world, so one suite can
// be run twice and the two substrates compared assertion for assertion. The
// peer arm is not a mock of the peer leg: each sibling serves the real
// `_rpcHostProcess` / `_rpcAwaitHostedBoot` /
// `_rpcRouteHostedHttp` / `_rpcCancelHostProcess` legs and the upgrade hop
// from its own PeerHost, behind a fake `NIMBUS_SESSION` namespace, so what is
// under test on that arm is the shipped code.

import {
  _rpcAbandonHostedHttp,
  _rpcAwaitHostedBoot,
  _rpcCancelHostProcess,
  _rpcHostProcess,
  _rpcRouteHostedHttp,
  peerHostFor,
} from '../../../packages/worker/src/session/rpc.ts';
import { isolateToken, isHostedWatch, isHostedResidency } from '../../../packages/fabric/src/peer-host.ts';
import { processHostFor } from '../../../packages/worker/src/loaders/process-host.ts';
import { composeFabric, DEFAULT_HOST_NAMESPACE, hostNamespace } from '../../../packages/fabric/src/composition.ts';
import { openSupervisorDeliveries } from '../../../packages/core/src/workspace/supervisor-delivery.ts';
import { sqlJournal } from '../../../packages/core/src/_shared/process-fs-journal.ts';
import { missingAssets } from './staged-assets.mjs';

// The harness plays the embedder: its ctx.exports (createCtxExports below)
// answer to the name the real worker registers for its supervisor class. A
// test that composed its own host namespace before importing the harness
// (host-namespace-routing) keeps it.
const composedNamespace = hostNamespace();
composeFabric({ supervisorEntrypoint: 'SupervisorRPC', ...(composedNamespace === DEFAULT_HOST_NAMESPACE ? {} : { hostNamespace: composedNamespace }) });

/** Observe the real host's public boot boundary without retaining generated source. */
export function captureProcessBoots(world) {
  /** @type {typeof processHostFor} */
  const capture = (ctx, env, disk, network, supervise) => {
    const host = processHostFor(ctx, env, disk, network, supervise);
    const open = host.open.bind(host);
    host.open = (params) => { world.bootSpecs.push(params.boot); return open(params); };
    return host;
  };
  return capture;
}

/** The two settings of NIMBUS_PROCESS_HOST, for suites that run under both. */
export const PROCESS_HOST_MODES = ['facet', 'peer'];

/**
 * A `ProcessHost` for `mode`, hosting `world`'s facets.
 *
 * `env` is the hosting DO's bindings — on the peer arm they are the PEER's,
 * which is the point: a coordinator with no loader at all still runs processes
 * when its peers have one.
 *
 * `colocated: true` makes every fake peer report the COORDINATOR's isolate,
 * which is the single-process topology placement has to fall back through.
 *
 * `deliveries: true` makes the coordinator a host that applies its processes'
 * mutations exactly once (it opens its delivery store, as NimbusSession
 * does); the host then reports that instance's `hostIncarnation`.
 *
 * `hostBinding` names the peers' namespace in the hosts' env, as an embedder
 * that composes its own (composeFabric({ hostNamespace })) names it.
 *
 * @param {'facet' | 'peer'} mode
 * @param {ReturnType<typeof createFacetWorld>} world
 * @param {ReturnType<Parameters<typeof processHostFor>[2]>} disk
 * @param {{ env?: object, coordDoId?: string, colocated?: boolean, peerWithoutFacets?: boolean, deliveries?: boolean, hostBinding?: string }} [options]
 */
export function createProcessHost(mode, world, disk, {
  env, coordDoId = 'coord-do-id', colocated = false, peerWithoutFacets = false, deliveries = false, hostBinding = 'NIMBUS_SESSION',
} = {}) {
  const hostEnv = env ?? {
    LOADER: world.loader,
    ASSETS: missingAssets,
  };
  const coordinator = createFacetCtx(world, coordDoId);
  const hostIncarnation = deliveries ? openSupervisorDeliveries(coordinator).incarnation : undefined;
  if (mode === 'facet') return Object.assign(processHostFor(coordinator, hostEnv, () => disk), { hostIncarnation });
  const { ns, peers, calls, stubs } = createPeerNamespace(world, hostEnv, { colocated, peerWithoutFacets, hostBinding });
  const host = processHostFor(
    coordinator,
    { [hostBinding]: ns, NIMBUS_PROCESS_HOST: 'peer' },
    () => disk,
  );
  return Object.assign(host, {
    peers,
    acquireActivity: () => hostActivity(coordinator).acquire(),
    namesResolved: calls,
    stubs,
    hostIncarnation,
  });
}

/**
 * A fake `NIMBUS_SESSION` namespace whose sibling sessions host processes
 * through the REAL `_rpc*` host legs, over `world`'s facets. `peers` maps each
 * sibling's name to its state; `peer.die(error)` ends active watches and calls.
 *
 * `colocated: true` makes every peer report the COORDINATOR's isolate;
 * `peerWithoutFacets: true` gives each peer no `ctx.facets`. Each peer's storage records the alarm it arms
 * (`ctx.storage.alarmAt`). `onPeer(peer)` sees each peer as it is made.
 * Each peer finds the namespace in its env as `hostBinding`.
 *
 * @param {ReturnType<typeof createFacetWorld>} world
 * @param {object} hostEnv
 * @param {{ colocated?: boolean, peerWithoutFacets?: boolean, onPeer?: (peer: object) => void, hostBinding?: string }} [options]
 */
export function createPeerNamespace(world, hostEnv, { colocated = false, peerWithoutFacets = false, onPeer, hostBinding = 'NIMBUS_SESSION' } = {}) {
  const calls = [];
  const stubs = [];
  /** Each request a coordinator routed to a peer, and the ones it abandoned, by id. */
  const routed = [], abandoned = [];
  // Every `ns.get()` for one name reaches one peer, exactly as a DO namespace
  // does; a second stub for the same name must see the same hosted records.
  const peers = new Map();
  const peerFor = (name) => {
    let peer = peers.get(name);
    if (!peer) {
      const ctx = createFacetCtx(world, name);
      // A hosting sibling that cannot host: the failure a peer suffers where a
      // coordinator would have thrown before any handle existed.
      if (peerWithoutFacets) delete ctx.facets;
      ctx.storage.alarmAt = null;
      ctx.storage.setAlarm = async (at) => { ctx.storage.alarmAt = at; };
      peer = {
        ctx,
        env: { ...hostEnv, [hostBinding]: ns },
        // A peer is a DIFFERENT Durable Object, so it reports a different
        // isolate. Modelling that matters: `isolateToken()` is a module
        // singleton, so calling the real probe in-process would make every
        // fake peer look co-located with the coordinator, placement would
        // exhaust its attempts every time, and the production happy path —
        // accepting the first candidate — would never run under test.
        isolateToken: colocated ? isolateToken() : `peer-isolate-${peers.size}`,
      };
      // A reset closes native watches and rejects any bounded call in flight.
      peer.deathSignal = new AbortController();
      peer.death = new Promise((_, reject) => { peer.die = (error) => { peer.deathSignal.abort(error); reject(error); }; });
      peer.death.catch(() => {});
      // A loss while idle is found on the next request, not by a background watch.
      peer.resetBy = null;
      peer.reset = (error) => { peer.resetBy = error; };
      peer.peerHost = peerHostFor(ctx, peer.env);
      onPeer?.(peer);
      peers.set(name, peer);
    }
    return peer;
  };
  const ns = {
    idFromName: (name) => name,
    idFromString: (id) => id,
    get(name) {
      const peer = peerFor(name);
      calls.push(name);
      // Stubs carry a disposer, as RPC stubs do, so a leg that forgets to
      // release one is visible rather than merely invisible.
      stubs.push({ name, disposed: false });
      const record = stubs[stubs.length - 1];
      return {
        [Symbol.dispose]() { record.disposed = true; },
        // The upgrade leg is a service-binding fetch on the peer — route it
        // to the same real handler the production entrypoint calls first.
        async fetch(request) {
          if (peer.resetBy) throw peer.resetBy;
          if (isHostedResidency(request)) return peer.peerHost.reside(new Request(request, { signal: AbortSignal.any([request.signal, peer.deathSignal.signal]) }));
          if (isHostedWatch(request)) return peer.peerHost.watch(new Request(request, { signal: AbortSignal.any([request.signal, peer.deathSignal.signal]) }));
          return peer.peerHost.routeWebSocket(request);
        },
        // The host forwards one envelope op; the arm still exercises the
        // REAL _rpc* implementations — routing just went through
        // supervisorOp first, exactly as the shipped host does.
        supervisorOp(envelope) {
          const { op, args } = envelope;
          if (peer.resetBy && op === 'cancelHostProcess') {
            peer.resetBy = null;
            peer.ctx = createFacetCtx(world, name, peer.ctx.storage.rows);
            peer.peerHost = peerHostFor(peer.ctx, peer.env);
          } else if (peer.resetBy && op !== 'hostProcess') return Promise.reject(peer.resetBy);
          switch (op) {
            case 'processHostProbe': return Promise.resolve({ isolateToken: peer.isolateToken });
            case 'hostProcess': return Promise.race([_rpcHostProcess(peer, args[0], args[1]), peer.death]);
            case 'awaitHostedBoot': return Promise.race([_rpcAwaitHostedBoot(peer, args[0]), peer.death]);
            case 'routeHostedHttp': routed.push(args[1].id); return _rpcRouteHostedHttp(peer, args[0], args[1]);
            case 'abandonHostedHttp': abandoned.push(args[2]); return Promise.resolve(_rpcAbandonHostedHttp(peer, args[0], args[1], args[2]));
            case 'cancelHostProcess': return _rpcCancelHostProcess(peer, args[0]);
            default: return Promise.reject(new Error(`peer stub: unserved op ${op}`));
          }
        },
      };
    },
  };
  return { ns, peers, calls, stubs, routed, abandoned };
}

/**
 * `ctx.exports` for a suite that runs on both substrates. `SupervisorRPC` is
 * both the facet's syscall binding (asserted through `props`) and the ranged
 * file reader a peer completes a by-path boot spec with.
 */
export function createCtxExports(readFile) {
  return {
    SupervisorRPC(options) {
      return {
        props: options.props,
        async stat(path) { return { size: readFile(path).byteLength }; },
        async fsReadRangeUncached(path, offset, length) {
          return readFile(path).subarray(offset, offset + length);
        },
      };
    },
  };
}

/**
 * workerd's `IdentityTransformStream` under bun. The peer leg re-pipes a
 * response body through one so what crosses the hop is not an object the
 * loaded worker owns; a plain TransformStream is that same identity pipe.
 */
if (!globalThis.IdentityTransformStream) globalThis.IdentityTransformStream = TransformStream;

// ── Process-facet storage ───────────────────────────────────────────────────

import { Database } from 'bun:sqlite';

/** facetName → its SQLite. Storage is keyed by NAME, which is the real rule. */
const facetDatabases = new Map();

/**
 * The `ctx` a resident process's DO class is constructed with.
 *
 * A facet has its OWN SQLite, reachable synchronously — `ctx.storage.sql.exec`
 * returns a cursor rather than a promise — and the resident set is served out
 * of it. A ctx without storage is not a smaller version of a real facet, it is
 * a different thing, and a process body that reads its filesystem cannot run on
 * one.
 *
 * Keyed by facet NAME rather than per instantiation, because that is the
 * property the platform actually has and the one the slot pool depends on:
 * a facet's storage identity is its name, its isolate identity is its loader
 * key. Verified on production workerd — same name plus a new loader key gave a
 * new module scope with all 7,141 rows and 45.7 MB intact. So `world.lose()`
 * and `abort` drop the isolate here and leave the storage, exactly as they do
 * in workerd.
 */
export function createProcessFacetCtx(facetName) {
  let db = facetDatabases.get(facetName);
  if (!db) {
    db = new Database(':memory:');
    facetDatabases.set(facetName, db);
  }
  return {
    waitUntil() {},
    storage: {
      sql: {
        exec(query, ...params) {
          if (/^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE|DROP)/i.test(query)) {
            db.query(query).run(...params);
            return [];
          }
          return db.query(query).all(...params);
        },
        get databaseSize() { return 0; },
      },
    },
  };
}

/** Drop a facet's storage — slot handover, or test isolation. */
export function resetProcessFacetStorage(facetName) {
  if (facetName === undefined) facetDatabases.clear();
  else facetDatabases.delete(facetName);
}
