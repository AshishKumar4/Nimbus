/**
 * binding-kv.ts — KV namespace emulator for nimbus-wrangler.
 *
 * Implements the Workers KV runtime API
 * (https://developers.cloudflare.com/kv/api/) backed by SqliteVFS file
 * blobs. The emulator is constructed inline by NimbusWrangler.buildInnerEnv()
 * and attached as `env.<binding>` on the inner Worker.
 *
 * Storage layout:
 *   <root>/.nimbus/kv/<binding>/<key>             — body (raw bytes)
 *   <root>/.nimbus/kv/<binding>/<key>.meta        — sidecar JSON:
 *      { exp?: number,           // unix seconds, absolute expiration
 *        meta?: any,              // user-supplied metadata
 *        v: 1 }                   // schema version
 *
 * Keys are URL-encoded so that '/' / '\\' / '\0' / '#' / etc. don't break
 * the VFS path. We then add ".meta" to derive the sidecar path.
 *
 * Concurrency: KV semantics permit eventual consistency. We do not use
 * VFS writeBatch for the body+meta pair (a torn write surfaces as a meta
 * read mismatch which we treat as no-metadata; the body still resolves).
 *
 * Test seam: `_setKvNow(() => ts)` replaces the wall clock (Date.now/1000)
 * for TTL probes. Production reads Date.now() / 1000.
 */
import { bodyStream, coerceBindingBody, ensureBindingDir } from './body.js';
import { cursorPage, listObjectFiles, objectFileName, objectStoreDir, removeObjectFiles } from './object-store.js';
// ── Test seam: clock ────────────────────────────────────────────────────
let _kvNow = () => Math.floor(Date.now() / 1000);
export function _setKvNow(fn) { _kvNow = fn; }
// ── KvEmulator ─────────────────────────────────────────────────────────
export class KvEmulator {
    vfs;
    dir;
    metaCache = new Map();
    onLog;
    constructor(opts) {
        this.vfs = opts.vfs;
        this.dir = objectStoreDir(opts.root, 'kv', opts.binding);
        this.onLog = opts.onLog || (() => { });
    }
    // ── public API ────────────────────────────────────────────────────────
    async get(key, options) {
        const opts = typeof options === 'string' ? { type: options } : (options || {});
        const r = await this._readResolved(key);
        if (r == null)
            return null;
        return this._project(r.body, opts.type);
    }
    async getWithMetadata(key, options) {
        const opts = typeof options === 'string' ? { type: options } : (options || {});
        const r = await this._readResolved(key);
        if (r == null)
            return { value: null, metadata: null, cacheStatus: null };
        const value = this._project(r.body, opts.type);
        return { value, metadata: (r.meta?.meta ?? null), cacheStatus: null };
    }
    async put(key, value, options) {
        const enc = objectFileName(key);
        const bodyBlob = await coerceBindingBody(value);
        ensureBindingDir(this.vfs, this.dir);
        this.vfs.writeFile(this.dir + '/' + enc, bodyBlob);
        // Build sidecar
        const meta = { v: 1 };
        if (options?.expiration != null)
            meta.exp = options.expiration;
        else if (options?.expirationTtl != null)
            meta.exp = _kvNow() + options.expirationTtl;
        if (options?.metadata !== undefined)
            meta.meta = options.metadata;
        const metaPath = this.dir + '/' + enc + '.meta';
        if (meta.exp != null || meta.meta !== undefined) {
            this.vfs.writeFile(metaPath, JSON.stringify(meta));
            this.metaCache.set(enc, meta);
        }
        else {
            // Overwrite-without-metadata clears the sidecar (per probe contract:
            // 'overwrite WITHOUT metadata clears metadata').
            try {
                if (this.vfs.exists(metaPath))
                    this.vfs.unlink(metaPath);
            }
            catch { }
            this.metaCache.delete(enc);
        }
    }
    async delete(key) {
        this._lazyDelete(objectFileName(key));
    }
    async list(options) {
        const entries = [];
        for (const { key, fileName } of listObjectFiles(this.vfs, this.dir, options?.prefix || '')) {
            const meta = this._readMeta(fileName);
            // Skip expired
            if (meta?.exp != null && meta.exp <= _kvNow()) {
                this._lazyDelete(fileName);
                continue;
            }
            const out = { name: key };
            if (meta?.exp != null)
                out.expiration = meta.exp;
            if (meta?.meta !== undefined)
                out.metadata = meta.meta;
            entries.push(out);
        }
        const { page, next } = cursorPage(entries, options?.cursor, options?.limit ?? 1000);
        const out = {
            keys: page,
            list_complete: next === undefined,
            cacheStatus: null,
        };
        if (next !== undefined)
            out.cursor = next;
        return out;
    }
    // ── internals ─────────────────────────────────────────────────────────
    _project(body, type) {
        const t = type || 'text';
        if (t === 'text')
            return new TextDecoder().decode(body);
        if (t === 'json') {
            const txt = new TextDecoder().decode(body);
            return JSON.parse(txt);
        }
        if (t === 'arrayBuffer') {
            // Return a fresh ArrayBuffer (not a view into a shared buffer).
            const ab = new ArrayBuffer(body.byteLength);
            new Uint8Array(ab).set(body);
            return ab;
        }
        if (t === 'stream')
            return bodyStream(body);
        return new TextDecoder().decode(body);
    }
    async _readResolved(key) {
        const enc = objectFileName(key);
        const path = this.dir + '/' + enc;
        if (!this.vfs.exists(path))
            return null;
        const meta = this._readMeta(enc);
        if (meta?.exp != null && meta.exp <= _kvNow()) {
            this._lazyDelete(enc);
            return null;
        }
        const body = this.vfs.readFile(path);
        return { body, meta };
    }
    _readMeta(encName) {
        if (this.metaCache.has(encName))
            return this.metaCache.get(encName);
        const mp = this.dir + '/' + encName + '.meta';
        if (!this.vfs.exists(mp))
            return null;
        try {
            const raw = this.vfs.readFileString(mp);
            const m = JSON.parse(raw);
            this.metaCache.set(encName, m);
            return m;
        }
        catch (e) {
            // Torn meta — treat as absent
            return null;
        }
    }
    _lazyDelete(encName) {
        removeObjectFiles(this.vfs, this.dir, encName);
        this.metaCache.delete(encName);
    }
}
