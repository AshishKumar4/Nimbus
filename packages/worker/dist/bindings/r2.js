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
import { bodyStream, coerceBindingBody, ensureBindingDir } from './body.js';
import { cursorPage, listObjectFiles, objectFileName, objectStoreDir, removeObjectFiles } from './object-store.js';
import { sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';
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
        return bodyStream(this._body);
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
        this.dir = objectStoreDir(opts.root, 'r2', opts.binding);
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
        const body = await coerceBindingBody(value);
        const etag = await sha256Hex(body);
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
        ensureBindingDir(this.vfs, this.dir);
        const enc = objectFileName(key);
        this.vfs.writeFile(this.dir + '/' + enc, body);
        this.vfs.writeFile(this.dir + '/' + enc + '.meta', JSON.stringify(side));
        return new R2Object(key, side);
    }
    async delete(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list)
            removeObjectFiles(this.vfs, this.dir, objectFileName(k));
    }
    async list(options) {
        const prefix = options?.prefix || '';
        const delimiter = options?.delimiter;
        let entries = [];
        for (const { key, fileName } of listObjectFiles(this.vfs, this.dir, prefix)) {
            const side = this._readSideEnc(fileName);
            if (side)
                entries.push({ key, side });
        }
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
        const { page, next } = cursorPage(entries, options?.cursor, options?.limit ?? 1000);
        return {
            objects: page.map(e => new R2Object(e.key, e.side)),
            truncated: next !== undefined,
            ...(next !== undefined ? { cursor: next } : {}),
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
    _readSide(key) {
        return this._readSideEnc(objectFileName(key));
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
        const path = this.dir + '/' + objectFileName(key);
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
    _normalizeHash(input) {
        if (typeof input === 'string')
            return input.replace(/^"+|"+$/g, '').toLowerCase();
        const u = new Uint8Array(input);
        return [...u].map(b => b.toString(16).padStart(2, '0')).join('');
    }
}
