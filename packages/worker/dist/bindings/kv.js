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
// ── Test seam: clock ────────────────────────────────────────────────────
let _kvNow = () => Math.floor(Date.now() / 1000);
export function _setKvNow(fn) { _kvNow = fn; }
// ── Path helpers ────────────────────────────────────────────────────────
function encKey(key) {
    // Match KV's accepted key alphabet: any UTF-8 string up to 512 bytes. We
    // URL-encode to make every key VFS-path-safe.
    return encodeURIComponent(key);
}
function decKey(encoded) {
    try {
        return decodeURIComponent(encoded);
    }
    catch {
        return encoded;
    }
}
// ── KvEmulator ─────────────────────────────────────────────────────────
export class KvEmulator {
    vfs;
    dir;
    metaCache = new Map();
    onLog;
    constructor(opts) {
        this.vfs = opts.vfs;
        const root = String(opts.root).replace(/^\/+/, '').replace(/\/+$/, '');
        this.dir = (root ? root + '/' : '') + '.nimbus/kv/' + opts.binding;
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
        const enc = encKey(key);
        const bodyBlob = await this._coerceBody(value);
        this._ensureDir();
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
        const enc = encKey(key);
        const bp = this.dir + '/' + enc;
        const mp = bp + '.meta';
        try {
            if (this.vfs.exists(bp))
                this.vfs.unlink(bp);
        }
        catch { }
        try {
            if (this.vfs.exists(mp))
                this.vfs.unlink(mp);
        }
        catch { }
        this.metaCache.delete(enc);
    }
    async list(options) {
        const prefix = options?.prefix || '';
        const limit = options?.limit ?? 1000;
        const cursorOff = options?.cursor ? this._decodeCursor(options.cursor) : 0;
        let entries = [];
        try {
            const dirents = this.vfs.readdir(this.dir);
            for (const e of dirents) {
                if (e.type === 'directory')
                    continue;
                if (e.name.endsWith('.meta'))
                    continue;
                const decoded = decKey(e.name);
                if (!decoded.startsWith(prefix))
                    continue;
                const meta = this._readMeta(e.name);
                // Skip expired
                if (meta?.exp != null && meta.exp <= _kvNow()) {
                    this._lazyDelete(e.name);
                    continue;
                }
                const out = { name: decoded };
                if (meta?.exp != null)
                    out.expiration = meta.exp;
                if (meta?.meta !== undefined)
                    out.metadata = meta.meta;
                entries.push(out);
            }
        }
        catch {
            // Empty dir: no keys
            entries = [];
        }
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        const slice = entries.slice(cursorOff, cursorOff + limit);
        const next = cursorOff + slice.length;
        const list_complete = next >= entries.length;
        const out = {
            keys: slice,
            list_complete,
            cacheStatus: null,
        };
        if (!list_complete)
            out.cursor = this._encodeCursor(next);
        return out;
    }
    // ── internals ─────────────────────────────────────────────────────────
    _ensureDir() {
        if (!this.vfs.exists(this.dir)) {
            this.vfs.mkdir(this.dir, { recursive: true });
        }
    }
    async _coerceBody(value) {
        if (value == null)
            return new Uint8Array(0);
        if (typeof value === 'string')
            return new TextEncoder().encode(value);
        if (value instanceof Uint8Array)
            return value;
        if (value instanceof ArrayBuffer)
            return new Uint8Array(value);
        if (ArrayBuffer.isView(value))
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (typeof value === 'object' && typeof value.getReader === 'function') {
            // ReadableStream — drain
            const chunks = [];
            let total = 0;
            const reader = value.getReader();
            while (true) {
                const { value: chunk, done } = await reader.read();
                if (done)
                    break;
                const u = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                chunks.push(u);
                total += u.length;
            }
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
                out.set(c, off);
                off += c.length;
            }
            return out;
        }
        // Fallback — try toString
        return new TextEncoder().encode(String(value));
    }
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
        if (t === 'stream') {
            const u = body;
            return new ReadableStream({
                type: 'bytes',
                start(controller) {
                    controller.enqueue(u);
                    controller.close();
                },
            });
        }
        return new TextDecoder().decode(body);
    }
    async _readResolved(key) {
        const enc = encKey(key);
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
        const bp = this.dir + '/' + encName;
        const mp = bp + '.meta';
        try {
            if (this.vfs.exists(bp))
                this.vfs.unlink(bp);
        }
        catch { }
        try {
            if (this.vfs.exists(mp))
                this.vfs.unlink(mp);
        }
        catch { }
        this.metaCache.delete(encName);
    }
    _encodeCursor(off) {
        // base64url-encode the offset record. We use btoa (Web Standard,
        // available in workerd and Bun) and patch base64 → base64url.
        const b64 = btoa(JSON.stringify({ off }));
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    _decodeCursor(c) {
        try {
            const b64 = String(c).replace(/-/g, '+').replace(/_/g, '/');
            const j = JSON.parse(atob(b64));
            return Number(j.off) || 0;
        }
        catch {
            return 0;
        }
    }
}
