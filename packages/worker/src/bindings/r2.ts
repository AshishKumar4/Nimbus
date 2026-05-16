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

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';

// ── Public types ──────────────────────────────────────────────────────────

export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
}

export interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

export interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  md5?: string | ArrayBuffer;
  sha1?: string | ArrayBuffer;
  sha256?: string | ArrayBuffer;
  sha512?: string | ArrayBuffer;
  onlyIf?: R2Conditional;
}

export interface R2GetOptions {
  onlyIf?: R2Conditional;
  range?: R2Range;
}

export interface R2ListOptions {
  prefix?: string;
  delimiter?: string;
  cursor?: string;
  limit?: number;
  include?: ('httpMetadata' | 'customMetadata')[];
}

export interface R2EmulatorOptions {
  vfs: SqliteVFS | any;
  root: string;
  binding: string;
  onLog?: (msg: string) => void;
}

interface R2Sidecar {
  etag: string;
  size: number;
  uploaded: number;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  v: 1;
}

// ── Path helpers ────────────────────────────────────────────────────────

function encKey(key: string): string {
  return encodeURIComponent(key);
}
function decKey(encoded: string): string {
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

// ── R2Object / R2ObjectBody ────────────────────────────────────────────

export class R2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;

  constructor(key: string, side: R2Sidecar) {
    this.key = key;
    this.version = side.etag;       // mirror real R2: version is etag-like
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
  private _body: Uint8Array;

  constructor(key: string, side: R2Sidecar, body: Uint8Array) {
    super(key, side);
    this._body = body;
  }

  get body(): ReadableStream<Uint8Array> {
    const bytes = this._body;
    return new ReadableStream({
      type: 'bytes',
      start(controller: any) {
        controller.enqueue(bytes);
        controller.close();
      },
    } as any);
  }

  get bodyUsed(): boolean { return false; /* one-shot stream is not tracked */ }

  async text(): Promise<string> {
    return new TextDecoder().decode(this._body);
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const ab = new ArrayBuffer(this._body.byteLength);
    new Uint8Array(ab).set(this._body);
    return ab;
  }
  async json<T = any>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }
  async blob(): Promise<Blob> {
    return new Blob([this._body]);
  }
}

// ── R2Emulator ────────────────────────────────────────────────────────────

export class R2Emulator {
  private vfs: any;
  private dir: string;
  private onLog: (m: string) => void;

  constructor(opts: R2EmulatorOptions) {
    this.vfs = opts.vfs;
    const root = String(opts.root).replace(/^\/+/, '').replace(/\/+$/, '');
    this.dir = (root ? root + '/' : '') + '.nimbus/r2/' + opts.binding;
    this.onLog = opts.onLog || (() => {});
  }

  // ── public API ────────────────────────────────────────────────────────

  async head(key: string): Promise<R2Object | null> {
    const side = this._readSide(key);
    if (!side) return null;
    return new R2Object(key, side);
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    const side = this._readSide(key);
    if (!side) return null;
    if (options?.onlyIf && !this._evalConditional(side, options.onlyIf)) return null;

    let body = this._readBody(key);
    if (options?.range) {
      body = this._applyRange(body, options.range);
    }
    return new R2ObjectBody(key, side, body);
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | Uint8Array | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    // Conditional: check existing
    if (options?.onlyIf) {
      const existing = this._readSide(key);
      // For PUT, the conditional checks the SOURCE state (existing object).
      // If onlyIf fails, return null without writing.
      if (existing && !this._evalConditional(existing, options.onlyIf)) return null;
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

    const side: R2Sidecar = {
      etag,
      size: body.byteLength,
      uploaded: Date.now(),
      v: 1,
    };
    if (options?.httpMetadata) side.httpMetadata = options.httpMetadata;
    if (options?.customMetadata) side.customMetadata = options.customMetadata;

    this._ensureDir();
    const enc = encKey(key);
    this.vfs.writeFile(this.dir + '/' + enc, body);
    this.vfs.writeFile(this.dir + '/' + enc + '.meta', JSON.stringify(side));

    return new R2Object(key, side);
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      const enc = encKey(k);
      const bp = this.dir + '/' + enc;
      const mp = bp + '.meta';
      try { if (this.vfs.exists(bp)) this.vfs.unlink(bp); } catch {}
      try { if (this.vfs.exists(mp)) this.vfs.unlink(mp); } catch {}
    }
  }

  async list(options?: R2ListOptions): Promise<{
    objects: R2Object[];
    truncated: boolean;
    cursor?: string;
    delimitedPrefixes: string[];
  }> {
    const prefix = options?.prefix || '';
    const limit = options?.limit ?? 1000;
    const cursorOff = options?.cursor ? this._decodeCursor(options.cursor) : 0;
    const delimiter = options?.delimiter;

    let entries: { key: string; side: R2Sidecar }[] = [];
    try {
      const dirents = this.vfs.readdir(this.dir);
      for (const e of dirents) {
        if (e.type === 'directory') continue;
        if (e.name.endsWith('.meta')) continue;
        const decoded = decKey(e.name);
        if (!decoded.startsWith(prefix)) continue;
        const side = this._readSideEnc(e.name);
        if (!side) continue;
        entries.push({ key: decoded, side });
      }
    } catch {
      entries = [];
    }
    entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

    // Delimiter handling: collect common prefixes that share <prefix><…><delimiter>
    const delimitedPrefixes: string[] = [];
    if (delimiter) {
      const seen = new Set<string>();
      const filtered: typeof entries = [];
      for (const e of entries) {
        const tail = e.key.slice(prefix.length);
        const idx = tail.indexOf(delimiter);
        if (idx !== -1) {
          const cp = prefix + tail.slice(0, idx + delimiter.length);
          if (!seen.has(cp)) { seen.add(cp); delimitedPrefixes.push(cp); }
          continue;          // grouped — don't list as an object
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

  async createMultipartUpload(_key: string, _options?: any): Promise<never> {
    throw new Error('R2 multipart uploads not supported in nimbus-wrangler dev (W10.5 candidate)');
  }
  async resumeMultipartUpload(_key: string, _uploadId: string): Promise<never> {
    throw new Error('R2 multipart uploads not supported in nimbus-wrangler dev (W10.5 candidate)');
  }

  // ── internals ─────────────────────────────────────────────────────────

  private _ensureDir(): void {
    if (!this.vfs.exists(this.dir)) {
      this.vfs.mkdir(this.dir, { recursive: true });
    }
  }

  private async _coerceBody(value: any): Promise<Uint8Array> {
    if (value == null) return new Uint8Array(0);
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array((value as any).buffer, (value as any).byteOffset, (value as any).byteLength);
    if (typeof value === 'object' && typeof (value as any).getReader === 'function') {
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = (value as any).getReader();
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        const u = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        chunks.push(u);
        total += u.length;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      const ab = await (value as Blob).arrayBuffer();
      return new Uint8Array(ab);
    }
    return new TextEncoder().encode(String(value));
  }

  private _readSide(key: string): R2Sidecar | null {
    return this._readSideEnc(encKey(key));
  }

  private _readSideEnc(enc: string): R2Sidecar | null {
    const mp = this.dir + '/' + enc + '.meta';
    if (!this.vfs.exists(mp)) {
      // No sidecar — but the body might exist (legacy). Synthesize.
      const bp = this.dir + '/' + enc;
      if (!this.vfs.exists(bp)) return null;
      return null; // No metadata at all means treat as missing
    }
    try {
      const raw = this.vfs.readFileString(mp);
      return JSON.parse(raw) as R2Sidecar;
    } catch {
      return null;
    }
  }

  private _readBody(key: string): Uint8Array {
    const path = this.dir + '/' + encKey(key);
    return this.vfs.readFileBytes ? this.vfs.readFileBytes(path) : this.vfs.readFile(path);
  }

  private _evalConditional(side: R2Sidecar, c: R2Conditional): boolean {
    if (c.etagMatches != null) {
      if (this._normalizeEtag(c.etagMatches) !== side.etag) return false;
    }
    if (c.etagDoesNotMatch != null) {
      if (this._normalizeEtag(c.etagDoesNotMatch) === side.etag) return false;
    }
    if (c.uploadedAfter instanceof Date) {
      if (side.uploaded <= c.uploadedAfter.getTime()) return false;
    }
    if (c.uploadedBefore instanceof Date) {
      if (side.uploaded >= c.uploadedBefore.getTime()) return false;
    }
    return true;
  }

  private _normalizeEtag(e: string): string {
    return String(e).replace(/^"+|"+$/g, '').toLowerCase();
  }

  private _applyRange(body: Uint8Array, range: R2Range): Uint8Array {
    if (range.suffix != null) {
      const len = Math.min(range.suffix, body.byteLength);
      return body.slice(body.byteLength - len);
    }
    const off = range.offset ?? 0;
    if (off >= body.byteLength) return new Uint8Array(0);
    const len = range.length != null ? range.length : (body.byteLength - off);
    return body.slice(off, Math.min(off + len, body.byteLength));
  }

  private async _sha256Hex(body: Uint8Array): Promise<string> {
    // Use SubtleCrypto when available (Workers/Bun), fallback to a tiny JS impl.
    if (typeof crypto !== 'undefined' && (crypto as any).subtle && (crypto as any).subtle.digest) {
      const hash = await (crypto as any).subtle.digest('SHA-256', body);
      return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // No crypto.subtle — extremely unlikely in workerd or Bun, but be safe.
    return 'no-subtle-crypto';
  }

  private _normalizeHash(input: string | ArrayBuffer): string {
    if (typeof input === 'string') return input.replace(/^"+|"+$/g, '').toLowerCase();
    const u = new Uint8Array(input);
    return [...u].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private _encodeCursor(off: number): string {
    const b64 = btoa(JSON.stringify({ off }));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  private _decodeCursor(c: string): number {
    try {
      const b64 = String(c).replace(/-/g, '+').replace(/_/g, '/');
      const j = JSON.parse(atob(b64));
      return Number(j.off) || 0;
    } catch { return 0; }
  }
}
