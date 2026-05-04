/**
 * node-shims.ts — Nimbus v2.0 Node.js runtime shims for dynamic workers.
 *
 * Generates a raw JS string embedded in facet code. Provides:
 *   - fs: full sync/async/promises/streams VFS-backed filesystem
 *   - path: complete POSIX path operations
 *   - os/process: Linux edge environment simulation
 *   - Buffer: Uint8Array wrapper with encoding support
 *   - events: full EventEmitter
 *   - stream: real Readable/Writable/Transform/Duplex with backpressure
 *   - crypto: createHash (FNV-1a sync, SubtleCrypto async), randomBytes/UUID
 *   - zlib: real gzip/gunzip/deflate via CompressionStream/DecompressionStream
 *   - dns: real DNS resolution via Cloudflare DNS-over-HTTPS
 *   - http: virtual server with port registry for supervisor routing
 *   - https: fetch()-backed request/get
 *   - net: Socket/Server with connect/write/end
 *   - child_process: ChildProcess objects (execution requires supervisor RPC)
 *   - assert, util, url, querystring, string_decoder, readline, tty, timers
 *
 * VFS access: reads from __vfsBundle (pre-bundled by FacetManager),
 * writes to __vfsWrites (flushed back to VFS on completion).
 */

/**
 * Generate the shared shim block that goes inside both the DO-facet and
 * entrypoint runner code.  The returned string is raw JS (no wrapping).
 *
 * At runtime the following variables must exist in scope:
 *   - __vfsBundle: Record<string, string>  (path→utf8 content)
 *   - __vfsWrites: Record<string, string>  (written files, returned in result)
 *   - __vfsDirs:   Record<string, boolean> (dirs created)
 *   - __vfsBaseUrl: string                 (supervisor URL for lazy VFS reads)
 *   - cwd: string
 *   - argv, env, filename, dirname: from args
 *   - stdout, stderr, exitCode: capture variables
 */
import { generateStreamsCode } from './streams.js';
import { getExportsResolverJS } from './_shared/exports-resolver.js';

const STREAMS_CODE = generateStreamsCode();
const EXPORTS_RESOLVER_JS = getExportsResolverJS();

export function generateShimsCode(): string {
  return `
// ═══════════════════════════════════════════════════════════════════════
// ──  Format helper ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
function __fmt(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

// ═══════════════════════════════════════════════════════════════════════
// ──  path module ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __pathMod = (() => {
  function normalize(p) {
    const parts = p.split("/");
    const out = [];
    for (const s of parts) {
      if (s === "..") { if (out.length && out[out.length-1] !== "..") out.pop(); else out.push(s); }
      else if (s !== "." && s !== "") out.push(s);
    }
    return (p.startsWith("/") ? "/" : "") + out.join("/");
  }
  function join(...p) { return normalize(p.join("/")); }
  function resolve(...p) {
    let r = "";
    for (let i = p.length - 1; i >= 0; i--) {
      r = p[i] + (r ? "/" + r : "");
      if (r.startsWith("/")) break;
    }
    if (!r.startsWith("/")) r = (cwd || "/home/user") + "/" + r;
    return normalize(r);
  }
  function dirname(p) { const i = p.lastIndexOf("/"); return i > 0 ? p.substring(0, i) : i === 0 ? "/" : "."; }
  function basename(p, ext) { const b = p.split("/").pop() || ""; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; }
  function extname(p) { const b = basename(p); const i = b.lastIndexOf("."); return i > 0 ? b.substring(i) : ""; }
  function isAbsolute(p) { return p.startsWith("/"); }
  function relative(from, to) {
    const f = resolve(from).split("/").filter(Boolean);
    const t = resolve(to).split("/").filter(Boolean);
    let c = 0;
    while (c < f.length && c < t.length && f[c] === t[c]) c++;
    return [...Array(f.length - c).fill(".."), ...t.slice(c)].join("/") || ".";
  }
  return { join, resolve, dirname, basename, extname, normalize, isAbsolute, relative, sep: "/", delimiter: ":", posix: null };
})();
__pathMod.posix = __pathMod;

// ═══════════════════════════════════════════════════════════════════════
// ──  Buffer shim ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __BufferMod = (() => {
  const _enc = new TextEncoder();
  const _dec = new TextDecoder();

  function from(d, encoding) {
    if (typeof d === "string") {
      if (encoding === "base64") {
        const bin = atob(d); const a = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        return _wrap(a);
      }
      if (encoding === "hex") {
        const a = new Uint8Array(d.length / 2);
        for (let i = 0; i < a.length; i++) a[i] = parseInt(d.substr(i*2, 2), 16);
        return _wrap(a);
      }
      return _wrap(_enc.encode(d));
    }
    if (d instanceof Uint8Array) return _wrap(new Uint8Array(d));
    if (d instanceof ArrayBuffer) return _wrap(new Uint8Array(d));
    if (Array.isArray(d)) return _wrap(new Uint8Array(d));
    return _wrap(new Uint8Array(0));
  }

  function alloc(n, fill) { const a = new Uint8Array(n); if (fill !== undefined) a.fill(typeof fill === "number" ? fill : 0); return _wrap(a); }
  function isBuffer(o) { return o instanceof Uint8Array && typeof o.toString === "function" && o.__isBuffer; }
  function concat(bufs, len) {
    const total = len ?? bufs.reduce((s, b) => s + b.length, 0);
    const r = new Uint8Array(total); let off = 0;
    for (const b of bufs) { r.set(b.subarray(0, Math.min(b.length, total - off)), off); off += b.length; if (off >= total) break; }
    return _wrap(r);
  }
  function _wrap(u8) {
    u8.__isBuffer = true;
    u8.toString = function(encoding) {
      if (!encoding || encoding === "utf8" || encoding === "utf-8") return _dec.decode(this);
      if (encoding === "base64") { let s = ""; for (const b of this) s += String.fromCharCode(b); return btoa(s); }
      if (encoding === "hex") { let s = ""; for (const b of this) s += b.toString(16).padStart(2, "0"); return s; }
      return _dec.decode(this);
    };
    u8.write = function(str, off, len, enc) { const b = _enc.encode(str); this.set(b.subarray(0, len || b.length), off || 0); return Math.min(b.length, len || b.length); };
    u8.slice = function(s, e) { return _wrap(this.subarray(s, e)); };
    u8.copy = function(t, tOff, sOff, sEnd) { t.set(this.subarray(sOff || 0, sEnd), tOff || 0); };
    u8.equals = function(o) { if (this.length !== o.length) return false; for (let i = 0; i < this.length; i++) if (this[i] !== o[i]) return false; return true; };
    u8.toJSON = function() { return { type: "Buffer", data: Array.from(this) }; };
    u8.indexOf = function(v) { if (typeof v === "number") return Uint8Array.prototype.indexOf.call(this, v); const b = typeof v === "string" ? _enc.encode(v) : v; outer: for (let i = 0; i <= this.length - b.length; i++) { for (let j = 0; j < b.length; j++) if (this[i+j] !== b[j]) continue outer; return i; } return -1; };
    return u8;
  }
  const B = Object.assign(from, { from, alloc, isBuffer, concat, byteLength: (s, e) => _enc.encode(s).length });
  return B;
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  fs shim (VFS-backed) ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __fsMod = (() => {
  const _enc = new TextEncoder();
  const _dec = new TextDecoder();

  // ── helpers ──
  function _strip(p) { return String(p).replace(/^\\/+/, ""); }
  function _resolve(p) {
    const s = String(p);
    if (s.startsWith("/")) return __pathMod.normalize(s);
    return __pathMod.resolve(cwd || "/home/user", s);
  }

  // ── VFS bundle lookup (fast path — in-memory) ──
  function _bundleLookup(absPath) {
    const k = _strip(absPath);
    if (__vfsBundle && k in __vfsBundle) return __vfsBundle[k];
    // Also check writes
    if (__vfsWrites && k in __vfsWrites) return __vfsWrites[k];
    return undefined;
  }

  // ── readFileSync ──
  function readFileSync(p, opts) {
    const absPath = _resolve(p);
    const content = _bundleLookup(absPath);
    if (content === undefined) {
      const err = new Error("ENOENT: no such file or directory, open '" + p + "'");
      err.code = "ENOENT";
      err.errno = -2;
      throw err;
    }
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    if (encoding === "utf8" || encoding === "utf-8" || encoding === "utf8") return content;
    if (encoding) return content; // treat all text encodings the same
    return __BufferMod.from(content);
  }

  // ── writeFileSync ──
  function writeFileSync(p, data, opts) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    const str = typeof data === "string" ? data : (data instanceof Uint8Array ? _dec.decode(data) : String(data));
    __vfsWrites[k] = str;
    // Also update bundle so subsequent reads see the write
    if (__vfsBundle) __vfsBundle[k] = str;
  }

  // ── appendFileSync ──
  function appendFileSync(p, data, opts) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    const existing = _bundleLookup(absPath) || "";
    const str = typeof data === "string" ? data : (data instanceof Uint8Array ? _dec.decode(data) : String(data));
    __vfsWrites[k] = existing + str;
    if (__vfsBundle) __vfsBundle[k] = existing + str;
  }

  // ── existsSync ──
  function existsSync(p) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    if (__vfsBundle && k in __vfsBundle) return true;
    if (__vfsWrites && k in __vfsWrites) return true;
    if (__vfsDirs && k in __vfsDirs) return true;
    // W2.5b root-cause fix: consult the manifest BEFORE falling back to
    // the O(N) bundle-prefix scan. The manifest is uncapped and always
    // reflects the real directory shape, even when the file content for
    // a directory's contents was excluded by the 4 MiB / 500-file content
    // bundle cap. (facet-manager.ts:453, audit/sections/W2.5-rootcause.md)
    if (__vfsManifest) {
      if (k in __vfsManifest) return true;
      // Path may be a file listed by its parent's manifest entry.
      const slash = k.lastIndexOf("/");
      const parent = slash >= 0 ? k.slice(0, slash) : "";
      const name = slash >= 0 ? k.slice(slash + 1) : k;
      const sib = __vfsManifest[parent];
      if (sib && sib.indexOf(name) !== -1) return true;
    }
    // Last-resort: bundle dir entries
    if (__vfsBundle) {
      const prefix = k + "/";
      for (const bk in __vfsBundle) { if (bk.startsWith(prefix) || bk === k) return true; }
    }
    return false;
  }

  // ── statSync ──
  function statSync(p) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    // Check if it's a known directory written this exec session
    if (__vfsDirs && k in __vfsDirs) {
      return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, mtime: new Date(), mode: 0o755 };
    }
    // W2.5b: consult uncapped manifest first for directory shape.
    if (__vfsManifest && k in __vfsManifest) {
      return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, mtime: new Date(), mode: 0o755 };
    }
    // File with content embedded?
    const content = _bundleLookup(absPath);
    if (content !== undefined) {
      const size = _enc.encode(content).length;
      return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size, mtime: new Date(), mode: 0o644 };
    }
    // File listed in parent's manifest but content was capped out — return
    // a zero-size file stat so callers like fs.stat / fs.statSync see the
    // file as present (downstream readFileSync will surface ENOENT if it
    // actually tries to read content; many consumers only need stat).
    if (__vfsManifest) {
      const slash = k.lastIndexOf("/");
      const parent = slash >= 0 ? k.slice(0, slash) : "";
      const name = slash >= 0 ? k.slice(slash + 1) : k;
      const sib = __vfsManifest[parent];
      if (sib && sib.indexOf(name) !== -1) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 0, mtime: new Date(), mode: 0o644 };
      }
    }
    // Last-resort: bundle prefix scan (legacy path).
    if (__vfsBundle) {
      const prefix = k + "/";
      for (const bk in __vfsBundle) {
        if (bk.startsWith(prefix)) {
          return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, mtime: new Date(), mode: 0o755 };
        }
      }
    }
    const err = new Error("ENOENT: no such file or directory, stat '" + p + "'");
    err.code = "ENOENT"; err.errno = -2;
    throw err;
  }

  // ── lstatSync (alias for statSync in our VFS — no symlinks) ──
  function lstatSync(p) { return statSync(p); }

  // ── readdirSync ──
  // W2.5b root-cause fix: prefer the uncapped __vfsManifest for directory
  // listings. The legacy bundle-prefix scan is kept as a fallback for paths
  // not in the manifest (e.g. dirs created at exec time via mkdirSync) and
  // is unioned with __vfsWrites so newly-written files become visible.
  // (facet-manager.ts:453, audit/sections/W2.5-rootcause.md)
  function readdirSync(p, opts) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    const prefix = k ? k + "/" : "";
    const names = new Set();
    // 1. Manifest-supplied children (the authoritative source for installed pkgs).
    if (__vfsManifest && k in __vfsManifest) {
      for (const n of __vfsManifest[k]) names.add(n);
    }
    // 2. Bundle-prefix fallback (covers older paths or runtime-mkdir'd ones
    //    that aren't in the manifest yet).
    if (__vfsBundle) {
      for (const bk in __vfsBundle) {
        if (bk.startsWith(prefix)) {
          const rest = bk.substring(prefix.length);
          const seg = rest.split("/")[0];
          if (seg) names.add(seg);
        }
      }
    }
    // 3. Files written during this exec session.
    if (__vfsWrites) {
      for (const wk in __vfsWrites) {
        if (wk.startsWith(prefix)) {
          const rest = wk.substring(prefix.length);
          const seg = rest.split("/")[0];
          if (seg) names.add(seg);
        }
      }
    }
    // 4. Dirs created during this exec session.
    if (__vfsDirs) {
      for (const dk in __vfsDirs) {
        if (dk.startsWith(prefix)) {
          const rest = dk.substring(prefix.length);
          const seg = rest.split("/")[0];
          if (seg) names.add(seg);
        }
      }
    }
    const arr = [...names].sort();
    if (opts?.withFileTypes) {
      return arr.map(n => {
        const fp = prefix + n;
        // Manifest is the definitive isDir source; fall back to bundle scan.
        const isDir =
          (!!__vfsManifest && fp in __vfsManifest) ||
          (!!__vfsDirs && fp in __vfsDirs) ||
          (!!__vfsBundle && Object.keys(__vfsBundle).some(bk => bk.startsWith(fp + "/")));
        return { name: n, isFile: () => !isDir, isDirectory: () => isDir, isSymbolicLink: () => false };
      });
    }
    return arr;
  }

  // ── mkdirSync ──
  function mkdirSync(p, opts) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    if (opts?.recursive) {
      const parts = k.split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) { cur = cur ? cur + "/" + part : part; __vfsDirs[cur] = true; }
    } else {
      __vfsDirs[k] = true;
    }
  }

  // ── unlinkSync ──
  function unlinkSync(p) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    if (__vfsBundle) delete __vfsBundle[k];
    if (__vfsWrites) delete __vfsWrites[k];
  }

  // ── rmdirSync ──
  function rmdirSync(p) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    if (__vfsDirs) delete __vfsDirs[k];
  }

  // ── renameSync ──
  function renameSync(oldP, newP) {
    const oldK = _strip(_resolve(oldP));
    const newK = _strip(_resolve(newP));
    const content = __vfsBundle?.[oldK] ?? __vfsWrites?.[oldK];
    if (content !== undefined) {
      __vfsWrites[newK] = content;
      if (__vfsBundle) { __vfsBundle[newK] = content; delete __vfsBundle[oldK]; }
      if (__vfsWrites) delete __vfsWrites[oldK];
    }
  }

  // ── copyFileSync ──
  function copyFileSync(src, dest) {
    writeFileSync(dest, readFileSync(src, "utf8"));
  }

  // ── Async variants (thin wrappers returning via callback) ──
  function readFile(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    try { const r = readFileSync(p, opts); if (cb) cb(null, r); } catch (e) { if (cb) cb(e); }
  }
  function writeFile(p, d, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    try { writeFileSync(p, d, opts); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
  }
  function stat(p, cb) { try { cb(null, statSync(p)); } catch (e) { cb(e); } }
  function readdir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    try { cb(null, readdirSync(p, opts)); } catch (e) { cb(e); }
  }
  function exists(p, cb) { cb(existsSync(p)); }
  function mkdir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    try { mkdirSync(p, opts); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
  }
  function unlink(p, cb) { try { unlinkSync(p); if (cb) cb(null); } catch (e) { if (cb) cb(e); } }
  function access(p, mode, cb) {
    if (typeof mode === "function") { cb = mode; mode = undefined; }
    if (existsSync(p)) cb(null); else { const e = new Error("ENOENT"); e.code = "ENOENT"; cb(e); }
  }

  // ── FileHandle (W3) — returned from fs.promises.open ──
  // VFS-backed minimal impl: read, write, readFile, writeFile, stat,
  // truncate, close, asyncDispose. Sufficient for puppeteer-core,
  // graceful-fs, and most module-level fs.promises.open patterns.
  class __FileHandle {
    constructor(path, flags) { this._path = path; this._flags = flags || 'r'; this._closed = false; this.fd = 0; }
    async read(buffer, offset, length, position) {
      const absPath = _resolve(this._path);
      const data = _bundleLookup(absPath);
      if (data === undefined) {
        const e = new Error("ENOENT: no such file, read '" + this._path + "'");
        e.code = "ENOENT"; throw e;
      }
      const buf = typeof data === "string" ? _enc.encode(data) : data;
      const start = position || 0;
      const slice = buf.subarray(start, start + (length || (buf.length - start)));
      buffer.set(slice, offset || 0);
      return { bytesRead: slice.length, buffer };
    }
    async write(buffer, offset, length, position) {
      let chunk;
      if (typeof buffer === "string") chunk = buffer;
      else {
        const o = offset || 0;
        const l = length === undefined ? buffer.length - o : length;
        chunk = _dec.decode(buffer.subarray(o, o + l));
      }
      const existing = (() => { try { return readFileSync(this._path, "utf8"); } catch { return ""; } })();
      // Naive concat. Adequate for the small-file patterns in
      // puppeteer-core / graceful-fs; not a real positional write.
      writeFileSync(this._path, existing + chunk);
      return { bytesWritten: chunk.length, buffer };
    }
    async readFile(opts) { return readFileSync(this._path, opts); }
    async writeFile(data, opts) { writeFileSync(this._path, data, opts); }
    async appendFile(data, opts) { appendFileSync(this._path, data, opts); }
    async stat() { return statSync(this._path); }
    async truncate(len) {
      const cur = readFileSync(this._path, "utf8");
      writeFileSync(this._path, cur.slice(0, len || 0));
    }
    async chmod() {} async chown() {} async utimes() {} async sync() {} async datasync() {}
    async close() { this._closed = true; }
    [Symbol.asyncDispose]() { return this.close(); }
  }

  // ── promises namespace (W3: full surface, VFS-backed) ──
  // We can't forward to workerd's node:fs/promises because that operates
  // on a real-host filesystem, not our VFS. So every method is shim'd
  // against the same underlying readFileSync/writeFileSync/etc.
  const promises = {
    // pre-W3 surface:
    readFile: (p, o) => new Promise((res, rej) => readFile(p, o, (e, d) => e ? rej(e) : res(d))),
    writeFile: (p, d, o) => new Promise((res, rej) => writeFile(p, d, o, (e) => e ? rej(e) : res())),
    stat: (p) => new Promise((res, rej) => stat(p, (e, s) => e ? rej(e) : res(s))),
    readdir: (p, o) => new Promise((res, rej) => readdir(p, o, (e, d) => e ? rej(e) : res(d))),
    mkdir: (p, o) => new Promise((res, rej) => mkdir(p, o, (e) => e ? rej(e) : res())),
    unlink: (p) => new Promise((res, rej) => unlink(p, (e) => e ? rej(e) : res())),
    access: (p, m) => new Promise((res, rej) => access(p, m, (e) => e ? rej(e) : res())),

    // W3 additions:
    appendFile: async (p, d, o) => { appendFileSync(p, d, o); },
    lstat: (p) => new Promise((res, rej) => stat(p, (e, s) => e ? rej(e) : res(s))),
    rm: async (p, opts) => {
      const o = opts || {};
      const k = _strip(_resolve(p));
      const prefix = k + "/";
      if (o.recursive) {
        if (__vfsBundle) for (const bk of Object.keys(__vfsBundle)) if (bk === k || bk.startsWith(prefix)) delete __vfsBundle[bk];
        if (__vfsWrites) for (const wk of Object.keys(__vfsWrites)) if (wk === k || wk.startsWith(prefix)) delete __vfsWrites[wk];
        if (__vfsDirs) for (const dk of Object.keys(__vfsDirs)) if (dk === k || dk.startsWith(prefix)) delete __vfsDirs[dk];
      } else {
        try { unlinkSync(p); } catch (e) { if (!o.force) throw e; }
      }
    },
    cp: async (src, dest, opts) => {
      const o = opts || {};
      const srcAbs = _resolve(src);
      const srcK = _strip(srcAbs);
      const destK = _strip(_resolve(dest));
      const content = _bundleLookup(srcAbs);
      if (content !== undefined) { writeFileSync(dest, content); return; }
      if (!o.recursive) {
        const err = new Error("EISDIR: cp without recursive on directory: " + src);
        err.code = "EISDIR"; throw err;
      }
      // Recursive: copy every key under srcK/ to destK/
      const prefix = srcK + "/";
      const entries = [];
      if (__vfsBundle) for (const bk in __vfsBundle) if (bk.startsWith(prefix)) entries.push([bk, __vfsBundle[bk]]);
      if (__vfsWrites) for (const wk in __vfsWrites) if (wk.startsWith(prefix)) entries.push([wk, __vfsWrites[wk]]);
      // Ensure destination directory tree
      __vfsDirs[destK] = true;
      for (const [bk, v] of entries) {
        const newK = destK + "/" + bk.slice(prefix.length);
        __vfsWrites[newK] = v;
        if (__vfsBundle) __vfsBundle[newK] = v;
      }
    },
    copyFile: async (src, dest) => { copyFileSync(src, dest); },
    rename: async (oldP, newP) => { renameSync(oldP, newP); },
    rmdir: async (p) => { rmdirSync(p); },
    realpath: async (p) => __pathMod.resolve(String(p)),
    truncate: async (p, len) => {
      const cur = (() => { try { return readFileSync(p, "utf8"); } catch { return ""; } })();
      writeFileSync(p, cur.slice(0, len || 0));
    },
    chmod: async () => {}, chown: async () => {}, lchmod: async () => {}, lchown: async () => {},
    utimes: async () => {}, lutimes: async () => {},
    symlink: async () => {}, link: async () => {},
    readlink: async (p) => String(p),
    mkdtemp: async (prefix) => {
      const name = String(prefix) + Math.random().toString(36).slice(2, 10);
      mkdirSync(name, { recursive: true });
      return name;
    },
    open: async (path, flags, mode) => new __FileHandle(path, flags || 'r'),
    watch: async function* (filename, opts) {
      // Minimal async iter — polls _bundleLookup every 500ms and yields
      // a single \`change\` event when content differs. Adequate for
      // "wait for file to change" patterns; not a complete fsevents.
      const absPath = _resolve(filename);
      let last = _bundleLookup(absPath);
      while (true) {
        await new Promise(r => setTimeout(r, 500));
        const cur = _bundleLookup(absPath);
        if (cur !== last) {
          last = cur;
          yield { eventType: cur === undefined ? 'rename' : 'change', filename: __pathMod.basename(String(filename)) };
        }
      }
    },
    glob: async function* (pattern, opts) {
      // Minimal — yield matching files via prefix scan. Not full glob.
      // Sufficient for "**/*.js" style patterns; documented limitation.
      const root = (opts && opts.cwd) ? _strip(_resolve(opts.cwd)) : _strip(_resolve('.'));
      const re = (() => {
        // Convert simple glob to regex: ** -> .*, * -> [^/]*, ? -> .
        let r = '^' + (root ? root + '/' : '');
        let g = pattern.replace(/\\\\/g, '/');
        for (let i = 0; i < g.length; i++) {
          const c = g[i];
          if (c === '*') {
            if (g[i+1] === '*') { r += '.*'; i++; if (g[i+1] === '/') i++; }
            else r += '[^/]*';
          } else if (c === '?') r += '.';
          else if (/[.+^$(){}|[\\]\\\\]/.test(c)) r += '\\\\' + c;
          else r += c;
        }
        r += '$';
        return new RegExp(r);
      })();
      const seen = new Set();
      if (__vfsBundle) for (const bk in __vfsBundle) if (re.test(bk)) seen.add(bk);
      if (__vfsWrites) for (const wk in __vfsWrites) if (re.test(wk)) seen.add(wk);
      for (const m of [...seen].sort()) yield '/' + m;
    },
  };

  // ── constants ──
  const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

  return {
    readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync,
    readdirSync, mkdirSync, unlinkSync, rmdirSync, renameSync, copyFileSync,
    readFile, writeFile, stat, readdir, exists, mkdir, unlink, access,
    promises, constants,
    createReadStream: (p, opts) => {
      const rs = new __streamMod.Readable({
        read() {
          try {
            const data = readFileSync(p, opts);
            this.push(data);
            this.push(null);
          } catch (e) {
            this.destroy(e);
          }
        },
      });
      return rs;
    },
    createWriteStream: (p, opts) => {
      const chunks = [];
      const ws = new __streamMod.Writable({
        write(chunk, enc, cb) { chunks.push(typeof chunk === "string" ? chunk : _dec.decode(chunk)); cb(); },
        final(cb) { writeFileSync(p, chunks.join("")); cb(); },
      });
      return ws;
    },
    // fs.watch() — returns a watcher object that emits 'change' events.
    // In the facet context, changes to __vfsBundle/Writes are detected
    // via polling since we don't have the supervisor's event emitter.
    // For the supervisor context, real VFS events are wired separately.
    watch: (filename, opts, listener) => {
      if (typeof opts === "function") { listener = opts; opts = {}; }
      const watcher = new __eventsMod();
      watcher.close = () => { watcher._closed = true; watcher.removeAllListeners(); };
      watcher._closed = false;
      if (listener) watcher.on("change", listener);
      // Poll for changes every 500ms (simple but functional)
      const absPath = _resolve(filename);
      const key = _strip(absPath);
      let lastContent = _bundleLookup(absPath);
      const interval = setInterval(() => {
        if (watcher._closed) { clearInterval(interval); return; }
        const current = _bundleLookup(absPath);
        if (current !== lastContent) {
          lastContent = current;
          const eventType = current === undefined ? "rename" : "change";
          watcher.emit("change", eventType, __pathMod.basename(filename));
        }
      }, 500);
      return watcher;
    },
    watchFile: (filename, opts, listener) => {
      if (typeof opts === "function") { listener = opts; opts = {}; }
      // No-op but accept the API
      return { unref: () => {} };
    },
    unwatchFile: () => {},
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  os module ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __osMod = {
  platform: () => "linux", arch: () => "x64", type: () => "Linux",
  release: () => "6.0.0-nimbus", tmpdir: () => "/tmp", homedir: () => "/home/user",
  hostname: () => "nimbus", userInfo: () => ({ uid: 1000, gid: 1000, username: "user", homedir: "/home/user", shell: "/bin/sh" }),
  cpus: () => [{ model: "DO vCPU", speed: 3000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
  totalmem: () => 128 * 1024 * 1024, freemem: () => 64 * 1024 * 1024,
  loadavg: () => [0, 0, 0], uptime: () => 3600,
  networkInterfaces: () => ({ lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }] }),
  EOL: "\\n", endianness: () => "LE",
};

// ═══════════════════════════════════════════════════════════════════════
// ──  events module ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __eventsMod = (() => {
  class EE {
    constructor() { this._e = {}; this._maxListeners = 10; }
    on(n, fn) { (this._e[n] = this._e[n] || []).push(fn); return this; }
    addListener(n, fn) { return this.on(n, fn); }
    once(n, fn) { const w = (...a) => { this.off(n, w); fn(...a); }; w.__orig = fn; return this.on(n, w); }
    off(n, fn) { if (this._e[n]) this._e[n] = this._e[n].filter(f => f !== fn && f.__orig !== fn); return this; }
    removeListener(n, fn) { return this.off(n, fn); }
    removeAllListeners(n) { if (n) delete this._e[n]; else this._e = {}; return this; }
    emit(n, ...a) { const fns = this._e[n]; if (!fns || !fns.length) return false; for (const fn of [...fns]) fn(...a); return true; }
    listeners(n) { return (this._e[n] || []).map(f => f.__orig || f); }
    listenerCount(n) { return (this._e[n] || []).length; }
    eventNames() { return Object.keys(this._e).filter(k => this._e[k].length > 0); }
    setMaxListeners(n) { this._maxListeners = n; return this; }
    getMaxListeners() { return this._maxListeners; }
    prependListener(n, fn) { (this._e[n] = this._e[n] || []).unshift(fn); return this; }
    rawListeners(n) { return this._e[n] || []; }
  }
  EE.EventEmitter = EE;
  EE.defaultMaxListeners = 10;
  return EE;
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  stream module (real, with backpressure) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════
${STREAMS_CODE}

// ═══════════════════════════════════════════════════════════════════════
// ──  util module ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __utilMod = {
  inspect: (o, opts) => { try { return JSON.stringify(o, null, 2); } catch { return String(o); } },
  format: (fmt, ...a) => {
    if (typeof fmt !== "string") return [fmt, ...a].map(__fmt).join(" ");
    let i = 0;
    return fmt.replace(/%[sdifjoO%]/g, (m) => {
      if (m === "%%") return "%";
      if (i >= a.length) return m;
      const v = a[i++];
      if (m === "%s") return String(v);
      if (m === "%d" || m === "%i" || m === "%f") return Number(v).toString();
      if (m === "%j") { try { return JSON.stringify(v); } catch { return "[Circular]"; } }
      if (m === "%o" || m === "%O") { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
      return String(v);
    }) + (i < a.length ? " " + a.slice(i).map(__fmt).join(" ") : "");
  },
  promisify: (fn) => (...a) => new Promise((res, rej) => fn(...a, (e, r) => e ? rej(e) : res(r))),
  callbackify: (fn) => (...a) => { const cb = a.pop(); fn(...a).then(r => cb(null, r), e => cb(e)); },
  types: { isDate: (v) => v instanceof Date, isRegExp: (v) => v instanceof RegExp, isPromise: (v) => v instanceof Promise },
  inherits: (c, s) => { c.super_ = s; c.prototype = Object.create(s.prototype, { constructor: { value: c } }); },
  deprecate: (fn, msg) => fn,
  debuglog: () => () => {},
  isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
};

// ═══════════════════════════════════════════════════════════════════════
// ──  url module ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __urlMod = {
  URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
  parse: (s) => { try { const u = new URL(s); return { protocol: u.protocol, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, href: u.href, host: u.host }; } catch { return { href: s }; } },
  format: (o) => { if (typeof o === "string") return o; if (o instanceof URL) return o.href; return (o.protocol || "http:") + "//" + (o.hostname || "") + (o.port ? ":" + o.port : "") + (o.pathname || "/") + (o.search || ""); },
  resolve: (from, to) => new URL(to, from).href,
  pathToFileURL: (p) => new URL("file://" + p),
  fileURLToPath: (u) => (typeof u === "string" ? u : u.pathname).replace(/^file:\\/\\//, ""),
};

// ═══════════════════════════════════════════════════════════════════════
// ──  crypto module (W3: forward to workerd's real node:crypto) ──────
// ═══════════════════════════════════════════════════════════════════════
//
// Pre-W3 this was a hand-rolled FNV-1a fake that returned a 16-byte
// FNV state repeated as a 32-byte "sha256" hash — silent correctness
// disaster (sha256("hello") = abdd62852c5bd7fc9fa116d64f0254ec × 2
// instead of 2cf24dba...).  W3 forwards to workerd's real
// node:crypto, which has been stable since CF changelog 2025-04-08.
// __real_crypto comes from the static import block at the top of the
// generated facet file (see src/_shared/real-node-imports.ts).
//
// The forward is exhaustive — Node 20 surface (createHash, createHmac,
// pbkdf2/Sync, scrypt/Sync, createCipheriv/Decipheriv, createSign/
// Verify, KeyObject, generateKeyPair/Sync, createPublic/PrivateKey,
// timingSafeEqual, randomBytes/UUID/Int/Fill, getHashes/Ciphers/Curves,
// constants, webcrypto, subtle) is all on the workerd module.
const __cryptoMod = (() => {
  const real = (typeof __real_crypto !== 'undefined') ? (__real_crypto.default ?? __real_crypto) : null;
  if (real && typeof real.createHash === 'function') return real;
  // Defensive fallback: if for some reason the static import didn't
  // materialise (e.g. compat-flag drift), surface honest-error rather
  // than silently shipping a fake hash.  Anything beyond randomBytes/
  // randomUUID throws a NIMBUS-flavoured error.
  function _unavail(name) {
    return () => {
      const e = new Error('crypto.' + name + ': workerd node:crypto not available. Check facet compat date >= 2025-04-08.');
      e.code = 'ERR_CRYPTO_UNAVAILABLE';
      throw e;
    };
  }
  return {
    randomBytes: (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return __BufferMod.from(a); },
    randomUUID: () => crypto.randomUUID(),
    randomInt: (min, max) => { if (max === undefined) { max = min; min = 0; } return min + Math.floor(Math.random() * (max - min)); },
    randomFillSync: (buf) => { crypto.getRandomValues(buf); return buf; },
    createHash: _unavail('createHash'),
    createHmac: _unavail('createHmac'),
    pbkdf2: _unavail('pbkdf2'),
    pbkdf2Sync: _unavail('pbkdf2Sync'),
    timingSafeEqual: (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; },
    constants: {},
    webcrypto: globalThis.crypto,
    subtle: globalThis.crypto?.subtle,
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  vm module (W3: hybrid — forward surface, honest-error on eval) ──
// ═══════════════════════════════════════════════════════════════════════
//
// Workerd's node:vm provides the API surface (constants, classes,
// runInContext as a function) BUT every code-running method throws
// ERR_METHOD_NOT_IMPLEMENTED at request-handler time. New Function
// is also blocked at request time. So we forward the surface (so
// jsdom's static-load checks pass) and wrap the eval methods with
// a honest Nimbus error so callers know it's the workerd block.
//
// Acceptance limitation: jsdom static-load works; jsdom HTML-script
// execution does not.  Documented in W3 retro for W3.5 follow-up
// (a parser-based vm fallback, or pre-bundle vm-using scripts at
// install time).
const __vmMod = (() => {
  const real = (typeof __real_vm !== 'undefined') ? (__real_vm.default ?? __real_vm) : null;
  function honestError(method, originalErr) {
    const e = new Error(
      'vm.' + method + ': workerd does not implement runtime eval. ' +
      'Pre-bundle vm-using scripts at install time, or wait for W3.5 ' +
      'parser-based fallback. (Original: ' +
      ((originalErr && originalErr.message) || 'no underlying error') + ')'
    );
    e.code = 'ERR_VM_DYNAMIC_EVAL_DISALLOWED';
    return e;
  }
  function wrapRuntimeEval(method) {
    return (...args) => {
      if (!real || typeof real[method] !== 'function') {
        throw honestError(method, null);
      }
      try { return real[method](...args); } catch (e) {
        // Workerd surfaces ERR_METHOD_NOT_IMPLEMENTED;
        // \`new Function\` surfaces "Code generation from strings disallowed".
        if (e && (e.code === 'ERR_METHOD_NOT_IMPLEMENTED'
                  || /not implemented|disallowed|Code generation/i.test(e.message || ''))) {
          throw honestError(method, e);
        }
        throw e;
      }
    };
  }
  return {
    constants: real?.constants ?? {},
    createContext: (sandbox, opts) => {
      if (!real || typeof real.createContext !== 'function') return sandbox || {};
      try { return real.createContext(sandbox, opts); }
      catch { return sandbox || {}; }
    },
    isContext: real?.isContext ?? ((o) => !!o),
    runInContext: wrapRuntimeEval('runInContext'),
    runInNewContext: wrapRuntimeEval('runInNewContext'),
    runInThisContext: wrapRuntimeEval('runInThisContext'),
    compileFunction: wrapRuntimeEval('compileFunction'),
    Script: real?.Script ?? class { constructor() { throw honestError('Script', null); } },
    Module: real?.Module,
    SourceTextModule: real?.SourceTextModule,
    SyntheticModule: real?.SyntheticModule,
    measureMemory: real?.measureMemory ?? (async () => ({ total: { jsMemoryEstimate: 0 } })),
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  http2 module (W3: stub — non-throwing load, honest connect err) ─
// ═══════════════════════════════════════════════════════════════════════
//
// axios's dist/node code does \`var http2 = require('http2')\` at top
// level, unconditionally. Without this stub the require fails →
// axios fails to load. The actual HTTP/2 transport is only invoked
// when user opts in (\`httpVersion: 2\`); otherwise this shim is dormant.
const __http2Mod = (() => {
  function _err(op) {
    const e = new Error('http2.' + op + ': not implemented in Nimbus. Use fetch() or HTTP/1.1.');
    e.code = 'ERR_HTTP2_NOT_SUPPORTED';
    return e;
  }
  class Http2Session extends __eventsMod {
    constructor() { super(); this.destroyed = false; }
    request() { throw _err('request'); }
    close() { this.destroyed = true; this.emit('close'); }
    destroy(err) { this.destroyed = true; if (err) this.emit('error', err); this.emit('close'); }
    settings() {}
  }
  function connect(/* authority, opts, listener */) {
    const session = new Http2Session();
    queueMicrotask(() => session.emit('error', _err('connect')));
    return session;
  }
  function createServer() { throw _err('createServer'); }
  return {
    connect, createServer,
    createSecureServer: createServer,
    Http2Session,
    constants: {
      NGHTTP2_NO_ERROR: 0, NGHTTP2_PROTOCOL_ERROR: 1,
      HTTP2_HEADER_PATH: ':path', HTTP2_HEADER_METHOD: ':method',
      HTTP2_HEADER_STATUS: ':status', HTTP2_HEADER_AUTHORITY: ':authority',
      HTTP2_HEADER_SCHEME: ':scheme',
    },
    sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  repl module (W3: forward to workerd) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ts-node imports repl. Workerd has it (stub since 2026-03-17).
const __replMod = (() => {
  const real = (typeof __real_repl !== 'undefined') ? (__real_repl.default ?? __real_repl) : null;
  if (real && typeof real.start === 'function') return real;
  // Fallback if static import didn't materialise.
  class REPLServer extends __eventsMod {
    close() { this.emit('exit'); }
    displayPrompt() {} pause() {} resume() {}
    setupHistory(p, cb) { if (cb) cb(null, this); }
    defineCommand() {}
  }
  return { start: (opts) => new REPLServer(), REPLServer, REPL_MODE_SLOPPY: 0, REPL_MODE_STRICT: 1 };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  diagnostics_channel (W3: forward to workerd) ───────────────────
// ═══════════════════════════════════════════════════════════════════════
// fastify uses Channel.runStores at request-handler time — workerd's
// real impl includes this. Forward whole module.
const __diagChannelMod = (() => {
  const real = (typeof __real_diagnostics_channel !== 'undefined') ? (__real_diagnostics_channel.default ?? __real_diagnostics_channel) : null;
  if (real && typeof real.channel === 'function') return real;
  // Fallback: tiny pure-JS impl (no runStores; fastify will fail loud).
  const channels = new Map();
  class Channel {
    constructor(name) { this.name = name; this._subs = []; }
    get hasSubscribers() { return this._subs.length > 0; }
    subscribe(fn) { this._subs.push(fn); }
    unsubscribe(fn) { const i = this._subs.indexOf(fn); if (i >= 0) { this._subs.splice(i, 1); return true; } return false; }
    publish(msg) { for (const fn of [...this._subs]) { try { fn(msg, this.name); } catch {} } }
    runStores(_store, fn, thisArg, ...args) { return fn.apply(thisArg, args); }
    bindStore() {} unbindStore() {}
  }
  function channel(name) {
    let c = channels.get(name);
    if (!c) { c = new Channel(name); channels.set(name, c); }
    return c;
  }
  return {
    channel,
    hasSubscribers: (name) => { const c = channels.get(name); return !!(c && c.hasSubscribers); },
    subscribe: (name, fn) => channel(name).subscribe(fn),
    unsubscribe: (name, fn) => channel(name).unsubscribe(fn),
    tracingChannel: (n) => ({
      start: channel('tracing:' + n + ':start'),
      end: channel('tracing:' + n + ':end'),
      asyncStart: channel('tracing:' + n + ':asyncStart'),
      asyncEnd: channel('tracing:' + n + ':asyncEnd'),
      error: channel('tracing:' + n + ':error'),
      traceSync(fn) { return fn(); },
      tracePromise(fn) { return Promise.resolve().then(fn); },
      traceCallback(fn, _pos, _ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
    }),
    Channel,
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  tls module (W3: forward to workerd, override createServer) ─────
// ═══════════════════════════════════════════════════════════════════════
const __tlsMod = (() => {
  const real = (typeof __real_tls !== 'undefined') ? (__real_tls.default ?? __real_tls) : null;
  if (!real) {
    return { connect: () => { throw new Error('tls: workerd node:tls not available'); } };
  }
  // tls.createServer in workerd would bind a real port; in a facet we want
  // routing through __portRegistry, so override that one method.
  return new Proxy(real, {
    get(t, p) {
      if (p === 'createServer') {
        return () => {
          const e = new Error('tls.createServer: not supported in Nimbus facet. Use http.createServer for routing.');
          e.code = 'ERR_NET_SERVER_NOT_AVAILABLE';
          throw e;
        };
      }
      return t[p];
    }
  });
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  async_hooks module (W3: forward to workerd) ────────────────────
// ═══════════════════════════════════════════════════════════════════════
// AsyncLocalStorage is the 90% case; workerd has it via nodejs_als
// (auto-on at compat date 2026-04-01). createHook is also present
// in workerd as a non-functional stub.
const __asyncHooksMod = (() => {
  const real = (typeof __real_async_hooks !== 'undefined') ? (__real_async_hooks.default ?? __real_async_hooks) : null;
  if (real && typeof real.AsyncLocalStorage === 'function') return real;
  // Defensive fallback.
  return {
    AsyncLocalStorage: class { run(_s, fn, ...args) { return fn(...args); } getStore() { return undefined; } enterWith() {} disable() {} exit(fn, ...args) { return fn(...args); } },
    AsyncResource: class { runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); } bind(fn) { return fn; } asyncId() { return 0; } triggerAsyncId() { return 0; } emitDestroy() {} },
    createHook: () => ({ enable() { return this; }, disable() { return this; } }),
    executionAsyncId: () => 0,
    executionAsyncResource: () => null,
    triggerAsyncId: () => 0,
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  assert module ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __assertMod = Object.assign(
  (v, m) => { if (!v) { const e = new Error(m || "AssertionError"); e.code = "ERR_ASSERTION"; throw e; } },
  {
    ok: (v, m) => { if (!v) { const e = new Error(m || "The expression evaluated to a falsy value"); e.code = "ERR_ASSERTION"; throw e; } },
    equal: (a, b, m) => { if (a != b) { const e = new Error(m || __fmt(a) + " != " + __fmt(b)); e.code = "ERR_ASSERTION"; throw e; } },
    notEqual: (a, b, m) => { if (a == b) { const e = new Error(m || __fmt(a) + " == " + __fmt(b)); e.code = "ERR_ASSERTION"; throw e; } },
    strictEqual: (a, b, m) => { if (a !== b) { const e = new Error(m || __fmt(a) + " !== " + __fmt(b)); e.code = "ERR_ASSERTION"; throw e; } },
    notStrictEqual: (a, b, m) => { if (a === b) { const e = new Error(m || "Values are strictly equal"); e.code = "ERR_ASSERTION"; throw e; } },
    deepEqual: (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { const e = new Error(m || "deepEqual failed"); e.code = "ERR_ASSERTION"; throw e; } },
    deepStrictEqual: (a, b, m) => __assertMod.deepEqual(a, b, m),
    throws: (fn, m) => { try { fn(); } catch { return; } const e = new Error(m || "Missing expected exception"); e.code = "ERR_ASSERTION"; throw e; },
    doesNotThrow: (fn, m) => { try { fn(); } catch (ex) { const e = new Error(m || "Got unwanted exception: " + ex.message); e.code = "ERR_ASSERTION"; throw e; } },
    ifError: (v) => { if (v) throw v; },
    fail: (m) => { const e = new Error(m || "Failed"); e.code = "ERR_ASSERTION"; throw e; },
  }
);

// ═══════════════════════════════════════════════════════════════════════
// ──  querystring, string_decoder, child_process (stubs) ─────────────
// ═══════════════════════════════════════════════════════════════════════
const __qsMod = {
  stringify: (o, sep, eq) => Object.entries(o || {}).map(([k,v]) => encodeURIComponent(k) + (eq||"=") + encodeURIComponent(String(v))).join(sep||"&"),
  parse: (s, sep, eq) => Object.fromEntries(new URLSearchParams(s)),
  escape: encodeURIComponent,
  unescape: decodeURIComponent,
};

const __stringDecoderMod = {
  StringDecoder: class { constructor(enc) { this.enc = enc || "utf8"; this._dec = new TextDecoder(this.enc); } write(buf) { return this._dec.decode(buf, { stream: true }); } end(buf) { return buf ? this._dec.decode(buf) : ""; } },
};

const __childProcessMod = (() => {
  // child_process — real implementations backed by supervisor RPC.
  // exec: runs a command via the supervisor's shell
  // fork: creates a child facet via supervisor RPC
  // spawn: creates a child facet with stdio streams
  function _makeChildProcess() {
    const child = new __eventsMod();
    child.pid = 0;
    child.connected = false;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = new __streamMod.Writable();
    child.stdout = new __streamMod.Readable();
    child.stderr = new __streamMod.Readable();
    child.stdio = [child.stdin, child.stdout, child.stderr];
    child.send = () => false;
    child.kill = (sig) => { child.killed = true; child.emit("exit", null, sig || "SIGTERM"); };
    child.disconnect = () => { child.connected = false; child.emit("disconnect"); };
    child.ref = () => child;
    child.unref = () => child;
    return child;
  }

  function exec(cmd, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    const child = _makeChildProcess();
    // For now, exec returns an error explaining the limitation.
    // When supervisor RPC is available, this will shell out.
    queueMicrotask(() => {
      const err = new Error("child_process.exec: command execution requires supervisor connection. Run scripts directly with 'node'.");
      err.code = "ERR_CHILD_PROCESS_UNAVAILABLE";
      if (cb) cb(err, "", "");
      child.emit("error", err);
      child.emit("exit", 1, null);
    });
    return child;
  }

  function execSync(cmd, opts) {
    throw Object.assign(
      new Error("child_process.execSync: synchronous command execution not available in Nimbus isolate. Use async exec() or run scripts directly."),
      { code: "ERR_CHILD_PROCESS_UNAVAILABLE", cmd }
    );
  }

  function spawn(cmd, args, opts) {
    if (typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    const child = _makeChildProcess();
    queueMicrotask(() => {
      child.emit("error", Object.assign(
        new Error("child_process.spawn: process spawning requires supervisor connection."),
        { code: "ERR_CHILD_PROCESS_UNAVAILABLE", cmd }
      ));
      child.emit("exit", 1, null);
    });
    return child;
  }

  function fork(modulePath, args, opts) {
    if (typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    const child = _makeChildProcess();
    child.connected = true;
    child.send = (msg) => { /* IPC via supervisor when connected */ return true; };
    queueMicrotask(() => {
      child.emit("error", Object.assign(
        new Error("child_process.fork: forking requires supervisor RPC connection. Use the supervisor's fork API."),
        { code: "ERR_CHILD_PROCESS_UNAVAILABLE", modulePath }
      ));
      child.emit("exit", 1, null);
    });
    return child;
  }

  function execFile(file, args, opts, cb) {
    if (typeof args === "function") { cb = args; args = []; opts = {}; }
    if (typeof opts === "function") { cb = opts; opts = {}; }
    return exec(file + " " + (args || []).join(" "), opts, cb);
  }

  return { exec, execSync, spawn, fork, execFile, ChildProcess: __eventsMod };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  console shim ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __consoleMod = {
  log: (...a) => { stdout += __utilMod.format(...a) + "\\n"; },
  error: (...a) => { stderr += __utilMod.format(...a) + "\\n"; },
  warn: (...a) => { stderr += __utilMod.format(...a) + "\\n"; },
  info: (...a) => { stdout += __utilMod.format(...a) + "\\n"; },
  debug: (...a) => { stdout += __utilMod.format(...a) + "\\n"; },
  dir: (o, opts) => { stdout += __utilMod.inspect(o, opts) + "\\n"; },
  trace: (...a) => { stderr += "Trace: " + __utilMod.format(...a) + "\\n"; },
  assert: (c, ...a) => { if (!c) stderr += "Assertion failed: " + __utilMod.format(...a) + "\\n"; },
  time: () => {}, timeEnd: () => {}, timeLog: () => {}, clear: () => {},
  count: () => {}, countReset: () => {}, group: () => {}, groupEnd: () => {},
  table: (d) => { stdout += __utilMod.inspect(d) + "\\n"; },
};

// ═══════════════════════════════════════════════════════════════════════
// ──  process shim ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __processMod = {
  argv: ["node", ...(argv || [])],
  env: env || {},
  cwd: () => cwd || "/home/user",
  chdir: (d) => { cwd = __pathMod.resolve(cwd || "/home/user", d); },
  exit: (code) => { exitCode = code ?? 0; throw new __ProcessExit(exitCode); },
  platform: "linux", arch: "x64",
  version: "v20.0.0", versions: { node: "20.0.0", v8: "11.0.0", modules: "115" },
  pid: 1, ppid: 0, title: "node",
  stdout: { write: (d) => { stdout += String(d); return true; }, isTTY: false },
  stderr: { write: (d) => { stderr += String(d); return true; }, isTTY: false },
  stdin: { read: () => null, on: () => __processMod.stdin, isTTY: false },
  hrtime: Object.assign(
    (prev) => { const n = Date.now(); const s = Math.floor(n / 1000); const ns = (n % 1000) * 1e6; if (!prev) return [s, ns]; return [s - prev[0], ns - prev[1]]; },
    { bigint: () => BigInt(Date.now()) * 1000000n }
  ),
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  on: () => __processMod, once: () => __processMod, emit: () => false,
  removeListener: () => __processMod, removeAllListeners: () => __processMod,
  uptime: () => 0, kill: () => {},
  umask: () => 0o022,
  binding: () => { throw new Error("process.binding is not supported"); },
};

// ═══════════════════════════════════════════════════════════════════════
// ──  Builtins initialization (MUST come before require) ─────────────
// ═══════════════════════════════════════════════════════════════════════
const builtins = {};
builtins.fs = __fsMod;
builtins.path = __pathMod;
builtins.os = __osMod;
builtins.events = __eventsMod;
builtins.stream = __streamMod;
builtins.buffer = { Buffer: __BufferMod };
builtins.util = __utilMod;
builtins.url = __urlMod;
builtins.crypto = __cryptoMod;
builtins.assert = __assertMod;
builtins.querystring = __qsMod;
builtins.string_decoder = __stringDecoderMod;
builtins.child_process = __childProcessMod;
builtins.process = __processMod;
builtins.console = __consoleMod;
builtins.http = (() => {
  if (!globalThis.__portRegistry) globalThis.__portRegistry = new Map();
  class ServerResponse extends __eventsMod {
    constructor() { super(); this.statusCode = 200; this.headers = {}; this._body = []; this._ended = false; }
    writeHead(code, hdrs) { this.statusCode = code; if (hdrs) Object.assign(this.headers, hdrs); return this; }
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }
    getHeader(k) { return this.headers[k.toLowerCase()]; }
    write(chunk) { this._body.push(typeof chunk === "string" ? chunk : String(chunk)); return true; }
    end(data) { if (data) this.write(data); this._ended = true; this.emit("finish"); }
    get headersSent() { return this._ended; }
  }
  class IncomingMessage extends __eventsMod {
    constructor(u, m, h) { super(); this.url = u || "/"; this.method = m || "GET"; this.headers = h || {}; this.httpVersion = "1.1"; }
  }
  class Server extends __eventsMod {
    constructor(handler) { super(); if (handler) this.on("request", handler); this._port = 0; this._listening = false; }
    listen(port, host, cb) { if (typeof host === "function") { cb = host; } this._port = port || 0; this._listening = true; globalThis.__portRegistry.set(this._port, this); if (cb) queueMicrotask(cb); this.emit("listening"); return this; }
    close(cb) { this._listening = false; globalThis.__portRegistry.delete(this._port); if (cb) cb(); this.emit("close"); }
    get listening() { return this._listening; }
    address() { return { address: "0.0.0.0", port: this._port, family: "IPv4" }; }
    _handleRequest(u, m, h, b) { const req = new IncomingMessage(u, m, h); const res = new ServerResponse(); this.emit("request", req, res); if (b) { req.emit("data", b); req.emit("end"); } else { req.emit("end"); } return res; }
  }
  function createServer(o, h) { if (typeof o === "function") { h = o; } return new Server(h); }
  return { createServer, Server, IncomingMessage, ServerResponse, Agent: class {}, STATUS_CODES: {}, METHODS: ["GET","POST","PUT","DELETE","PATCH","HEAD","OPTIONS"], request: () => { throw new Error("Use fetch()"); }, get: () => { throw new Error("Use fetch()"); } };
})();
builtins.https = (() => {
  const hm = builtins.http;
  return {
    createServer: hm.createServer, Server: hm.Server, Agent: class {}, globalAgent: {},
    request: (url, opts, cb) => { if (typeof url === "string") url = new URL(url); if (typeof opts === "function") { cb = opts; opts = {}; } const req = new __eventsMod(); req.end = (body) => { fetch(url.href || url, { method: opts?.method || "GET", headers: opts?.headers, body }).then(async (resp) => { const res = new __eventsMod(); res.statusCode = resp.status; res.headers = Object.fromEntries(resp.headers); if (cb) cb(res); const text = await resp.text(); res.emit("data", text); res.emit("end"); }).catch((e) => req.emit("error", e)); }; req.write = () => req; req.on = (...a) => { __eventsMod.prototype.on.apply(req, a); return req; }; return req; },
    get: (url, opts, cb) => { const req = builtins.https.request(url, opts, cb); req.end(); return req; },
  };
})();
// W3 — net.Socket honest-error mode.
//
// Pre-W3 behaviour: \`new net.Socket().connect(443, 'example.com')\`
// immediately fired the 'connect' event without any I/O — silent lie.
// Anything attempting raw TCP from a facet (pg, mysql2, redis wire
// protocols) thought it succeeded but produced no I/O.
//
// W3 behaviour: connect() emits 'error' with code
// ERR_NET_SOCKET_NOT_AVAILABLE so callers fail loud.  W8 will route
// raw outbound TCP through supervisor RPC.
builtins.net = (() => {
  class Socket extends __eventsMod {
    constructor() {
      super();
      this.connecting = false;
      this.destroyed = false;
      // Honest: we cannot send/receive bytes from a facet today.
      this.writable = false;
      this.readable = false;
      this.remoteAddress = null;
      this.remotePort = null;
      this.localAddress = "0.0.0.0";
      this.localPort = 0;
    }
    connect(port, host, cb) {
      if (typeof host === "function") { cb = host; host = "127.0.0.1"; }
      this.remoteAddress = host || "127.0.0.1";
      this.remotePort = port;
      const self = this;
      queueMicrotask(() => {
        const err = new Error(
          "net.Socket: outbound TCP from Nimbus facet not yet supported. " +
          "Use fetch() for HTTP/HTTPS. (W8 will route via supervisor RPC.)"
        );
        err.code = "ERR_NET_SOCKET_NOT_AVAILABLE";
        self.destroyed = true;
        self.emit("error", err);
        if (cb) cb(err);
      });
      return this;
    }
    write() { return false; }
    end(data, enc, cb) {
      if (typeof data === "function") { cb = data; data = undefined; }
      const self = this;
      queueMicrotask(() => { self.emit("end"); self.emit("close"); if (cb) cb(); });
      return this;
    }
    destroy(err) { this.destroyed = true; if (err) this.emit("error", err); this.emit("close"); return this; }
    setEncoding() { return this; }
    setTimeout() { return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { return this; }
    unref() { return this; }
    address() { return null; }
  }
  return {
    Socket,
    Server: builtins.http.Server,
    createServer: (o, h) => { if (typeof o === "function") { h = o; } return builtins.http.createServer(h); },
    createConnection: (p, h, cb) => new Socket().connect(p, h, cb),
    connect: (p, h, cb) => new Socket().connect(p, h, cb),
    isIP: (s) => /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(s) ? 4 : 0,
    isIPv4: (s) => /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(s),
    isIPv6: () => false,
  };
})();
builtins.dns = (() => {
  async function _doh(h, t) { try { const r = await fetch("https://cloudflare-dns.com/dns-query?name="+encodeURIComponent(h)+"&type="+(t||"A"),{headers:{"Accept":"application/dns-json"}}); const d = await r.json(); return (d.Answer||[]).map(a=>a.data).filter(Boolean); } catch { return []; } }
  return { resolve: (h,t,cb) => { if (typeof t==="function"){cb=t;t="A";} _doh(h,t).then(a=>cb(null,a.length?a:["127.0.0.1"])).catch(e=>cb(e)); }, resolve4: (h,cb) => _doh(h,"A").then(a=>cb(null,a.length?a:["127.0.0.1"])).catch(e=>cb(e)), resolve6: (h,cb) => _doh(h,"AAAA").then(a=>cb(null,a)).catch(e=>cb(e)), lookup: (h,o,cb) => { if(typeof o==="function"){cb=o;} if(h==="localhost"){cb(null,"127.0.0.1",4);return;} _doh(h,"A").then(a=>cb(null,a[0]||"127.0.0.1",4)).catch(e=>cb(e)); }, promises: { resolve: (h,t) => _doh(h,t||"A"), resolve4: (h) => _doh(h,"A"), lookup: async(h) => { if(h==="localhost") return {address:"127.0.0.1",family:4}; const a=await _doh(h,"A"); return {address:a[0]||"127.0.0.1",family:4}; } } };
})();
builtins.tty = { isatty: () => false, ReadStream: class extends __streamMod.Readable { constructor() { super(); this.isTTY = false; } }, WriteStream: class extends __streamMod.Writable { constructor() { super(); this.isTTY = false; this.columns = 80; this.rows = 24; } } };
builtins.module = { get builtinModules() { return Object.keys(builtins); }, createRequire: () => __require, _resolveFilename: (id) => id, _cache: {} };
builtins.timers = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval, setImmediate: (fn,...a) => setTimeout(fn,0,...a), clearImmediate: clearTimeout };
builtins.zlib = (() => {
  function _c(d,a) { const i=typeof d==="string"?new TextEncoder().encode(d):d; return new Response(new Blob([i]).stream().pipeThrough(new CompressionStream(a))).arrayBuffer().then(ab=>__BufferMod.from(new Uint8Array(ab))); }
  function _d(d,a) { const i=d instanceof Uint8Array?d:new Uint8Array(d); return new Response(new Blob([i]).stream().pipeThrough(new DecompressionStream(a))).arrayBuffer().then(ab=>__BufferMod.from(new Uint8Array(ab))); }
  return { gzip:(d,o,cb)=>{if(typeof o==="function")cb=o;_c(d,"gzip").then(r=>cb(null,r)).catch(e=>cb(e));}, gunzip:(d,o,cb)=>{if(typeof o==="function")cb=o;_d(d,"gzip").then(r=>cb(null,r)).catch(e=>cb(e));}, deflate:(d,o,cb)=>{if(typeof o==="function")cb=o;_c(d,"deflate").then(r=>cb(null,r)).catch(e=>cb(e));}, inflate:(d,o,cb)=>{if(typeof o==="function")cb=o;_d(d,"deflate").then(r=>cb(null,r)).catch(e=>cb(e));}, gzipSync:()=>{throw new Error("use async gzip()");}, gunzipSync:()=>{throw new Error("use async gunzip()");}, createGzip:()=>new __streamMod.Transform({transform(c,e,cb){_c(c,"gzip").then(r=>cb(null,r)).catch(e=>cb(e));}}), createGunzip:()=>new __streamMod.Transform({transform(c,e,cb){_d(c,"gzip").then(r=>cb(null,r)).catch(e=>cb(e));}}), createDeflate:()=>new __streamMod.Transform({transform(c,e,cb){_c(c,"deflate").then(r=>cb(null,r)).catch(e=>cb(e));}}), createInflate:()=>new __streamMod.Transform({transform(c,e,cb){_d(c,"deflate").then(r=>cb(null,r)).catch(e=>cb(e));}}), constants:{Z_NO_FLUSH:0,Z_PARTIAL_FLUSH:1,Z_SYNC_FLUSH:2,Z_FULL_FLUSH:3,Z_FINISH:4,Z_BEST_COMPRESSION:9,Z_DEFAULT_COMPRESSION:-1} };
})();
builtins.readline = (() => {
  function createInterface(opts) { const inp=typeof opts==="object"&&!opts.input?opts:{input:opts?.input,output:opts?.output}; const rl=new __eventsMod(); rl.close=()=>{rl.emit("close");}; rl.question=(q,o,cb)=>{if(typeof o==="function")cb=o;if(inp.output?.write)inp.output.write(q);if(cb)queueMicrotask(()=>cb(""));}; rl.prompt=()=>{if(inp.output?.write)inp.output.write("> ");}; rl.on=(...a)=>{__eventsMod.prototype.on.apply(rl,a);return rl;}; rl.setPrompt=()=>rl; rl[Symbol.asyncIterator]=async function*(){}; return rl; }
  return { createInterface, Interface: __eventsMod };
})();
builtins.perf_hooks = { performance: globalThis.performance || { now:()=>Date.now(), mark:()=>{}, measure:()=>{}, getEntriesByName:()=>[], clearMarks:()=>{}, clearMeasures:()=>{} } };
builtins.worker_threads = { isMainThread:true, parentPort:null, workerData:null, threadId:0, Worker: class extends __eventsMod { constructor(){super();} terminate(){return Promise.resolve(0);} postMessage(){} } };

// ── W3 additions: builtins forwarded/shimmed for axios/jsdom/fastify/
//                 puppeteer-core/ts-node + Node 20 surface completeness.
builtins.vm = __vmMod;
builtins.http2 = __http2Mod;
builtins.repl = __replMod;
builtins.diagnostics_channel = __diagChannelMod;
builtins.tls = __tlsMod;
builtins.async_hooks = __asyncHooksMod;
// Subpath-style require() — the shim's __requireFrom strips a 'node:'
// prefix to look up bare names, so we expose both bare and prefixed
// keys explicitly for grep-friendliness and to handle any future call
// site that bypasses the strip path.
builtins["fs/promises"] = __fsMod.promises;
builtins["node:fs/promises"] = __fsMod.promises;
builtins["timers/promises"] = (() => {
  return {
    setTimeout: (ms, value) => new Promise(res => setTimeout(() => res(value), ms || 0)),
    setImmediate: (value) => new Promise(res => queueMicrotask(() => res(value))),
    setInterval: async function* (ms, value) {
      while (true) { await new Promise(r => setTimeout(r, ms || 0)); yield value; }
    },
  };
})();
builtins["node:timers/promises"] = builtins["timers/promises"];

// ═══════════════════════════════════════════════════════════════════════
// ──  require() — full Node.js module resolution ─────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __moduleCache = new Map();

/**
 * Direct VFS bundle access for module resolution.
 * These bypass the fs shim's _resolve() (which prepends cwd)
 * because resolver paths are already in VFS format (no leading /).
 */
function __readFileOr(path, fallback) {
  const k = path.replace(/^\\/+/, "");
  if (__vfsBundle && k in __vfsBundle) return __vfsBundle[k];
  if (__vfsWrites && k in __vfsWrites) return __vfsWrites[k];
  // Fallback: try through fs shim (handles _resolve for user-facing paths)
  try { return __fsMod.readFileSync("/" + k, "utf8"); } catch { return fallback; }
}
function __fileExists(path) {
  const k = path.replace(/^\\/+/, "");
  if (__vfsBundle && k in __vfsBundle) return true;
  if (__vfsWrites && k in __vfsWrites) return true;
  if (__vfsDirs && k in __vfsDirs) return true;
  // Check for directory by looking for any key with this prefix
  if (__vfsBundle) {
    const prefix = k + "/";
    for (const bk in __vfsBundle) { if (bk.startsWith(prefix)) return true; }
  }
  return false;
}
function __resolveFile(base) {
  // Extensions probed when a path doesn't include one. Must mirror the
  // install-time pre-bundler: see audit/sections/03-resolver-gaps.md §3.5.
  const exts = ["", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.cjs", "/index.mjs", "/index.json"];
  for (const ext of exts) { if (__fileExists(base + ext)) return base + ext; }
  return null;
}

// __compiledModules is defined at MODULE TOP LEVEL in the generator code
// (facet-manager.ts) so new Function() runs during module evaluation.

// ── Single-source-of-truth exports/imports resolver (W2) ───────────────
// Emitted from src/_shared/exports-resolver.ts via getExportsResolverJS().
// Declares: resolveExports, resolveConditionValue, resolvePackageEntry,
//           DEFAULT_ESM_CONDITIONS, DEFAULT_CJS_CONDITIONS.
// See audit/sections/03-resolver-gaps.md §3.1 for the bug this fixes:
// the prior hand-rolled __resolvePkgEntry only honoured top-level
// require|default|import and dropped subpath maps, wildcards, nested
// conditions, the imports field, and null-target enforcement.
${EXPORTS_RESOLVER_JS}

/** Conditions for runtime CJS resolution (user-shell node). */
const __NIMBUS_CJS_CONDITIONS = ["require", "node", "default"];

/**
 * Read and parse a package.json from VFS. Returns null on miss/parse-fail.
 */
function __readPkgJson(pkgDir) {
  const s = __readFileOr(pkgDir + "/package.json", null);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Resolve a single subpath inside an installed package (pkgDir).
 *   - subpath: '.' for root entry, './foo' for explicit subpath, etc.
 *   - Honours pkg.exports (subpath maps, wildcards, conditions).
 *   - Falls back to module/main for root, raw subpath probing otherwise.
 *   - Final filesystem probe via __resolveFile (extension list).
 *
 * Returns a VFS-relative path to the resolved file, or null.
 */
function __resolvePkgSubpath(pkgDir, pkg, subpath) {
  if (!pkg) pkg = __readPkgJson(pkgDir);
  if (!pkg) {
    // No package.json — try direct probe
    if (subpath === ".") return __resolveFile(pkgDir + "/index");
    return __resolveFile(pkgDir + "/" + subpath.replace(/^\\.\\/+/, ""));
  }
  let entry = resolvePackageEntry(pkg, subpath, __NIMBUS_CJS_CONDITIONS);
  if (entry != null) {
    // Strip leading ./ from the resolver result
    const stripped = entry.replace(/^\\.\\/+/, "");
    const resolved = __resolveFile(pkgDir + "/" + stripped);
    if (resolved) return resolved;
    // W2.6a D2: exports/main yielded a target but the file doesn't exist
    // in the bundle (capped out, or the package mis-declares its main).
    // Fall through to the direct-probe path so we get index.js when the
    // declared entry is missing. Without this fallback, packages whose
    // exports point at a file evicted by the content cap return null and
    // the require chain dead-ends with "Cannot find module" — even though
    // a perfectly good index.js sits next to it.
  }
  // Fallback: probe the directory for a usable entry. This catches
  //   (a) exports map yielded null (forbidden / no condition matched)
  //   (b) exports map yielded a path whose file isn't on disk
  //   (c) main yielded a path whose file isn't on disk
  if (subpath === ".") {
    // Try main again under the extension-list resolver, then fall through
    // to /index probing. The shared resolvePackageEntry already prefers
    // exports → module → main, so re-probing main here only triggers when
    // entry was null OR entry's file was missing.
    if (typeof pkg.main === 'string') {
      const mainStripped = pkg.main.replace(/^\\.\\/+/, "");
      const r = __resolveFile(pkgDir + "/" + mainStripped);
      if (r) return r;
    }
    return __resolveFile(pkgDir + "/index");
  }
  const rel = subpath.replace(/^\\.\\/+/, "");
  return __resolveFile(pkgDir + "/" + rel);
}

/** Back-compat name used elsewhere in this file. */
function __resolvePkgEntry(pkgDir) {
  return __resolvePkgSubpath(pkgDir, null, ".");
}

/**
 * Resolve a bare specifier (e.g. "react", "@scope/pkg", "pkg/sub/path")
 * by walking up node_modules from fromDir. Returns the resolved file or null.
 */
function __resolveNodeModule(name, fromDir) {
  // Split into pkgName + subpath
  let pkgName, subpath;
  if (name.startsWith("@")) {
    const parts = name.split("/");
    if (parts.length < 2) return null;
    pkgName = parts.slice(0, 2).join("/");
    subpath = parts.length > 2 ? "./" + parts.slice(2).join("/") : ".";
  } else {
    const slashIdx = name.indexOf("/");
    if (slashIdx > 0) {
      pkgName = name.substring(0, slashIdx);
      subpath = "./" + name.substring(slashIdx + 1);
    } else {
      pkgName = name;
      subpath = ".";
    }
  }

  // Walk up directories looking for node_modules/<pkgName>.
  // Audit §3.7 (P7 fastify case): the prior loop was right, but the
  // visited-set keyed on dir-with-leading-slash-stripped while node_modules
  // existence checks used the same form, so iteration COULD terminate early
  // when hitting "" (empty string) at the root. Explicit termination on
  // empty string + always-also-check root node_modules covers both.
  let dir = (fromDir || "").replace(/^\\/+/, "");
  const visited = new Set();
  while (true) {
    if (visited.has(dir)) break;
    visited.add(dir);
    const nmDir = (dir ? dir + "/" : "") + "node_modules/" + pkgName;
    if (__fileExists(nmDir)) {
      const resolved = __resolvePkgSubpath(nmDir, null, subpath);
      if (resolved) return resolved;
    }
    if (!dir) break;
    const lastSlash = dir.lastIndexOf("/");
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : "";
  }
  return null;
}

/**
 * Resolve a #name imports-field specifier from the nearest enclosing
 * package.json. Returns the resolved file or null.
 */
function __resolveImportsField(name, fromDir) {
  // Walk up looking for the nearest package.json. Stop at the first one
  // (Node spec: imports field of the importing module's package).
  let dir = (fromDir || "").replace(/^\\/+/, "");
  while (true) {
    const pkgJsonPath = (dir ? dir + "/" : "") + "package.json";
    if (__fileExists(pkgJsonPath)) {
      const pkg = __readPkgJson(dir);
      if (pkg && pkg.imports) {
        const target = resolveExports(pkg.imports, name, __NIMBUS_CJS_CONDITIONS);
        if (target) {
          // Imports targets are relative to the package root (dir)
          if (target.startsWith("./")) {
            return __resolveFile((dir ? dir + "/" : "") + target.slice(2));
          }
          if (target.startsWith("/")) {
            return __resolveFile(target.slice(1));
          }
          // Bare specifier — re-resolve as a node_module from this dir
          return __resolveNodeModule(target, dir);
        }
      }
      return null; // first package.json wins, even if no imports field
    }
    if (!dir) return null;
    const lastSlash = dir.lastIndexOf("/");
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : "";
  }
}

/**
 * Load and execute a JS/JSON module from VFS.
 * Returns the module.exports value.
 */
function __loadModule(resolvedPath) {
  if (__moduleCache.has(resolvedPath)) return __moduleCache.get(resolvedPath);

  // Prevent circular require: set empty exports before executing
  const mod = { exports: {} };
  __moduleCache.set(resolvedPath, mod.exports);

  const code = __readFileOr(resolvedPath, null);
  if (code === null) throw new Error("Cannot read module: " + resolvedPath);

  // JSON
  if (resolvedPath.endsWith(".json")) {
    mod.exports = JSON.parse(code);
    __moduleCache.set(resolvedPath, mod.exports);
    return mod.exports;
  }

  // JS — wrap in function and execute with scoped require
  const modDir = resolvedPath.includes("/") ? resolvedPath.substring(0, resolvedPath.lastIndexOf("/")) : ".";
  const scopedRequire = (id) => __requireFrom(id, modDir);
  scopedRequire.resolve = (id) => {
    const r = __resolveFrom(id, modDir);
    if (!r) throw new Error("Cannot resolve '" + id + "'");
    return r;
  };
  scopedRequire.cache = __moduleCache;
  scopedRequire.main = null;

  try {
    // Use pre-compiled function from startup (new Function allowed at module eval time)
    // Normalize path to match VFS bundle key format (no leading /)
    const normalizedPath = resolvedPath.replace(/^\\/+/, "");
    const precompiled = __compiledModules.get(normalizedPath) || __compiledModules.get(resolvedPath);
    if (precompiled) {
      precompiled(mod.exports, scopedRequire, mod, "/" + resolvedPath, "/" + modDir);
    } else {
      // Fallback: try new Function at request time (works if eval is permitted)
      try {
        const fn = new Function("exports", "require", "module", "__filename", "__dirname", code);
        fn(mod.exports, scopedRequire, mod, "/" + resolvedPath, "/" + modDir);
      } catch (evalErr) {
        if (evalErr.message && evalErr.message.includes("Code generation from strings disallowed")) {
          throw new Error("Cannot load module '" + resolvedPath + "': file was not pre-bundled. Add it to the VFS bundle.");
        }
        throw evalErr;
      }
    }
  } catch (e) {
    __moduleCache.delete(resolvedPath);
    throw e;
  }

  // Update cache with final exports (module.exports may have been reassigned)
  __moduleCache.set(resolvedPath, mod.exports);
  return mod.exports;
}

/**
 * Resolve a module ID from a given directory.
 * Returns the resolved VFS path, or null.
 */
function __resolveFrom(id, fromDir) {
  // Relative path
  if (id.startsWith("./") || id.startsWith("../") || id.startsWith("/")) {
    let base;
    if (id.startsWith("/")) {
      base = id.replace(/^\\/+/, "");
    } else {
      // VFS paths are stored without leading /. __pathMod.resolve treats
      // a non-absolute fromDir as relative-to-cwd which would corrupt the
      // result (audit §3.7-bug). Force-absolutise fromDir before resolving,
      // then strip the leading / again.
      const absFromDir = fromDir.startsWith("/") ? fromDir : "/" + fromDir;
      base = __pathMod.resolve(absFromDir, id).replace(/^\\/+/, "");
    }
    return __resolveFile(base);
  }
  // imports field (#name)
  if (id.startsWith("#")) {
    return __resolveImportsField(id, fromDir);
  }
  // Bare specifier → node_modules resolution
  return __resolveNodeModule(id, fromDir);
}

/**
 * require() from a specific directory context.
 * This is what each loaded module gets as its require function.
 */
function __requireFrom(id, fromDir) {
  // Check builtins first (always takes priority)
  if (builtins[id]) return builtins[id];
  if (id.startsWith("node:")) {
    const bare = id.substring(5);
    if (builtins[bare]) return builtins[bare];
  }

  const resolved = __resolveFrom(id, fromDir);
  if (!resolved) throw new Error("Cannot find module '" + id + "' (from " + fromDir + ")");

  return __loadModule(resolved);
}

/**
 * Top-level require() — resolves from cwd/dirname.
 * This is the require passed to the user's entry script.
 */
function __require(id) {
  return __requireFrom(id, dirname || cwd || "/home/user");
}
__require.resolve = (id) => {
  const r = __resolveFrom(id, dirname || cwd || "/home/user");
  if (!r) throw new Error("Cannot resolve '" + id + "'");
  return "/" + r;
};
__require.cache = __moduleCache;
__require.main = null;

// ═══════════════════════════════════════════════════════════════════════
// ── END OF GENERATED SHIMS — closing marker ─────────────────────────
// (builtins block has been moved above the resolver functions)
// ═══════════════════════════════════════════════════════════════════════
`;
}
