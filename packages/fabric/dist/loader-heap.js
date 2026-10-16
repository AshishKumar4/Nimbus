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
import { WeightedCreditPool } from '@nimbus-sh/platform/weighted-credit-pool.js';
import { loaderStore, restoredModule, STORE_READ_BYTES } from './loader-store-client.js';
import { DYNAMIC_WORKER_CODE_LIMIT_BYTES, LOADER_CODE_CREDIT_BYTES, LOADER_WORKER_BYTES, LOADER_ENTRY_CACHE_BYTES, LOADER_GET_ID_MAX_CHARS, LOADER_KEY_ALLOWANCE_BYTES, LOADER_MODULE_CACHE_BYTES, } from './budgets.js';
const OBJECT = 64;
const SLOT = 16;
const COLLECTION_ENTRY = 32;
const STRING = 16;
const ARRAY_ELEMENT = 8;
/** How long a `get` or a native miss waits for code credit before it is refused. */
const CREDIT_WAIT_MS = 30_000;
/** A load or get the shim refuses: its message names the limit and the value. */
export class LoaderRefusal extends Error {
    name = 'LoaderRefusal';
}
const bytes = (n) => `${n.toLocaleString('en-US')} bytes`;
function stringCharge(text) {
    return STRING + 2 * text.length;
}
/** Whether `key` is an array index (its charge is the array's backing store). */
function isIndex(key) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}
/**
 * Everything `root` holds live, charged once per object (`seen` shared
 * across calls), or Infinity once the charge passes `limit` (the walk stops
 * there). Every own property of every object is walked, a built-in's too
 * (its intrinsic storage charged by its kind); a function (an RPC stub, a
 * service binding) is a capability, charged as one and not walked. Throws
 * LoaderRefusal, `at` naming where, for a compiled WebAssembly.Module, a
 * symbol, or an accessor, whose value the shim cannot account for without
 * running it.
 */
export function liveCharge(root, limit, at, seen = new Set()) {
    const stack = [{ value: root, path: at }];
    let total = 0;
    const add = (n) => {
        total += n;
        return total > limit;
    };
    /** Each own property of `owner` but those `skip` names (its intrinsic storage), its key charged and its value queued. */
    const properties = (owner, path, skip) => {
        for (const key of Reflect.ownKeys(owner)) {
            if (typeof key === 'symbol')
                throw new LoaderRefusal(`Nimbus Worker Loader: ${path} has a symbol-keyed property, which the shim cannot account for`);
            if (skip(key))
                continue;
            const descriptor = Object.getOwnPropertyDescriptor(owner, key);
            if (descriptor === undefined)
                continue;
            if (!('value' in descriptor))
                throw new LoaderRefusal(`Nimbus Worker Loader: ${path}.${key} is an accessor, which the shim cannot account for without running it`);
            if (add(SLOT + stringCharge(key)))
                return true;
            stack.push({ value: descriptor.value, path: `${path}.${key}` });
        }
        return false;
    };
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
        const { value, path } = item;
        switch (typeof value) {
            case 'string':
                if (add(stringCharge(value)))
                    return Infinity;
                continue;
            case 'number':
            case 'boolean':
            case 'undefined':
                continue;
            case 'bigint':
                if (add(STRING + Math.ceil(value.toString(16).length / 2)))
                    return Infinity;
                continue;
            case 'function':
                if (seen.has(value))
                    continue;
                seen.add(value);
                if (add(OBJECT))
                    return Infinity;
                continue;
            case 'symbol':
                throw new LoaderRefusal(`Nimbus Worker Loader: ${path} is a symbol, which the shim cannot account for`);
        }
        if (typeof value !== 'object' || value === null || seen.has(value))
            continue;
        seen.add(value);
        if (value instanceof WebAssembly.Module) {
            throw new LoaderRefusal(`Nimbus Worker Loader: ${path} is a compiled WebAssembly.Module, which cannot cross to the loader: pass its bytes ({ wasm: ArrayBuffer })`);
        }
        if (add(OBJECT))
            return Infinity;
        let skip = () => false;
        if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)) {
            if (add(value.byteLength))
                return Infinity;
        }
        else if (ArrayBuffer.isView(value)) {
            stack.push({ value: value.buffer, path });
            skip = isIndex;
        }
        else if (Array.isArray(value)) {
            // V8 holds a holey array's backing store at its length.
            if (add(ARRAY_ELEMENT * value.length))
                return Infinity;
            skip = (key) => key === 'length';
            for (const key of Object.keys(value)) {
                if (!isIndex(key))
                    continue;
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (descriptor !== undefined && !('value' in descriptor))
                    throw new LoaderRefusal(`Nimbus Worker Loader: ${path}[${key}] is an accessor, which the shim cannot account for without running it`);
                if (add(ARRAY_ELEMENT))
                    return Infinity;
                stack.push({ value: descriptor?.value, path: `${path}[${key}]` });
            }
            const named = skip;
            skip = (key) => named(key) || isIndex(key);
        }
        else if (value instanceof Map) {
            for (const [key, entry] of value) {
                if (add(COLLECTION_ENTRY))
                    return Infinity;
                stack.push({ value: key, path: `${path}<key>` }, { value: entry, path: `${path}<value>` });
            }
        }
        else if (value instanceof Set) {
            for (const entry of value) {
                if (add(COLLECTION_ENTRY))
                    return Infinity;
                stack.push({ value: entry, path: `${path}<entry>` });
            }
        }
        else if (value instanceof RegExp) {
            if (add(stringCharge(value.source) + stringCharge(value.flags)))
                return Infinity;
            skip = (key) => key === 'lastIndex';
        }
        else if (value instanceof String) {
            stack.push({ value: value.valueOf(), path });
            skip = (key) => key === 'length' || isIndex(key);
        }
        else if (value instanceof Number || value instanceof Boolean || value instanceof BigInt) {
            stack.push({ value: value.valueOf(), path });
        }
        else if (value instanceof Error && !Object.hasOwn(value, 'name')) {
            if (add(stringCharge(value.name)))
                return Infinity;
        }
        // Every object's own properties: a plain object's, a built-in's beside its storage, and an instance's of any class.
        if (properties(value, path, skip))
            return Infinity;
    }
    return total;
}
/**
 * At most how long `JSON.stringify(value)` is, in UTF-16 units, bounded
 * before it is built: every string at its worst escaping (6 per unit, and its
 * quotes), 25 per number, 5 per literal, and 2 per container plus 1 per
 * separator; Infinity past `limit`.
 */
export function jsonTextBound(value, limit) {
    const stack = [value];
    let total = 0;
    // A shared object is written each time it is reached, so nothing is skipped; a cycle runs past `limit`.
    while (stack.length > 0) {
        if (total > limit)
            return Infinity;
        const item = stack.pop();
        if (typeof item === 'string') {
            total += 6 * item.length + 2;
            continue;
        }
        if (typeof item === 'number' || typeof item === 'bigint') {
            total += 25;
            continue;
        }
        if (typeof item !== 'object' || item === null) {
            total += 5;
            continue;
        }
        // A typed array is written as an object of its elements, `"i":n` each; a buffer, a Map and a Set as `{}`.
        if (ArrayBuffer.isView(item)) {
            total += 2 + 32 * item.byteLength;
            continue;
        }
        if (item instanceof ArrayBuffer || item instanceof Map || item instanceof Set) {
            total += 2;
            continue;
        }
        const values = Array.isArray(item) ? item : Object.entries(item).flat();
        total += 2 + values.length;
        for (const entry of values)
            stack.push(entry);
    }
    return total > limit ? Infinity : total;
}
/**
 * The length of `text` as JSON.stringify writes it, quotes included, counted
 * without building it: a control character or lone surrogate as six (`\u00XX`),
 * `"` and `\` as two. Stops counting past `limit`.
 */
export function jsonStringLength(text, limit) {
    let length = 2;
    for (let i = 0; i < text.length && length <= limit; i++) {
        const unit = text.charCodeAt(i);
        if (unit < 0x20)
            length += 6;
        else if (unit === 0x22 || unit === 0x5c)
            length += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                length += 2;
                i++;
            }
            else
                length += 6;
        }
        else if (unit >= 0xdc00 && unit <= 0xdfff)
            length += 6;
        else
            length += 1;
    }
    return length;
}
const entries = new ByteLru(LOADER_ENTRY_CACHE_BYTES);
const modules = new ByteLru(LOADER_MODULE_CACHE_BYTES);
const codeCredit = new WeightedCreditPool(LOADER_CODE_CREDIT_BYTES);
const keyAllowance = new WeightedCreditPool(LOADER_KEY_ALLOWANCE_BYTES);
let nextEntryId = 0;
let refusals = 0;
let keyRefused = 0;
let nativeMisses = 0;
let evictedMisses = 0;
const moduleKey = (entry, name) => `${entry.id}\0${name}`;
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
function report(event, detail = {}) {
    const key = detail.key === undefined ? {} : { key: detail.key.length > 64 ? `${detail.key.slice(0, 64)}…(${detail.key.length})` : detail.key };
    console.log(`[nimbus/loader-shim] ${JSON.stringify({ event, ...detail, ...key, ...loaderHeapStats() })}`);
}
function refuse(event, message) {
    refusals++;
    report('refused', { reason: event });
    throw new LoaderRefusal(`Nimbus Worker Loader: ${message}`);
}
const OVER_WORKER_BOUND = `over the Nimbus Worker Loader shim's per-Worker bound of ${bytes(LOADER_WORKER_BYTES)} (LOADER_WORKER_BYTES; native workerd allows ${bytes(DYNAMIC_WORKER_CODE_LIMIT_BYTES)})`;
/** Price `code`, admitted under `key` (whose own charge the caller holds): refused by name over any bound. */
export function priceCode(code, key) {
    const { modules: moduleMap, ...rest } = code;
    if (moduleMap === null || typeof moduleMap !== 'object')
        refuse('no-modules', 'the code has no module map');
    const seen = new Set();
    const moduleCharges = new Map();
    let charge = OBJECT;
    let jsonText = 0;
    for (const name of Object.keys(moduleMap)) {
        const descriptor = Object.getOwnPropertyDescriptor(moduleMap, name);
        if (descriptor === undefined || !('value' in descriptor))
            refuse('accessor', `module ${JSON.stringify(name)} is an accessor, which the shim cannot account for without running it`);
        const content = descriptor.value;
        const at = `modules[${JSON.stringify(name)}]`;
        const shared = SLOT + stringCharge(name) + liveCharge(content, LOADER_WORKER_BYTES, at, seen);
        charge += shared;
        if (charge > LOADER_WORKER_BYTES)
            refuse('worker-bound', `this Worker holds more than ${bytes(LOADER_WORKER_BYTES)} live, counting through module ${JSON.stringify(name)}: ${OVER_WORKER_BOUND}`);
        moduleCharges.set(name, SLOT + stringCharge(name) + liveCharge(content, Infinity, at));
        if (typeof content === 'object' && content !== null && 'json' in content) {
            jsonText += 2 * jsonTextBound(content.json, LOADER_WORKER_BYTES);
            if (jsonText > LOADER_WORKER_BYTES)
                refuse('worker-bound', `module ${JSON.stringify(name)}'s JSON text could take more than ${bytes(LOADER_WORKER_BYTES)}: ${OVER_WORKER_BOUND}`);
        }
    }
    const entryCharge = liveCharge(rest, LOADER_ENTRY_CACHE_BYTES, 'code') + stringCharge(key)
        + [...moduleCharges.keys()].reduce((sum, name) => sum + SLOT + stringCharge(name), 0);
    if (entryCharge + BYTE_LRU_ENTRY_OVERHEAD > LOADER_ENTRY_CACHE_BYTES) {
        refuse('entry-bound', `this Worker's env and metadata charge ${entryCharge === Infinity ? `over ${bytes(LOADER_ENTRY_CACHE_BYTES)}` : bytes(entryCharge + BYTE_LRU_ENTRY_OVERHEAD)}, over the shim's ${bytes(LOADER_ENTRY_CACHE_BYTES)} entry bound (LOADER_ENTRY_CACHE_BYTES)`);
    }
    charge += liveCharge(rest, LOADER_WORKER_BYTES, 'code', seen) + stringCharge(key);
    if (charge > LOADER_WORKER_BYTES)
        refuse('worker-bound', `this Worker holds ${bytes(charge)} live: ${OVER_WORKER_BOUND}`);
    // Re-created from the cache, a Worker borrows what it holds; from its store (keep), it is priced again.
    return { code, charge, jsonText, entry: { byteLength: entryCharge, code: rest, modules: [...moduleCharges.keys()], missPeak: charge }, moduleCharges };
}
/** `credit`, refused by name when the whole pool could never grant it. */
export function withinCredit(credit) {
    if (credit > LOADER_CODE_CREDIT_BYTES)
        refuse('worker-bound', `admitting this Worker holds ${bytes(credit)} with its working space: ${OVER_WORKER_BOUND}`);
    return Math.max(1, credit);
}
/** Code credit for an argument that has already arrived: granted now, or the call is refused. */
export function admitNow(charge) {
    const lease = codeCredit.tryAcquire(withinCredit(charge));
    if (lease === null) {
        const { current } = codeCredit.stats;
        refuse('busy', `the shim is holding ${bytes(current)} of other Workers' code (bound ${bytes(LOADER_CODE_CREDIT_BYTES)}, LOADER_CODE_CREDIT_BYTES) and this one needs ${bytes(charge)}; retry`);
    }
    return lease;
}
/** Code credit, waited for in turn (holding nothing it charges), or refused after CREDIT_WAIT_MS. */
export async function admitInTurn(charge, what) {
    try {
        return await codeCredit.acquire(Math.max(1, charge), AbortSignal.timeout(CREDIT_WAIT_MS));
    }
    catch {
        refuse('busy', `${what} waited ${CREDIT_WAIT_MS / 1000} s for ${bytes(charge)} of code credit (bound ${bytes(LOADER_CODE_CREDIT_BYTES)}, LOADER_CODE_CREDIT_BYTES); retry`);
    }
}
/**
 * A `get`'s key, bounded before it is built: each of its parts a string (the
 * network id may be null) of at most LOADER_GET_ID_MAX_CHARS units, its JSON
 * length counted first. Its `charge` is the key's and the raw parts' own,
 * which a miss holds under the key allowance (holdGetKey); a hit holds none.
 */
export function getKey(namespace, networkId, id) {
    const part = (name, value, nullable) => {
        if (value === null && nullable)
            return null;
        if (typeof value !== 'string')
            refuse('get-id', `a LOADER.get ${name} must be a string`);
        if (value.length > LOADER_GET_ID_MAX_CHARS) {
            refuse('get-id', `a LOADER.get ${name} of ${value.length.toLocaleString('en-US')} UTF-16 units is over the shim's ${LOADER_GET_ID_MAX_CHARS.toLocaleString('en-US')} (LOADER_GET_ID_MAX_CHARS)`);
        }
        return value;
    };
    const textId = part('id', id, false);
    const space = part('namespace', namespace, false);
    const network = part('network id', networkId, true);
    const parts = [space, network, textId];
    const length = 'get:'.length + 4 + parts.reduce((sum, value) => sum + (value === null ? 4 : jsonStringLength(value, LOADER_ENTRY_CACHE_BYTES)), 0);
    if (STRING + 2 * length > LOADER_ENTRY_CACHE_BYTES) {
        refuse('get-id', `a LOADER.get key of ${length.toLocaleString('en-US')} characters charges over the shim's ${bytes(LOADER_ENTRY_CACHE_BYTES)} entry bound`);
    }
    const charge = STRING + 2 * length + parts.reduce((sum, value) => sum + (value === null ? 0 : stringCharge(value)), 0);
    return { key: 'get:' + JSON.stringify(parts), charge };
}
/** A missed `get`'s key and arguments, held under the key allowance: granted now, or the call is refused. */
export function holdGetKey(charge) {
    const lease = keyAllowance.tryAcquire(charge);
    if (lease === null) {
        keyRefused++;
        refuse('key-allowance', `the shim is holding ${bytes(keyAllowance.stats.current)} of other LOADER.get keys (bound ${bytes(LOADER_KEY_ALLOWANCE_BYTES)}, LOADER_KEY_ALLOWANCE_BYTES) and this one needs ${bytes(charge)}; retry`);
    }
    return lease;
}
/**
 * Keep an admitted Worker: its entry, and each module the module cache can
 * hold (one larger than it is not offered, so it never flushes the rest).
 * One whose modules are durable (`stored`, in `ref`'s store) is re-created
 * from there once the cache lets them go, so its miss peak is priced from
 * their working prices, and refused over the per-Worker bound before its
 * handle is returned.
 */
export function keep(key, priced, durable) {
    let entry = { ...priced.entry, id: ++nextEntryId };
    if (durable !== undefined) {
        let missPeak = entry.byteLength + STORE_READ_BYTES;
        for (const module of durable.modules.values())
            missPeak += module.missPrice;
        if (missPeak > LOADER_WORKER_BYTES)
            refuse('worker-bound', `re-creating this Worker from the store would hold ${bytes(missPeak)}: ${OVER_WORKER_BOUND}`);
        const stored = new Map([...durable.modules].map(([name, { kind, size, digest }]) => [name, { kind, size, digest }]));
        entry = { ...entry, missPeak, store: { ref: durable.ref, modules: stored } };
    }
    entries.set(key, entry);
    for (const [name, charge] of priced.moduleCharges) {
        if (charge + BYTE_LRU_ENTRY_OVERHEAD > LOADER_MODULE_CACHE_BYTES)
            continue;
        modules.set(moduleKey(entry, name), { byteLength: charge, content: priced.code.modules[name] });
    }
    report('admitted', { key, charge: priced.charge });
}
/** The code `key` was admitted with but its modules (its policy's source), or undefined once evicted. */
export function loadedCode(key) {
    return entries.get(key)?.code;
}
/**
 * A native miss's code for `key`: credit for its miss peak taken first,
 * holding nothing but the key while it waits; the entry looked up again once
 * it is granted (one replaced meanwhile by a larger one is refused, as its
 * lease does not cover it), its owner asked whether it is alive (a retired
 * build's Worker is never re-created), and every module from the cache or,
 * the cache having let it go, from its store (through `env`'s host
 * namespace). A Worker the shim no longer holds fails by name. The lease is
 * held until `use` returns.
 */
export async function withMissCode(key, env, use) {
    nativeMisses++;
    const evicted = () => {
        evictedMisses++;
        report('evicted', { key });
        throw new LoaderRefusal(`Nimbus: dynamic worker '${key}' is no longer loaded: the shim's cache evicted it`);
    };
    const peak = entries.get(key)?.missPeak ?? evicted();
    const lease = await admitInTurn(peak, `re-creating dynamic worker '${key}'`);
    try {
        const entry = entries.get(key) ?? evicted();
        if (entry.missPeak > peak)
            refuse('replaced', `dynamic worker '${key}' was loaded again, larger, while its re-creation waited; retry`);
        const store = entry.store === undefined ? null : loaderStore(env, entry.store.ref);
        if (store !== null && !(await store.alive())) {
            report('retired', { key });
            throw new LoaderRefusal(`Nimbus: dynamic worker '${key}': this worker's loader binding was retired: its build was replaced or stopped`);
        }
        const assembled = {};
        let reads = 0;
        for (const name of entry.modules) {
            let content = modules.get(moduleKey(entry, name))?.content;
            const stored = entry.store?.modules.get(name);
            if (content === undefined && store !== null && stored !== undefined) {
                content = restoredModule(stored.kind, await store.read(stored));
                if (stored.size + BYTE_LRU_ENTRY_OVERHEAD <= LOADER_MODULE_CACHE_BYTES)
                    modules.set(moduleKey(entry, name), { byteLength: stored.size, content });
                reads++;
            }
            // An own property whatever the name, `__proto__` included.
            Object.defineProperty(assembled, name, { value: content ?? evicted(), enumerable: true, writable: true, configurable: true });
        }
        report('native-miss', { key, missPeak: peak, storeReads: reads });
        return await use({ ...entry.code, modules: assembled });
    }
    finally {
        lease.release();
    }
}
