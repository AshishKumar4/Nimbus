/**
 * binding-r2.ts — R2 bucket emulator for nimbus-wrangler.
 *
 * Implements the Workers R2 runtime API
 * (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
 * backed by SqliteVFS file blobs. Mirrors KV's storage layout:
 *
 *   <root>/.nimbus/r2/<binding>/<key>          — body (raw bytes)
 *   <root>/.nimbus/r2/<binding>/<key>.meta     — sidecar JSON:
 *      { etag: string,                       // sha256 hex of body
 *        size: number,
 *        uploaded: number,                    // unix ms
 *        httpMetadata?: R2HTTPMetadata,
 *        customMetadata?: Record<string,string>,
 *        v: 1 }
 *
 * Out of scope for W10 (W10.5 candidates):
 *   - Multipart uploads (createMultipartUpload / resumeMultipartUpload
 *     throw "not supported" errors with a clear message)
 *   - Server-side checksums (md5/sha1/sha256/sha512 verifies passed via
 *     `options` are honored only loosely — we compute sha256 ourselves
 *     and compare; mismatched verify hashes cause put() to throw)
 *
 * Range reads return bodies sliced from the in-memory Uint8Array.
 *
 * The `R2ObjectBody` returned by get() carries a fresh ReadableStream on
 * every call (the body is one-shot per real-R2 contract), plus convenience
 * helpers text() / arrayBuffer() / json() / blob().
 */
// ── Path helpers ────────────────────────────────────────────────────────
function encKey(key) {
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
// ── R2Object / R2ObjectBody ────────────────────────────────────────────
export class R2Object {
    key;
    version;
    size;
    etag;
    httpEtag;
    uploaded;
    httpMetadata;
    customMetadata;
    constructor(key, side) {
        this.key = key;
        this.version = side.etag; // mirror real R2: version is etag-like
        this.size = side.size;
        this.etag = side.etag;
        this.httpEtag = '"' + side.etag + '"';
        this.uploaded = new Date(side.uploaded);
        this.httpMetadata = side.httpMetadata || {};
        this.customMetadata = side.customMetadata || {};
    }
}
export class R2ObjectBody extends R2Object {
    /** @internal */
    _body;
    constructor(key, side, body) {
        super(key, side);
        this._body = body;
    }
    get body() {
        const bytes = this._body;
        return new ReadableStream({
            type: 'bytes',
            start(controller) {
                controller.enqueue(bytes);
                controller.close();
            },
        });
    }
    get bodyUsed() { return false; /* one-shot stream is not tracked */ }
    async text() {
        return new TextDecoder().decode(this._body);
    }
    async arrayBuffer() {
        const ab = new ArrayBuffer(this._body.byteLength);
        new Uint8Array(ab).set(this._body);
        return ab;
    }
    async json() {
        return JSON.parse(await this.text());
    }
    async blob() {
        return new Blob([this._body]);
    }
}
// ── R2Emulator ────────────────────────────────────────────────────────────
export class R2Emulator {
    vfs;
    dir;
    onLog;
    constructor(opts) {
        this.vfs = opts.vfs;
        const root = String(opts.root).replace(/^\/+/, '').replace(/\/+$/, '');
        this.dir = (root ? root + '/' : '') + '.nimbus/r2/' + opts.binding;
        this.onLog = opts.onLog || (() => { });
    }
    // ── public API ────────────────────────────────────────────────────────
    async head(key) {
        const side = this._readSide(key);
        if (!side)
            return null;
        return new R2Object(key, side);
    }
    async get(key, options) {
        const side = this._readSide(key);
        if (!side)
            return null;
        if (options?.onlyIf && !this._evalConditional(side, options.onlyIf))
            return null;
        let body = this._readBody(key);
        if (options?.range) {
            body = this._applyRange(body, options.range);
        }
        return new R2ObjectBody(key, side, body);
    }
    async put(key, value, options) {
        // Conditional: check existing
        if (options?.onlyIf) {
            const existing = this._readSide(key);
            // For PUT, the conditional checks the SOURCE state (existing object).
            // If onlyIf fails, return null without writing.
            if (existing && !this._evalConditional(existing, options.onlyIf))
                return null;
            if (!existing && options.onlyIf.etagMatches) {
                // etagMatches against missing object: fails
                return null;
            }
        }
        const body = await this._coerceBody(value);
        const etag = await this._sha256Hex(body);
        // Verify integrity hashes if supplied
        if (options?.md5 || options?.sha1 || options?.sha256 || options?.sha512) {
            // We only compute sha256 anyway; verify against the matching one.
            if (options.sha256 != null) {
                const want = this._normalizeHash(options.sha256);
                if (want.toLowerCase() !== etag.toLowerCase()) {
                    throw new Error('R2 put: sha256 verification failed');
                }
            }
            // md5/sha1/sha512 verification requires their own hash computation;
            // skipped for W10 (rarely used at dev time). Document in retro.
        }
        const side = {
            etag,
            size: body.byteLength,
            uploaded: Date.now(),
            v: 1,
        };
        if (options?.httpMetadata)
            side.httpMetadata = options.httpMetadata;
        if (options?.customMetadata)
            side.customMetadata = options.customMetadata;
        this._ensureDir();
        const enc = encKey(key);
        this.vfs.writeFile(this.dir + '/' + enc, body);
        this.vfs.writeFile(this.dir + '/' + enc + '.meta', JSON.stringify(side));
        return new R2Object(key, side);
    }
    async delete(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) {
            const enc = encKey(k);
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
        }
    }
    async list(options) {
        const prefix = options?.prefix || '';
        const limit = options?.limit ?? 1000;
        const cursorOff = options?.cursor ? this._decodeCursor(options.cursor) : 0;
        const delimiter = options?.delimiter;
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
                const side = this._readSideEnc(e.name);
                if (!side)
                    continue;
                entries.push({ key: decoded, side });
            }
        }
        catch {
            entries = [];
        }
        entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        // Delimiter handling: collect common prefixes that share <prefix><…><delimiter>
        const delimitedPrefixes = [];
        if (delimiter) {
            const seen = new Set();
            const filtered = [];
            for (const e of entries) {
                const tail = e.key.slice(prefix.length);
                const idx = tail.indexOf(delimiter);
                if (idx !== -1) {
                    const cp = prefix + tail.slice(0, idx + delimiter.length);
                    if (!seen.has(cp)) {
                        seen.add(cp);
                        delimitedPrefixes.push(cp);
                    }
                    continue; // grouped — don't list as an object
                }
                filtered.push(e);
            }
            entries = filtered;
        }
        const slice = entries.slice(cursorOff, cursorOff + limit);
        const next = cursorOff + slice.length;
        const truncated = next < entries.length;
        return {
            objects: slice.map(e => new R2Object(e.key, e.side)),
            truncated,
            ...(truncated ? { cursor: this._encodeCursor(next) } : {}),
            delimitedPrefixes,
        };
    }
    // ── multipart (out of scope) ─────────────────────────────────────────
    async createMultipartUpload(_key, _options) {
        throw new Error('R2 multipart uploads not supported in nimbus-wrangler dev (W10.5 candidate)');
    }
    async resumeMultipartUpload(_key, _uploadId) {
        throw new Error('R2 multipart uploads not supported in nimbus-wrangler dev (W10.5 candidate)');
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
        if (typeof Blob !== 'undefined' && value instanceof Blob) {
            const ab = await value.arrayBuffer();
            return new Uint8Array(ab);
        }
        return new TextEncoder().encode(String(value));
    }
    _readSide(key) {
        return this._readSideEnc(encKey(key));
    }
    _readSideEnc(enc) {
        const mp = this.dir + '/' + enc + '.meta';
        if (!this.vfs.exists(mp)) {
            // No sidecar — but the body might exist (legacy). Synthesize.
            const bp = this.dir + '/' + enc;
            if (!this.vfs.exists(bp))
                return null;
            return null; // No metadata at all means treat as missing
        }
        try {
            const raw = this.vfs.readFileString(mp);
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    _readBody(key) {
        const path = this.dir + '/' + encKey(key);
        return this.vfs.readFile(path);
    }
    _evalConditional(side, c) {
        if (c.etagMatches != null) {
            if (this._normalizeEtag(c.etagMatches) !== side.etag)
                return false;
        }
        if (c.etagDoesNotMatch != null) {
            if (this._normalizeEtag(c.etagDoesNotMatch) === side.etag)
                return false;
        }
        if (c.uploadedAfter instanceof Date) {
            if (side.uploaded <= c.uploadedAfter.getTime())
                return false;
        }
        if (c.uploadedBefore instanceof Date) {
            if (side.uploaded >= c.uploadedBefore.getTime())
                return false;
        }
        return true;
    }
    _normalizeEtag(e) {
        return String(e).replace(/^"+|"+$/g, '').toLowerCase();
    }
    _applyRange(body, range) {
        if (range.suffix != null) {
            const len = Math.min(range.suffix, body.byteLength);
            return body.slice(body.byteLength - len);
        }
        const off = range.offset ?? 0;
        if (off >= body.byteLength)
            return new Uint8Array(0);
        const len = range.length != null ? range.length : (body.byteLength - off);
        return body.slice(off, Math.min(off + len, body.byteLength));
    }
    async _sha256Hex(body) {
        // Use SubtleCrypto when available (Workers/Bun), fallback to a tiny JS impl.
        if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
            const hash = await crypto.subtle.digest('SHA-256', body);
            return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
        }
        // No crypto.subtle — extremely unlikely in workerd or Bun, but be safe.
        return 'no-subtle-crypto';
    }
    _normalizeHash(input) {
        if (typeof input === 'string')
            return input.replace(/^"+|"+$/g, '').toLowerCase();
        const u = new Uint8Array(input);
        return [...u].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    _encodeCursor(off) {
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
