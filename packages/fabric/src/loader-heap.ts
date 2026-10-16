/**
 * What the Worker Loader shim (bindings.ts NimbusLoaderRPC) holds in its
 * isolate, bounded (FAB-2; loader-code-store-design-r7.md):
 *
 *   - entries: each loaded Worker's code but its modules (env, metadata,
 *     limits), charged in full and refused over LOADER_ENTRY_CACHE_BYTES;
 *   - modules: each module's content, a cache that may evict it;
 *   - code credit: an admission's whole live input, and a native miss's
 *     assembly, from before it waits or does I/O until it returns. A `load`
 *     takes it now or is refused (its argument has already arrived); a
 *     `get` waits for it holding only its key;
 *   - key allowance: the keys and arguments of `get` calls in flight.
 *
 * Charges are conservative V8 sizes, by a walk that copies nothing and
 * charges a shared object once; a value it cannot account for is refused.
 * Every refusal names its limit and the value that passed it.
 */
import { BYTE_LRU_ENTRY_OVERHEAD, ByteLru } from '@nimbus-sh/core/_shared/lru-map.js';
import { WeightedCreditPool, type ResizableCreditLease } from '@nimbus-sh/platform/weighted-credit-pool.js';
import type { ModuleContent, WorkerCode } from '@nimbus-sh/platform/worker-code.js';
import {
  DYNAMIC_WORKER_CODE_LIMIT_BYTES,
  LOADER_CODE_CREDIT_BYTES,
  LOADER_ENTRY_CACHE_BYTES,
  LOADER_GET_ID_MAX_CHARS,
  LOADER_KEY_ALLOWANCE_BYTES,
  LOADER_MODULE_CACHE_BYTES,
} from './budgets.js';

const OBJECT = 64;
const SLOT = 16;
const COLLECTION_ENTRY = 32;
const STRING = 16;
const ARRAY_ELEMENT = 8;
/** How long a `get` or a native miss waits for code credit before it is refused. */
const CREDIT_WAIT_MS = 30_000;

/** A load or get the shim refuses: its message names the limit and the value. */
export class LoaderRefusal extends Error {
  override readonly name = 'LoaderRefusal';
}

const bytes = (n: number): string => `${n.toLocaleString('en-US')} bytes`;

function stringCharge(text: string): number {
  return STRING + 2 * text.length;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Everything `root` holds live, charged once per object, or Infinity once
 * the charge passes `limit` (the walk stops there). Throws LoaderRefusal for
 * a compiled WebAssembly.Module or a value it cannot account for, `at` naming
 * where.
 */
export function liveCharge(root: unknown, limit: number, at: string): number {
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; path: string }> = [{ value: root, path: at }];
  let total = 0;
  const add = (n: number): boolean => {
    total += n;
    return total > limit;
  };
  const property = (owner: object, key: string, path: string): boolean => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (add(SLOT + stringCharge(key))) return true;
    if (descriptor && 'value' in descriptor) stack.push({ value: descriptor.value, path: `${path}.${key}` });
    return false;
  };
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value, path } = item;
    switch (typeof value) {
      case 'string':
        if (add(stringCharge(value))) return Infinity;
        continue;
      case 'number': case 'boolean': case 'undefined':
        continue;
      case 'bigint':
        if (add(STRING + Math.ceil(value.toString(16).length / 2))) return Infinity;
        continue;
      case 'function':
        // A capability (an RPC stub, a service binding): charged as one, never walked.
        if (add(OBJECT)) return Infinity;
        continue;
      case 'symbol':
        throw new LoaderRefusal(`Nimbus Worker Loader: ${path} is a symbol, which the shim cannot account for`);
    }
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof WebAssembly.Module) {
      throw new LoaderRefusal(`Nimbus Worker Loader: ${path} is a compiled WebAssembly.Module, which cannot cross to the loader: pass its bytes ({ wasm: ArrayBuffer })`);
    }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)) {
      if (add(OBJECT + value.byteLength)) return Infinity;
      continue;
    }
    if (ArrayBuffer.isView(value)) {
      if (add(OBJECT)) return Infinity;
      stack.push({ value: value.buffer, path });
      continue;
    }
    if (add(OBJECT)) return Infinity;
    if (Array.isArray(value)) {
      // V8 holds a holey array's backing store at its length.
      if (add(ARRAY_ELEMENT * value.length)) return Infinity;
      for (const key of Object.keys(value)) {
        const index = Number(key);
        if (Number.isInteger(index) && index >= 0 && String(index) === key) {
          if (add(ARRAY_ELEMENT)) return Infinity;
          stack.push({ value: value[index], path: `${path}[${key}]` });
        } else if (property(value, key, path)) return Infinity;
      }
      continue;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        if (add(COLLECTION_ENTRY)) return Infinity;
        stack.push({ value: key, path: `${path}<key>` }, { value: entry, path: `${path}<value>` });
      }
      continue;
    }
    if (value instanceof Set) {
      for (const entry of value) {
        if (add(COLLECTION_ENTRY)) return Infinity;
        stack.push({ value: entry, path: `${path}<entry>` });
      }
      continue;
    }
    if (value instanceof Date) continue;
    if (value instanceof RegExp) {
      if (add(stringCharge(value.source) + stringCharge(value.flags))) return Infinity;
      continue;
    }
    if (value instanceof String || value instanceof Number || value instanceof Boolean || value instanceof BigInt) {
      stack.push({ value: value.valueOf(), path });
      continue;
    }
    if (value instanceof Error) {
      if (!Object.hasOwn(value, 'name') && add(stringCharge(value.name))) return Infinity;
      for (const key of Object.getOwnPropertyNames(value)) if (property(value, key, path)) return Infinity;
      continue;
    }
    if (!isPlainObject(value)) continue; // A capability: an RPC stub, a service binding, a stream. Charged as one.
    for (const key of Object.keys(value)) if (property(value, key, path)) return Infinity;
  }
  return total;
}

/**
 * The length of `text` as JSON.stringify writes it, quotes included, counted
 * without building it: a control character or lone surrogate as six (`\u00XX`),
 * `"` and `\` as two. Stops counting past `limit`.
 */
export function jsonStringLength(text: string, limit: number): number {
  let length = 2;
  for (let i = 0; i < text.length && length <= limit; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x20) length += 6;
    else if (unit === 0x22 || unit === 0x5c) length += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { length += 2; i++; } else length += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) length += 6;
    else length += 1;
  }
  return length;
}

/** A loaded Worker, but for its modules: what a native miss re-creates it from. */
interface LoaderEntry {
  readonly byteLength: number;
  readonly code: Omit<WorkerCode, 'modules'>;
  readonly modules: readonly string[];
  /** What a native miss holds of it at its peak: its modules' charges and the entry's own. */
  readonly missPeak: number;
}

/** One module's content, charged. */
interface CachedModule {
  readonly byteLength: number;
  readonly content: ModuleContent;
}

const entries = new ByteLru<string, LoaderEntry>(LOADER_ENTRY_CACHE_BYTES);
const modules = new ByteLru<string, CachedModule>(LOADER_MODULE_CACHE_BYTES);
const codeCredit = new WeightedCreditPool(LOADER_CODE_CREDIT_BYTES);
const keyAllowance = new WeightedCreditPool(LOADER_KEY_ALLOWANCE_BYTES);
let refusals = 0;
let keyRefused = 0;
let nativeMisses = 0;
let evictedMisses = 0;

const moduleKey = (key: string, name: string): string => `${key}\0${name}`;

/** The shim's counters: each bucket on its own, and their sum as a stated upper bound (borrowed buffers counted twice). */
export function loaderHeapStats() {
  const code = codeCredit.stats;
  const key = keyAllowance.stats;
  return {
    entries: entries.size,
    entryCacheMaxBytes: LOADER_ENTRY_CACHE_BYTES,
    moduleCacheMaxBytes: LOADER_MODULE_CACHE_BYTES,
    codeCreditBytes: LOADER_CODE_CREDIT_BYTES,
    keyAllowanceBytes: LOADER_KEY_ALLOWANCE_BYTES,
    entryCacheBytes: entries.byteLength,
    moduleCacheBytes: modules.byteLength,
    codeReserved: code.current,
    codeWaiting: code.queued,
    keyReserved: key.current,
    keyRefused,
    retainedUpperBound: entries.byteLength + modules.byteLength + code.current + key.current,
    refusals,
    nativeMisses,
    evictedMisses,
  };
}

/** One bounded line per event: a key (a LOADER.get id may be 256 Ki units) is named by its first 64. */
function report(event: string, detail: { key?: string; [field: string]: unknown } = {}): void {
  const key = detail.key === undefined ? {} : { key: detail.key.length > 64 ? `${detail.key.slice(0, 64)}…(${detail.key.length})` : detail.key };
  console.log(`[nimbus/loader-shim] ${JSON.stringify({ event, ...detail, ...key, ...loaderHeapStats() })}`);
}

function refuse(event: string, message: string): never {
  refusals++;
  report('refused', { reason: event });
  throw new LoaderRefusal(`Nimbus Worker Loader: ${message}`);
}

/** What an admission holds, priced before it holds credit for it. */
export interface PricedCode {
  readonly code: WorkerCode;
  /** Its whole live input. */
  readonly charge: number;
  readonly entry: LoaderEntry;
  readonly moduleCharges: ReadonlyMap<string, number>;
}

/** Price `code`, admitted under `key` (whose own charge the caller holds): refused by name over any bound. */
export function priceCode(code: WorkerCode, key: string): PricedCode {
  const { modules: moduleMap, ...rest } = code;
  if (moduleMap === null || typeof moduleMap !== 'object') refuse('no-modules', 'the code has no module map');
  const moduleCharges = new Map<string, number>();
  let charge = OBJECT;
  for (const name of Object.keys(moduleMap)) {
    const content = moduleMap[name];
    const moduleCharge = SLOT + stringCharge(name) + liveCharge(content, DYNAMIC_WORKER_CODE_LIMIT_BYTES, `modules[${JSON.stringify(name)}]`);
    moduleCharges.set(name, moduleCharge);
    charge += moduleCharge;
    if (charge > DYNAMIC_WORKER_CODE_LIMIT_BYTES) {
      refuse('worker-bound', `this Worker holds over ${bytes(DYNAMIC_WORKER_CODE_LIMIT_BYTES)} live (the per-Worker bound, DYNAMIC_WORKER_CODE_LIMIT_BYTES), counting through module ${JSON.stringify(name)}`);
    }
  }
  const entryCharge = liveCharge(rest, LOADER_ENTRY_CACHE_BYTES, 'code') + stringCharge(key) + BYTE_LRU_ENTRY_OVERHEAD
    + [...moduleCharges.keys()].reduce((sum, name) => sum + SLOT + stringCharge(name), 0);
  if (entryCharge > LOADER_ENTRY_CACHE_BYTES) {
    refuse('entry-bound', `this Worker's env and metadata charge ${entryCharge === Infinity ? `over ${bytes(LOADER_ENTRY_CACHE_BYTES)}` : bytes(entryCharge)}, over the shim's ${bytes(LOADER_ENTRY_CACHE_BYTES)} entry bound (LOADER_ENTRY_CACHE_BYTES)`);
  }
  const missPeak = [...moduleCharges.values()].reduce((sum, n) => sum + n, entryCharge);
  if (charge + entryCharge > DYNAMIC_WORKER_CODE_LIMIT_BYTES || missPeak > DYNAMIC_WORKER_CODE_LIMIT_BYTES) {
    refuse('worker-bound', `this Worker holds ${bytes(Math.max(charge + entryCharge, missPeak))} live, over the per-Worker bound of ${bytes(DYNAMIC_WORKER_CODE_LIMIT_BYTES)} (DYNAMIC_WORKER_CODE_LIMIT_BYTES)`);
  }
  return { code, charge: charge + entryCharge, entry: { byteLength: entryCharge, code: rest, modules: [...moduleCharges.keys()], missPeak }, moduleCharges };
}

/** Code credit for an argument that has already arrived: granted now, or the call is refused. */
export function admitNow(charge: number): ResizableCreditLease {
  const lease = codeCredit.tryAcquire(Math.max(1, charge));
  if (lease === null) {
    const { current } = codeCredit.stats;
    refuse('busy', `the shim is holding ${bytes(current)} of other Workers' code (bound ${bytes(LOADER_CODE_CREDIT_BYTES)}, LOADER_CODE_CREDIT_BYTES) and this one needs ${bytes(charge)}; retry`);
  }
  return lease;
}

/** Code credit, waited for in turn (holding nothing it charges), or refused after CREDIT_WAIT_MS. */
export async function admitInTurn(charge: number, what: string): Promise<ResizableCreditLease> {
  try {
    return await codeCredit.acquire(Math.max(1, charge), AbortSignal.timeout(CREDIT_WAIT_MS));
  } catch {
    refuse('busy', `${what} waited ${CREDIT_WAIT_MS / 1000} s for ${bytes(charge)} of code credit (bound ${bytes(LOADER_CODE_CREDIT_BYTES)}, LOADER_CODE_CREDIT_BYTES); retry`);
  }
}

/**
 * A `get`'s key, bounded before it is built: each id at most
 * LOADER_GET_ID_MAX_CHARS units, its JSON length counted, its charge granted
 * from the key allowance now or the call refused. Returns the key and the
 * lease the caller releases when the call returns.
 */
export function admitGetKey(namespace: string, networkId: string | null, id: unknown): { key: string; lease: ResizableCreditLease } {
  if (typeof id !== 'string') refuse('get-id', 'a LOADER.get id must be a string');
  const bounded = (name: string, value: string): void => {
    if (value.length > LOADER_GET_ID_MAX_CHARS) {
      refuse('get-id', `a LOADER.get ${name} of ${value.length.toLocaleString('en-US')} UTF-16 units is over the shim's ${LOADER_GET_ID_MAX_CHARS.toLocaleString('en-US')} (LOADER_GET_ID_MAX_CHARS)`);
    }
  };
  bounded('id', id);
  bounded('namespace', namespace);
  if (networkId !== null) bounded('network id', networkId);
  const textId = id;
  const length = 'get:'.length + 2 + jsonStringLength(namespace, LOADER_ENTRY_CACHE_BYTES) + 1
    + (networkId === null ? 4 : jsonStringLength(networkId, LOADER_ENTRY_CACHE_BYTES)) + 1 + jsonStringLength(textId, LOADER_ENTRY_CACHE_BYTES);
  const charge = STRING + 2 * length;
  if (charge > LOADER_ENTRY_CACHE_BYTES) {
    refuse('get-id', `a LOADER.get key of ${length.toLocaleString('en-US')} characters charges over the shim's ${bytes(LOADER_ENTRY_CACHE_BYTES)} entry bound`);
  }
  const lease = keyAllowance.tryAcquire(charge);
  if (lease === null) {
    keyRefused++;
    refuse('key-allowance', `the shim is holding ${bytes(keyAllowance.stats.current)} of other LOADER.get keys (bound ${bytes(LOADER_KEY_ALLOWANCE_BYTES)}, LOADER_KEY_ALLOWANCE_BYTES) and this key needs ${bytes(charge)}; retry`);
  }
  return { key: 'get:' + JSON.stringify([namespace, networkId, textId]), lease };
}

/** Keep an admitted Worker: its entry, and each module the module cache keeps. */
export function keep(key: string, priced: PricedCode): void {
  entries.set(key, priced.entry);
  for (const [name, charge] of priced.moduleCharges) {
    modules.set(moduleKey(key, name), { byteLength: charge, content: priced.code.modules[name] });
  }
  report('admitted', { key, charge: priced.charge });
}

/** Whether `key` names a Worker the shim still has an entry for. */
export function isLoaded(key: string): boolean {
  return entries.get(key) !== undefined;
}

/** The code `key` was admitted with but its modules (its policy's source), or undefined once evicted. */
export function loadedCode(key: string): Omit<WorkerCode, 'modules'> | undefined {
  return entries.get(key)?.code;
}

/**
 * A native miss's code for `key`: credit for its miss peak taken first,
 * holding nothing but the key while it waits; the entry looked up again once
 * it is granted, and every module from the cache. A Worker the shim no longer
 * holds fails by name. The lease is held until `use` returns.
 */
export async function withMissCode<T>(key: string, use: (code: WorkerCode) => T | Promise<T>): Promise<T> {
  nativeMisses++;
  const peak = entries.get(key)?.missPeak;
  if (peak === undefined) {
    evictedMisses++;
    report('evicted', { key });
    throw new LoaderRefusal(`Nimbus: dynamic worker '${key}' is no longer loaded: the shim's cache evicted it`);
  }
  const lease = await admitInTurn(peak, `re-creating dynamic worker '${key}'`);
  try {
    const evicted = (): never => {
      evictedMisses++;
      report('evicted', { key });
      throw new LoaderRefusal(`Nimbus: dynamic worker '${key}' is no longer loaded: the shim's cache evicted it`);
    };
    const entry = entries.get(key) ?? evicted();
    const assembled: Record<string, ModuleContent> = {};
    for (const name of entry.modules) assembled[name] = (modules.get(moduleKey(key, name)) ?? evicted()).content;
    report('native-miss', { key, missPeak: peak });
    return await use({ ...entry.code, modules: assembled });
  } finally {
    lease.release();
  }
}
