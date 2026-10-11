// The loader/named-facet boundary shared by engine harnesses. Engine code and
// its memory, delivery and cancellation instrumentation stay with the caller.
/**
 * @param {{classFor: (id: string) => any, id: string, loadDelayMs?: number, brokenStubs?: number,
 * invoke?: (name: string, method: string, args: any[], instance: Promise<any>) => Promise<any>, onAbort?: (name: string, reason: any) => void}} options
 */
export function namedFacetPlatform({ classFor, id, loadDelayMs = 0, brokenStubs = 0, invoke, onAbort }) {
  const counts = { loaderGets: 0, facetInstances: 0, stubs: 0, loaderIds: [], facetNames: [], aborted: [] };
  const instances = new Map();
  const call = invoke ?? (async (_name, method, args, instance) => {
    const target = await instance;
    return structuredClone(await target[method](...structuredClone(args)));
  });
  const ctx = {
    id: { toString: () => id },
    facets: {
      abort(name, reason) {
        counts.aborted.push(name);
        instances.delete(name);
        onAbort?.(name, reason);
      },
      get(name, load) {
        if (!instances.has(name)) {
          counts.facetNames.push(name);
          instances.set(name, load().then(({ class: FacetClass }) => {
            counts.facetInstances++;
            return new FacetClass({}, {});
          }));
        }
        const instance = instances.get(name);
        const stub = ++counts.stubs;
        return new Proxy({}, {
          get(_target, method) {
            if (method === 'then' || typeof method !== 'string') return undefined;
            return (...args) => stub <= brokenStubs
              ? Promise.reject(new Error(`stub ${stub} disconnected`)) : call(name, method, args, instance);
          },
        });
      },
    },
  };
  const env = {
    ASSETS: { async fetch() { throw new Error('the worker is handed out by LOADER.get below'); } },
    LOADER: {
      async get(workerId) {
        counts.loaderGets++;
        counts.loaderIds.push(workerId);
        if (loadDelayMs) await new Promise(resolve => setTimeout(resolve, loadDelayMs));
        const FacetClass = await classFor(workerId);
        return { getDurableObjectClass: () => FacetClass };
      },
    },
  };
  return { ctx, env, counts };
}
