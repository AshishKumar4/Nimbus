// caches.default as workerd has it, for a test of the colo tier: one colo's
// Request-keyed responses, installed as globalThis.caches for the length of
// a callback and removed after it.

/** One colo's cache: `entries` maps a key's URL to the stored body and headers. */
export function fakeColoCache() {
  const entries = new Map();
  return {
    entries,
    async match(request) {
      const entry = entries.get(request.url);
      return entry ? new Response(entry.body, { headers: entry.headers }) : undefined;
    },
    async put(request, response) {
      entries.set(request.url, { body: new Uint8Array(await response.arrayBuffer()), headers: Object.fromEntries(response.headers) });
    },
  };
}

/** Run `use(colo)` with a fresh colo cache as caches.default. */
export async function withColoCache(use) {
  const had = Object.hasOwn(globalThis, 'caches');
  const original = globalThis.caches;
  const colo = fakeColoCache();
  globalThis.caches = { default: colo };
  try {
    return await use(colo);
  } finally {
    if (had) globalThis.caches = original;
    else delete globalThis.caches;
  }
}
