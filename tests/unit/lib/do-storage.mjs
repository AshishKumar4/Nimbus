// A Durable Object's key-value storage, in memory, as the platform behaves:
// values are structured clones, list is in key order, a multi-key put lands
// whole, and transaction runs one body at a time on its own view.
//
// `rows` is the durable map: pass one to share it across instances, which
// is how an instance reset is modelled (the object is new, the rows it left
// behind are not). `crashable` models commit: a write is pending until
// sync() (the durability barrier) or flush() (the background flush, at any
// time) makes it durable, reads see pending writes, and crash() (the reset)
// drops them. Without it every write is durable at once.
export function memoryStorage({ rows = new Map(), crashable = false } = {}) {
  /** key → { deleted: boolean, value? }: writes awaiting durability. */
  const pending = new Map();
  let transactions = Promise.resolve();
  const flush = () => {
    for (const [key, write] of pending) {
      if (write.deleted) rows.delete(key);
      else rows.set(key, write.value);
    }
    pending.clear();
  };
  const view = () => {
    const merged = new Map(rows);
    for (const [key, write] of pending) {
      if (write.deleted) merged.delete(key);
      else merged.set(key, write.value);
    }
    return merged;
  };
  const listed = (map, prefix) => new Map([...map]
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => [key, structuredClone(value)]));
  const commit = (writes) => {
    for (const [key, write] of writes) pending.set(key, write);
    if (!crashable) flush();
  };
  return {
    rows,
    async get(key) { return structuredClone(view().get(key)); },
    // Both of DO storage's forms.
    async put(keyOrEntries, value) {
      const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries;
      commit(Object.entries(entries).map(([key, entry]) => [key, { deleted: false, value: structuredClone(entry) }]));
    },
    async delete(key) {
      const had = view().has(key);
      commit([[key, { deleted: true }]]);
      return had;
    },
    async list({ prefix = '' } = {}) { return listed(view(), prefix); },
    async sync() { flush(); },
    flush,
    crash() { pending.clear(); },
    /**
     * One serialized read/write unit: one body runs at a time on a private
     * copy, and on success only the keys it touched are written. A rejection
     * frees the queue and writes nothing.
     */
    transaction(body) {
      const run = transactions.then(() => {
        const copy = view();
        const touched = new Map();
        const txn = {
          get: async (key) => structuredClone(copy.get(key)),
          put: async (key, value) => {
            const stored = structuredClone(value);
            copy.set(key, stored);
            touched.set(key, { deleted: false, value: stored });
          },
          delete: async (key) => { copy.delete(key); touched.set(key, { deleted: true }); },
          list: async ({ prefix = '' } = {}) => listed(copy, prefix),
        };
        return Promise.resolve(body(txn)).then((out) => {
          commit(touched);
          return out;
        });
      });
      transactions = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
