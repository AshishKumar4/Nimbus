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
