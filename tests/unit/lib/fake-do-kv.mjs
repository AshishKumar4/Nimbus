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
 *
 * `bytes` is what the rows take (each key's UTF-8 and its value serialized),
 * the share of the database's size they are on the platform. `meter`, when
 * given, counts each read call (`reads`) and the bytes of file content the
 * reads hand back (`contentBytes`: the store's chunk and page rows, tags C
 * and P in kv-tables.ts).
 */
import { serialize } from 'bun:jsc';

const utf8 = new TextEncoder();
const utf8Order = (a, b) => {
  const x = utf8.encode(a), y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};
const sizeOf = (key, value) => utf8.encode(key).byteLength + serialize(value).byteLength;

/** @param {{ meter?: { reads: number, contentBytes: number } }} [options] */
export function fakeDoKv({ meter } = {}) {
  const rows = new Map();
  const sizes = new Map();
  let sorted = null;
  const keys = () => (sorted ??= [...rows.keys()].sort(utf8Order));
  const read = (key, value) => {
    if (meter && (key[0] === 'C' || key[0] === 'P') && (typeof value === 'string' || value instanceof Uint8Array)) {
      meter.contentBytes += typeof value === 'string' ? value.length : value.byteLength;
    }
    return structuredClone(value);
  };
  const storage = {
    writes: 0,
    bytes: 0,
    put(key, value, options) {
      if (options?.allowUnconfirmed !== true) throw new Error('fake: the store writes unconfirmed');
      if (!rows.has(key)) sorted = null;
      rows.set(key, structuredClone(value));
      storage.bytes += sizeOf(key, value) - (sizes.get(key) ?? 0);
      sizes.set(key, sizeOf(key, value));
      storage.writes++;
    },
    delete(key, options) {
      if (options?.allowUnconfirmed !== true) throw new Error('fake: the store writes unconfirmed');
      const list = Array.isArray(key) ? key : [key];
      if (list.length > 128) throw new Error('fake: at most 128 keys a delete');
      let any = false;
      for (const k of list) {
        if (!rows.delete(k)) continue;
        any = true;
        storage.bytes -= sizes.get(k);
        sizes.delete(k);
      }
      if (any) sorted = null;
      storage.writes++;
    },
    kv: {
      get(key) {
        if (meter) meter.reads++;
        return rows.has(key) ? read(key, rows.get(key)) : undefined;
      },
      /** @param {{ start?: string, end?: string, prefix?: string, reverse?: boolean, limit?: number }} [options] */
      *list(options = {}) {
        if (meter) meter.reads++;
        const { start, end, prefix, reverse = false, limit = Infinity } = options;
        const all = keys().filter((key) => (prefix === undefined || key.startsWith(prefix))
          && (start === undefined || utf8Order(key, start) >= 0)
          && (end === undefined || utf8Order(key, end) < 0));
        if (reverse) all.reverse();
        let n = 0;
        for (const key of all) {
          if (n++ >= limit) return;
          if (rows.has(key)) yield [key, read(key, rows.get(key))];
        }
      },
    },
    sql: { get databaseSize() { return storage.bytes; } },
  };
  return storage;
}

const storages = new WeakMap();

/**
 * A process facet's `ctx.storage`: its key-value storage (fakeDoKv) and its
 * SQL (`sql`, a facetSql-shaped shim: the write journal's) over one database,
 * as on the platform, whose `databaseSize` is what both hold. One a SQL: a
 * store bound again over the same facet (a restart) finds the rows it left.
 * @param {any} sql
 * @param {{ meter?: { reads: number, contentBytes: number } }} [options]
 */
export function facetStorage(sql, options = {}) {
  const kept = storages.get(sql);
  if (kept) return kept;
  const storage = fakeDoKv(options);
  const pages = () => {
    for (const row of sql.exec('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()')) return Number(row.n);
    return 0;
  };
  const shared = new Proxy(sql, {
    get: (target, name) => (name === 'databaseSize' ? pages() + storage.bytes : Reflect.get(target, name)),
  });
  storages.set(sql, Object.assign(storage, { sql: shared }));
  return storage;
}
