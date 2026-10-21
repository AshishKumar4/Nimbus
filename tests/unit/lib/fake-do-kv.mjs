/**
 * A SQLite-backed Durable Object's key-value storage as the resident store
 * uses it (kv-tables.ts ResidentKv): `put` and `delete` (unconfirmed, applied
 * at once, as a turn's own reads see them), the synchronous `kv.get` and
 * `kv.list`. Values cross as the platform's do, by structured clone; keys are
 * ordered by their UTF-8 bytes. What it models was measured on the platform
 * (file-engine-d4-measurements.md, "what sync reads see"): kv.get and
 * kv.list (prefix, start/end, reverse with limit) see unconfirmed puts,
 * overwrites and deletes made earlier in the same turn and after a yield, and
 * a key deleted and put again in one turn reads and lists as the last put.
 * A key holding NUL is refused: the platform does not keep one intact.
 */
const utf8Order = (a, b) => {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};

export function fakeDoKv() {
  const rows = new Map();
  let sorted = null;
  const keys = () => (sorted ??= [...rows.keys()].sort(utf8Order));
  const storage = {
    writes: 0,
    put(key, value, options) {
      if (options?.allowUnconfirmed !== true) throw new Error('fake: the store writes unconfirmed');
      if (key.includes('\u0000')) throw new Error('fake: a key holding NUL is not kept intact by the platform');
      if (!rows.has(key)) sorted = null;
      rows.set(key, structuredClone(value));
      storage.writes++;
    },
    delete(key, options) {
      if (options?.allowUnconfirmed !== true) throw new Error('fake: the store writes unconfirmed');
      const list = Array.isArray(key) ? key : [key];
      if (list.length > 128) throw new Error('fake: at most 128 keys a delete');
      let any = false;
      for (const k of list) if (rows.delete(k)) any = true;
      if (any) sorted = null;
      storage.writes++;
    },
    kv: {
      get(key) { return rows.has(key) ? structuredClone(rows.get(key)) : undefined; },
      /** @param {{ start?: string, end?: string, prefix?: string, reverse?: boolean, limit?: number }} [options] */
      *list(options = {}) {
        const { start, end, prefix, reverse = false, limit = Infinity } = options;
        const all = keys().filter((key) => (prefix === undefined || key.startsWith(prefix))
          && (start === undefined || utf8Order(key, start) >= 0)
          && (end === undefined || utf8Order(key, end) < 0));
        if (reverse) all.reverse();
        let n = 0;
        for (const key of all) {
          if (n++ >= limit) return;
          if (rows.has(key)) yield [key, structuredClone(rows.get(key))];
        }
      },
    },
    sql: { databaseSize: 0 },
  };
  return storage;
}
