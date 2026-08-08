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

/**
 * @param {(config: unknown, info: { loaderId: string, facetName: string, className: string })
 *          => unknown} evaluate
 *   Stands in for the program: called once per module evaluation, returns the
 *   object whose `startProcess` / `handleHttpRequest` the facet stub exposes.
 * @param {{ resolveConfig?: boolean }} [options]
 *   `resolveConfig: false` leaves the module map unbuilt — for tests whose
 *   subject is routing or readiness rather than what the map contains, so they
 *   need not stand up the artifact the assembler fetches.
 */
export function createFacetWorld(evaluate, { resolveConfig = true } = {}) {
  /** One entry per module evaluation — the ledger a ghost boot lands in. */
  const boots = [];
  /** loaderId → the resolved loader config (the module map that was built). */
  const configs = new Map();
  /** facetName → the live instance, or a promise for it while it starts. */
  const live = new Map();

  const loader = {
    load() {
      throw new Error('a resident process is never loaded through LOADER.load');
    },
    get(loaderId, config) {
      return {
        getDurableObjectClass(className) {
          return {
            className,
            async instantiate(facetName) {
              if (resolveConfig && !configs.has(loaderId)) configs.set(loaderId, await config());
              const resolved = configs.get(loaderId);
              const instance = await evaluate(resolved, { loaderId, facetName, className });
              boots.push({ loaderId, facetName, className, config: resolved, instance });
              return instance;
            },
          };
        },
      };
    },
  };

  const ensure = (name, start) => {
    let instance = live.get(name);
    if (!instance) {
      instance = (async () => (await start()).class.instantiate(name))();
      // A failed start must not be remembered as a live facet.
      instance.catch(() => { if (live.get(name) === instance) live.delete(name); });
      live.set(name, instance);
    }
    return instance;
  };

  const facets = {
    get(name, start) {
      return {
        async startProcess(args) { return (await ensure(name, start)).startProcess(args); },
        async handleHttpRequest(request) { return (await ensure(name, start)).handleHttpRequest(request); },
      };
    },
    abort(name) { live.delete(name); },
    delete(name) { live.delete(name); },
  };

  return {
    boots,
    configs,
    facets,
    loader,
    /** Facet names currently running. */
    liveFacets: () => [...live.keys()],
    /** Drop a running facet the way a platform reset would, without releasing it. */
    lose: (name) => live.delete(name),
  };
}

/** A DurableObjectState with a facet host, for a FacetManager or ProcessFabric. */
export function createFacetCtx(world, doId = 'do-test') {
  const waited = [];
  return {
    id: { toString: () => doId },
    facets: world.facets,
    waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})); },
    waited,
  };
}

// ── Substrates ──────────────────────────────────────────────────────────────
//
// A `ProcessHost` of either kind, over the SAME facet world, so one suite can
// be run twice and the two substrates compared assertion for assertion. The
// peer arm is not a mock of the peer leg: it wires the real `_rpcHostProcess`
// / `_rpcAwaitHostedOpen` / `_rpcAwaitHostedBoot` / `_rpcRouteHostedHttp` /
// `_rpcCancelHostProcess` behind a fake `NIMBUS_SESSION` namespace, so what is
// under test on that arm is the shipped code.

import {
  _rpcAwaitHostedBoot,
  _rpcAwaitHostedOpen,
  _rpcCancelHostProcess,
  _rpcHostProcess,
  _rpcRouteHostedHttp,
} from '../../packages/worker/src/session/rpc.ts';
import { isolateToken, processHostFor } from '../../packages/worker/src/loaders/process-host.ts';

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
 */
export function createProcessHost(mode, world, disk, {
  env, coordDoId = 'coord-do-id', colocated = false, peerWithoutFacets = false,
} = {}) {
  const calls = [];
  const stubs = [];
  const hostEnv = env ?? {
    LOADER: world.loader,
    ASSETS: { async fetch() { return new Response('', { status: 404 }); } },
  };
  if (mode === 'facet') {
    return processHostFor(createFacetCtx(world, coordDoId), hostEnv, () => disk);
  }
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
      peer = {
        ctx,
        env: hostEnv,
        _hostedProcesses: new Map(),
        _hostedProcessWaiters: new Map(),
        // A peer is a DIFFERENT Durable Object, so it reports a different
        // isolate. Modelling that matters: `isolateToken()` is a module
        // singleton, so calling the real probe in-process would make every
        // fake peer look co-located with the coordinator, placement would
        // exhaust its attempts every time, and the production happy path —
        // accepting the first candidate — would never run under test.
        isolateToken: colocated ? isolateToken() : `peer-isolate-${peers.size}`,
      };
      // The held host leg is the peer's life. `die()` severs it exactly as a
      // Durable Object reset severs an inbound call.
      peer.death = new Promise((_, reject) => { peer.die = reject; });
      peer.death.catch(() => {});
      peers.set(name, peer);
    }
    return peer;
  };
  const ns = {
    idFromName: (name) => name,
    get(name) {
      const peer = peerFor(name);
      calls.push(name);
      // Stubs carry a disposer, as RPC stubs do, so a leg that forgets to
      // release one is visible rather than merely invisible.
      stubs.push({ name, disposed: false });
      const record = stubs[stubs.length - 1];
      return {
        [Symbol.dispose]() { record.disposed = true; },
        _rpcProcessHostProbe: () => Promise.resolve({ isolateToken: peer.isolateToken }),
        _rpcHostProcess: (boot, opts) => Promise.race([_rpcHostProcess(peer, boot, opts), peer.death]),
        _rpcAwaitHostedOpen: (key) => _rpcAwaitHostedOpen(peer, key),
        _rpcAwaitHostedBoot: (key) => _rpcAwaitHostedBoot(peer, key),
        _rpcRouteHostedHttp: (key, wire) => _rpcRouteHostedHttp(peer, key, wire),
        _rpcCancelHostProcess: (key) => _rpcCancelHostProcess(peer, key),
      };
    },
  };
  const host = processHostFor(
    createFacetCtx(world, coordDoId),
    { NIMBUS_SESSION: ns, NIMBUS_PROCESS_HOST: 'peer' },
    () => disk,
  );
  host.peers = peers;
  host.namesResolved = calls;
  host.stubs = stubs;
  return host;
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
