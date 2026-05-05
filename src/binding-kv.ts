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

import type { SqliteVFS } from './sqlite-vfs.js';

export interface KvEmulatorOptions {
  vfs: SqliteVFS | any;     // any to allow the mock VFS in unit tests
  root: string;             // project root, e.g. 'home/user'
  binding: string;          // wrangler.jsonc kv_namespaces[].binding
  onLog: (msg: string) => void;
}

export interface KvPutOptions {
  expiration?: number;       // unix seconds, absolute
  expirationTtl?: number;    // seconds from now
  metadata?: any;
}

export interface KvGetOptions {
  type?: 'text' | 'json' | 'arrayBuffer' | 'stream';
  cacheTtl?: number;         // accepted, ignored
}

export interface KvListOptions {
  prefix?: string;
  limit?: number;            // default 1000 in real KV
  cursor?: string;
}

export interface KvListResult {
  keys: { name: string; expiration?: number; metadata?: any }[];
  list_complete: boolean;
  cursor?: string;
  cacheStatus: string | null;
}

interface KvMeta {
  exp?: number;
  meta?: any;
  v: 1;
}

// ── Test seam: clock ────────────────────────────────────────────────────

let _kvNow: () => number = () => Math.floor(Date.now() / 1000);
export function _setKvNow(fn: () => number): void { _kvNow = fn; }

// ── Path helpers ────────────────────────────────────────────────────────

function encKey(key: string): string {
  // Match KV's accepted key alphabet: any UTF-8 string up to 512 bytes. We
  // URL-encode to make every key VFS-path-safe.
  return encodeURIComponent(key);
}

function decKey(encoded: string): string {
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

// ── KvEmulator ─────────────────────────────────────────────────────────

export class KvEmulator {
  private vfs: any;
  private dir: string;
  private metaCache = new Map<string, KvMeta>();
  private onLog: (m: string) => void;

  constructor(opts: KvEmulatorOptions) {
    this.vfs = opts.vfs;
    const root = String(opts.root).replace(/^\/+/, '').replace(/\/+$/, '');
    this.dir = (root ? root + '/' : '') + '.nimbus/kv/' + opts.binding;
    this.onLog = opts.onLog || (() => {});
  }

  // ── public API ────────────────────────────────────────────────────────

  async get(key: string, options?: KvGetOptions | string): Promise<any> {
    const opts: KvGetOptions = typeof options === 'string' ? { type: options as KvGetOptions['type'] } : (options || {});
    const r = await this._readResolved(key);
    if (r == null) return null;
    return this._project(r.body, opts.type);
  }

  async getWithMetadata<T = unknown>(
    key: string,
    options?: KvGetOptions | string,
  ): Promise<{ value: any; metadata: T | null; cacheStatus: string | null }> {
    const opts: KvGetOptions = typeof options === 'string' ? { type: options as KvGetOptions['type'] } : (options || {});
    const r = await this._readResolved(key);
    if (r == null) return { value: null, metadata: null, cacheStatus: null };
    const value = this._project(r.body, opts.type);
    return { value, metadata: (r.meta?.meta ?? null) as T | null, cacheStatus: null };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream | Uint8Array | null,
    options?: KvPutOptions,
  ): Promise<void> {
    const enc = encKey(key);
    const bodyBlob = await this._coerceBody(value);
    this._ensureDir();
    this.vfs.writeFile(this.dir + '/' + enc, bodyBlob);

    // Build sidecar
    const meta: KvMeta = { v: 1 };
    if (options?.expiration != null) meta.exp = options.expiration;
    else if (options?.expirationTtl != null) meta.exp = _kvNow() + options.expirationTtl;
    if (options?.metadata !== undefined) meta.meta = options.metadata;

    const metaPath = this.dir + '/' + enc + '.meta';
    if (meta.exp != null || meta.meta !== undefined) {
      this.vfs.writeFile(metaPath, JSON.stringify(meta));
      this.metaCache.set(enc, meta);
    } else {
      // Overwrite-without-metadata clears the sidecar (per probe contract:
      // 'overwrite WITHOUT metadata clears metadata').
      try { if (this.vfs.exists(metaPath)) this.vfs.unlink(metaPath); } catch {}
      this.metaCache.delete(enc);
    }
  }

  async delete(key: string): Promise<void> {
    const enc = encKey(key);
    const bp = this.dir + '/' + enc;
    const mp = bp + '.meta';
    try { if (this.vfs.exists(bp)) this.vfs.unlink(bp); } catch {}
    try { if (this.vfs.exists(mp)) this.vfs.unlink(mp); } catch {}
    this.metaCache.delete(enc);
  }

  async list(options?: KvListOptions): Promise<KvListResult> {
    const prefix = options?.prefix || '';
    const limit = options?.limit ?? 1000;
    const cursorOff = options?.cursor ? this._decodeCursor(options.cursor) : 0;

    let entries: { name: string; expiration?: number; metadata?: any }[] = [];
    try {
      const dirents = this.vfs.readdir(this.dir);
      for (const e of dirents) {
        if (e.type === 'directory') continue;
        if (e.name.endsWith('.meta')) continue;
        const decoded = decKey(e.name);
        if (!decoded.startsWith(prefix)) continue;
        const meta = this._readMeta(e.name);
        // Skip expired
        if (meta?.exp != null && meta.exp <= _kvNow()) {
          this._lazyDelete(e.name);
          continue;
        }
        const out: { name: string; expiration?: number; metadata?: any } = { name: decoded };
        if (meta?.exp != null) out.expiration = meta.exp;
        if (meta?.meta !== undefined) out.metadata = meta.meta;
        entries.push(out);
      }
    } catch {
      // Empty dir: no keys
      entries = [];
    }

    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

    const slice = entries.slice(cursorOff, cursorOff + limit);
    const next = cursorOff + slice.length;
    const list_complete = next >= entries.length;

    const out: KvListResult = {
      keys: slice,
      list_complete,
      cacheStatus: null,
    };
    if (!list_complete) out.cursor = this._encodeCursor(next);
    return out;
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
      // ReadableStream — drain
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
    // Fallback — try toString
    return new TextEncoder().encode(String(value));
  }

  private _project(body: Uint8Array, type: KvGetOptions['type']): any {
    const t = type || 'text';
    if (t === 'text') return new TextDecoder().decode(body);
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
        start(controller: any) {
          controller.enqueue(u);
          controller.close();
        },
      } as any);
    }
    return new TextDecoder().decode(body);
  }

  private async _readResolved(key: string): Promise<{ body: Uint8Array; meta: KvMeta | null } | null> {
    const enc = encKey(key);
    const path = this.dir + '/' + enc;
    if (!this.vfs.exists(path)) return null;
    const meta = this._readMeta(enc);
    if (meta?.exp != null && meta.exp <= _kvNow()) {
      this._lazyDelete(enc);
      return null;
    }
    const body = this.vfs.readFileBytes ? this.vfs.readFileBytes(path) : this.vfs.readFile(path);
    return { body, meta };
  }

  private _readMeta(encName: string): KvMeta | null {
    if (this.metaCache.has(encName)) return this.metaCache.get(encName)!;
    const mp = this.dir + '/' + encName + '.meta';
    if (!this.vfs.exists(mp)) return null;
    try {
      const raw = this.vfs.readFileString(mp);
      const m = JSON.parse(raw) as KvMeta;
      this.metaCache.set(encName, m);
      return m;
    } catch (e) {
      // Torn meta — treat as absent
      return null;
    }
  }

  private _lazyDelete(encName: string): void {
    const bp = this.dir + '/' + encName;
    const mp = bp + '.meta';
    try { if (this.vfs.exists(bp)) this.vfs.unlink(bp); } catch {}
    try { if (this.vfs.exists(mp)) this.vfs.unlink(mp); } catch {}
    this.metaCache.delete(encName);
  }

  private _encodeCursor(off: number): string {
    // base64url-encode the offset record. We use btoa (Web Standard,
    // available in workerd and Bun) and patch base64 → base64url.
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
