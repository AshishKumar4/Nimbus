/**
 * kv.ts — the KV namespace a Worker is given under `nimbus wrangler dev`
 * (https://developers.cloudflare.com/kv/api/), as `wrangler dev` gives it:
 * workerd's KV client (kv.c++) over Cloudflare's local store (Miniflare's
 * KV namespace), each checking and answering as they do.
 *
 * The session serves it (session/rpc.ts _rpcKvCall) for the Worker's binding
 * (fabric bindings.ts NimbusKVNamespace), backed by SqliteVFS files:
 *
 *   <root>/.nimbus/kv/<binding>/<key>             — body (raw bytes)
 *   <root>/.nimbus/kv/<binding>/<key>.meta        — sidecar JSON:
 *      { exp?: number,           // unix seconds, absolute expiration
 *        meta?: <JSON>,           // user-supplied metadata
 *        v: 1 }                   // schema version
 *
 * A value is streamed to its file as it arrives, and one past KV's 25 MiB
 * is refused as it passes it, its stream cancelled; it is written beside
 * the key's file and replaces it once whole, so a refused put leaves the
 * value it would have replaced.
 *
 * Test seam: `_setKvNow(() => ts)` replaces the wall clock (Date.now/1000)
 * for TTL probes. Production reads Date.now() / 1000.
 */
import { z } from 'zod/v4';
import { jsgInt } from '@nimbus-sh/fabric/jsg-int.js';
import { ensureBindingDir, fileStream, writeBody } from './body.js';
import { cursorAfter, cursorKey, listObjectFiles, objectFileName, objectStoreDir, removeObjectFiles, uploadFileName, utf8Order } from './object-store.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';
/** A key's sidecar, as the store wrote it. */
const KvMetaSchema = z.object({ exp: z.number().optional(), meta: z.json().optional(), v: z.literal(1) });
/** Cloudflare's KV limits, as its local store enforces them. */
const MAX_KEY_BYTES = 512;
const MIN_CACHE_TTL = 30;
const MIN_EXPIRATION_TTL = 60;
const MAX_LIST_KEYS = 1000;
const MAX_VALUE_BYTES = 25 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024;
const MAX_BULK_KEYS = 100;
/** A request the store refused, as workerd's KV client throws it. */
function failed(method, status, message) {
    return new Error(`KV ${method} failed: ${status} ${message}`);
}
/** workerd's validateKeyName: what the client refuses before sending. */
function validateKeyName(method, key) {
    if (key === '')
        throw new TypeError('Key name cannot be empty.');
    if (key === '.' || key === '..')
        throw new TypeError(`"${key}" is not allowed as a key name.`);
    const bytes = utf8Length(key);
    if (bytes > MAX_KEY_BYTES)
        throw failed(method, 414, `UTF-8 encoded length of ${bytes} exceeds key length limit of ${MAX_KEY_BYTES}.`);
}
/** A get's options, a type string or an object, as the client reads them. */
function getOptions(options) {
    if (typeof options === 'string')
        return { type: options, cacheTtl: undefined };
    return { type: options?.type === undefined ? undefined : String(options.type), cacheTtl: jsgInt(options?.cacheTtl) };
}
function checkCacheTtl(method, cacheTtl) {
    if (cacheTtl !== undefined && cacheTtl < MIN_CACHE_TTL) {
        throw failed(method, 400, `Invalid cache_ttl of ${cacheTtl}. Cache TTL must be at least ${MIN_CACHE_TTL}.`);
    }
}
/** Whether `name` is an array index, which a bulk answer's Map leaves out (workerd reads its keys SKIP_INDICES). */
function isArrayIndex(name) {
    return /^(0|[1-9][0-9]*)$/.test(name) && Number(name) < 4294967295;
}
// ── Test seam: clock ────────────────────────────────────────────────────
let _kvNow = () => Math.floor(Date.now() / 1000);
export function _setKvNow(fn) { _kvNow = fn; }
// ── KvEmulator ─────────────────────────────────────────────────────────
export class KvEmulator {
    vfs;
    dir;
    constructor(opts) {
        this.vfs = opts.vfs;
        this.dir = objectStoreDir(opts.root, 'kv', opts.binding);
    }
    // ── public API ────────────────────────────────────────────────────────
    get(key, options) {
        return Array.isArray(key) ? this.#getBulk(key, options, false) : this.#getOne(String(key), options).then((r) => r.value);
    }
    getWithMetadata(key, options) {
        return Array.isArray(key) ? this.#getBulk(key, options, true) : this.#getOne(String(key), options);
    }
    async put(key, value, options) {
        const name = String(key);
        validateKeyName('PUT', name);
        const expiration = jsgInt(options?.expiration);
        const expirationTtl = jsgInt(options?.expirationTtl);
        const metadata = options?.metadata ?? undefined;
        // A string, or the three kinds of object it takes; any other value is its string.
        const isObject = value !== null && (typeof value === 'object' || typeof value === 'function');
        const supported = value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof ReadableStream;
        if (isObject && !supported) {
            throw new TypeError('KV put() accepts only strings, ArrayBuffers, ArrayBufferViews, and ReadableStreams as values.');
        }
        const now = _kvNow();
        const meta = { v: 1 };
        if (expirationTtl !== undefined) {
            if (expirationTtl <= 0)
                throw failed('PUT', 400, `Invalid expiration_ttl of ${expirationTtl}. Please specify integer greater than 0.`);
            if (expirationTtl < MIN_EXPIRATION_TTL)
                throw failed('PUT', 400, `Invalid expiration_ttl of ${expirationTtl}. Expiration TTL must be at least ${MIN_EXPIRATION_TTL}.`);
            meta.exp = now + expirationTtl;
        }
        else if (expiration !== undefined) {
            if (expiration <= now) {
                throw failed('PUT', 400, `Invalid expiration of ${expiration}. Please specify integer greater than the current number of seconds since the UNIX epoch.`);
            }
            if (expiration < now + MIN_EXPIRATION_TTL) {
                throw failed('PUT', 400, `Invalid expiration of ${expiration}. Expiration times must be at least ${MIN_EXPIRATION_TTL} seconds in the future.`);
            }
            meta.exp = expiration;
        }
        if (metadata !== undefined) {
            const bytes = utf8Length(JSON.stringify(metadata));
            if (bytes > MAX_METADATA_BYTES)
                throw failed('PUT', 413, `Metadata length of ${bytes} exceeds limit of ${MAX_METADATA_BYTES}.`);
            meta.meta = metadata;
        }
        const enc = objectFileName(name);
        ensureBindingDir(this.vfs, this.dir);
        const upload = this.dir + '/' + uploadFileName();
        await writeBody(this.vfs, upload, isObject ? value : String(value), MAX_VALUE_BYTES, (received) => failed('PUT', 413, `Value length of ${received} exceeds limit of ${MAX_VALUE_BYTES}.`));
        this.vfs.rename(upload, this.dir + '/' + enc);
        // A put replaces the entry whole: an expiry or metadata it does not give is gone.
        const metaPath = this.dir + '/' + enc + '.meta';
        if (meta.exp !== undefined || meta.meta !== undefined)
            this.vfs.writeFile(metaPath, JSON.stringify(meta));
        else if (this.vfs.exists(metaPath))
            this.vfs.unlink(metaPath);
    }
    async delete(key) {
        const name = String(key);
        validateKeyName('DELETE', name);
        removeObjectFiles(this.vfs, this.dir, objectFileName(name));
    }
    async list(options) {
        // workerd's client sends a limit only when it is positive; the store refuses a larger one as the GET it is.
        const given = jsgInt(options?.limit);
        const limit = given === undefined || given <= 0 ? MAX_LIST_KEYS : given;
        if (limit > MAX_LIST_KEYS)
            throw failed('GET', 400, `Invalid key_count_limit of ${limit}. Please specify an integer less than ${MAX_LIST_KEYS}.`);
        const prefix = options?.prefix == null ? '' : String(options.prefix);
        const prefixBytes = utf8Length(prefix);
        if (prefixBytes > MAX_KEY_BYTES)
            throw failed('GET', 414, `UTF-8 encoded length of ${prefixBytes} exceeds key length limit of ${MAX_KEY_BYTES}.`);
        const after = options?.cursor == null ? undefined : cursorKey(String(options.cursor));
        const now = _kvNow();
        const keys = [];
        for (const { key, fileName } of listObjectFiles(this.vfs, this.dir, prefix)) {
            if (after !== undefined && utf8Order(key, after) <= 0)
                continue;
            const meta = this.#readMeta(fileName);
            if (meta?.exp !== undefined && meta.exp <= now) {
                removeObjectFiles(this.vfs, this.dir, fileName);
                continue;
            }
            const entry = { name: key };
            if (meta?.exp !== undefined)
                entry.expiration = meta.exp;
            if (meta?.meta !== undefined)
                entry.metadata = meta.meta;
            keys.push(entry);
            if (keys.length > limit)
                break;
        }
        if (keys.length <= limit)
            return { keys, list_complete: true, cacheStatus: null };
        keys.length = limit;
        return { keys, list_complete: false, cursor: cursorAfter(keys[limit - 1].name), cacheStatus: null };
    }
    // ── internals ─────────────────────────────────────────────────────────
    /** One key's value by its type, its metadata, and the cache status the store gives (none). */
    async #getOne(name, options) {
        validateKeyName('GET', name);
        const { type, cacheTtl } = getOptions(options);
        checkCacheTtl('GET', cacheTtl);
        const entry = this.#entry(objectFileName(name));
        if (entry === null)
            return { value: null, metadata: null, cacheStatus: null };
        const metadata = entry.meta?.meta ?? null;
        switch (type ?? 'text') {
            case 'text': return { value: new TextDecoder().decode(this.vfs.readFile(entry.path)), metadata, cacheStatus: null };
            case 'json': return { value: JSON.parse(new TextDecoder().decode(this.vfs.readFile(entry.path))), metadata, cacheStatus: null };
            case 'arrayBuffer': return { value: this.vfs.readFile(entry.path).slice().buffer, metadata, cacheStatus: null };
            case 'stream': return { value: fileStream(this.vfs, entry.path, 0, this.vfs.stat(entry.path).size), metadata, cacheStatus: null };
            default: throw new TypeError('Unknown response type. Possible types are "text", "arrayBuffer", "json", and "stream".');
        }
    }
    /** Many keys' values (text or JSON), as the store's bulk get answers them. */
    async #getBulk(names, options, withMetadata) {
        const { type, cacheTtl } = getOptions(options);
        if (type && type !== 'text' && type !== 'json')
            throw failed('GET_BULK', 400, `"${type}" is not a valid type. Use "json" or "text"`);
        if (names.length > MAX_BULK_KEYS)
            throw failed('GET_BULK', 400, `You can request a maximum of ${MAX_BULK_KEYS} keys`);
        if (names.length < 1)
            throw failed('GET_BULK', 400, 'You must request a minimum of 1 key');
        const answers = {};
        let total = 0;
        for (const raw of names) {
            const name = String(raw);
            if (name === '')
                throw failed('GET_BULK', 400, 'Key names must not be empty');
            if (name === '.' || name === '..')
                throw failed('GET_BULK', 400, `Illegal key name "${name}". Please use a different name.`);
            const bytes = utf8Length(name);
            if (bytes > MAX_KEY_BYTES)
                throw failed('GET_BULK', 414, `UTF-8 encoded length of ${bytes} exceeds key length limit of ${MAX_KEY_BYTES}.`);
            checkCacheTtl('GET_BULK', cacheTtl);
            const entry = this.#entry(objectFileName(name));
            if (entry === null) {
                answers[name] = null;
                continue;
            }
            const text = new TextDecoder().decode(this.vfs.readFile(entry.path));
            total += text.length;
            let value = text;
            if (type === 'json') {
                try {
                    value = JSON.parse(text);
                }
                catch {
                    throw failed('GET_BULK', 400, `At least one of the requested keys corresponds to a non-${type} value`);
                }
            }
            // A JSON null is null, with metadata or without (Miniflare's processKeyValue).
            answers[name] = withMetadata && value !== null ? { value, metadata: entry.meta?.meta ?? null } : value;
        }
        if (total > MAX_VALUE_BYTES)
            throw failed('GET_BULK', 413, `Total size of request exceeds the limit of ${MAX_VALUE_BYTES / 1024 / 1024}MB`);
        return new Map(Object.keys(answers).filter((name) => !isArrayIndex(name)).map((name) => [name, answers[name]]));
    }
    /** A key's body file and sidecar, or null when it is absent or expired (an expired one is removed). */
    #entry(fileName) {
        const path = this.dir + '/' + fileName;
        if (!this.vfs.exists(path))
            return null;
        const meta = this.#readMeta(fileName);
        if (meta?.exp !== undefined && meta.exp <= _kvNow()) {
            removeObjectFiles(this.vfs, this.dir, fileName);
            return null;
        }
        return { path, meta };
    }
    #readMeta(fileName) {
        const path = this.dir + '/' + fileName + '.meta';
        if (!this.vfs.exists(path))
            return null;
        try {
            return KvMetaSchema.parse(JSON.parse(this.vfs.readFileString(path)));
        }
        catch {
            return null; // a torn sidecar reads as none
        }
    }
}
/** One call of the KV API (fabric bindings.ts NimbusKVNamespace), served by `kv`. */
export async function serveKvCall(kv, call) {
    switch (call.method) {
        case 'get': return kv.get(call.key, call.options);
        case 'getWithMetadata': return kv.getWithMetadata(call.key, call.options);
        case 'put': return kv.put(call.key, call.value, call.options);
        case 'delete': return kv.delete(call.key);
        case 'list': return kv.list(call.options);
        default:
            call;
            throw new TypeError('KV has no such method');
    }
}
