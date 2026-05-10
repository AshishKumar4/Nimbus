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
import { getExportsResolverJS } from '../_shared/exports-resolver.js';

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
  return { join, resolve, dirname, basename, extname, normalize, isAbsolute, relative, sep: "/", delimiter: ":", posix: null, win32: null };
})();
__pathMod.posix = __pathMod;
// X.5-Z5 §3 follow-on: enhanced-resolve (transitive via @tailwindcss/vite
// → vite → enhanced-resolve) reads path.win32.normalize / .dirname at
// import time. We have no real win32 paths in workerd's VFS, so the
// posix implementation is functionally correct for any path content the
// workers will ever see. Aliasing posix to win32 satisfies the structural
// contract without spawning a separate code path. See
// audit/sections/X5Z5-build-retro.md §3.
__pathMod.win32 = __pathMod;

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
    // X.5-O: WHATWG-URL → POSIX path coercion. Pre-fix String(p) on
    // a URL instance or 'file://' string produced 'file:///package.json';
    // that failed the startsWith('/') guard below and got misrouted via
    // path.resolve(cwd, 'file:///…') → corrupt path → ENOENT (verify-90993b3
    // §3 bucket O: vite). Strip 'file://' and unwrap URL instances first.
    // See audit/probes/x5npqo/functional/o-fs-url.mjs.
    let s;
    if (p && typeof p === "object" && p.protocol === "file:" && typeof p.pathname === "string") {
      // URL instance — pathname is already a POSIX path with leading /
      try { s = decodeURIComponent(p.pathname); } catch { s = p.pathname; }
    } else {
      s = String(p);
      if (s.startsWith("file://")) {
        // 'file:///abs' → '/abs', 'file://host/abs' → '/abs'
        const tail = s.slice(7);
        const slashIdx = tail.indexOf("/");
        const pathPart = tail.startsWith("/") ? tail : (slashIdx >= 0 ? tail.slice(slashIdx) : "/" + tail);
        try { s = decodeURIComponent(pathPart); } catch { s = pathPart; }
      }
    }
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

  // ── realpathSync (X.5-T per X5Z5-plan §4.3 + X526b-retro §3.1) ──
  // VFS has no symlinks; identity-resolve to the absolute path. The
  // .native static is required by TypeScript's getNodeSystem at
  // typescript.js:8291 (see audit/probes/x5t/functional/realpath-native-defined.mjs).
  function realpathSync(p, opts) { return _resolve(String(p)); }
  realpathSync.native = realpathSync;

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
    realpathSync,
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
  // X.5-Z5 (Z5 §1 follow-on): every method that reads/writes \`this._e\`
  // lazy-initializes it. Userland (notably express's createApplication
  // — express/lib/express.js:36-42) mixin-copies EventEmitter.prototype
  // onto a plain function via merge-descriptors; the EE constructor
  // never runs on that target so \`_e\` is undefined. The lazy guard
  // \`(this._e ??= {})\` matches Node's behaviour (Node initializes
  // _events on first use too) and makes mixin-copy patterns safe.
  // See audit/sections/X5Z5-build-retro.md §3.
  class EE {
    constructor() { this._e = {}; this._maxListeners = 10; }
    on(n, fn) { const e = (this._e ??= {}); (e[n] = e[n] || []).push(fn); return this; }
    addListener(n, fn) { return this.on(n, fn); }
    once(n, fn) { const w = (...a) => { this.off(n, w); fn(...a); }; w.__orig = fn; return this.on(n, w); }
    off(n, fn) { const e = (this._e ??= {}); if (e[n]) e[n] = e[n].filter(f => f !== fn && f.__orig !== fn); return this; }
    removeListener(n, fn) { return this.off(n, fn); }
    removeAllListeners(n) { if (n) { const e = (this._e ??= {}); delete e[n]; } else this._e = {}; return this; }
    emit(n, ...a) { const e = (this._e ??= {}); const fns = e[n]; if (!fns || !fns.length) return false; for (const fn of [...fns]) fn(...a); return true; }
    listeners(n) { const e = (this._e ??= {}); return (e[n] || []).map(f => f.__orig || f); }
    listenerCount(n) { const e = (this._e ??= {}); return (e[n] || []).length; }
    eventNames() { const e = (this._e ??= {}); return Object.keys(e).filter(k => e[k].length > 0); }
    setMaxListeners(n) { this._maxListeners = n; return this; }
    getMaxListeners() { return this._maxListeners; }
    prependListener(n, fn) { const e = (this._e ??= {}); (e[n] = e[n] || []).unshift(fn); return this; }
    rawListeners(n) { const e = (this._e ??= {}); return e[n] || []; }
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
  // X.5-Q: util.types polyfill expansion. The pre-X.5-Q 3-method shape
  // (isDate, isRegExp, isPromise) was insufficient for jsdom's bundled
  // undici, which dereferences isUint8Array (lib/web/fetch/util.js +
  // body.js), isArrayBuffer (lib/web/websocket/websocket.js), and
  // util.types.isProxy (lib/web/fetch/headers.js). Expanding to the
  // 17-method shape below mirrors Node.js's util.types surface for the
  // common cases; isProxy returns false (no userland Proxy detection).
  // See audit/probes/x5npqo/investigate/Q-undici-types-survey.md and
  // audit/probes/x5npqo/functional/q-util-types.mjs.
  types: {
    isDate: (v) => v instanceof Date,
    isRegExp: (v) => v instanceof RegExp,
    isPromise: (v) => v instanceof Promise,
    isUint8Array: (v) => v instanceof Uint8Array,
    isArrayBuffer: (v) => v instanceof ArrayBuffer,
    isAnyArrayBuffer: (v) => v instanceof ArrayBuffer
      || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer),
    isArrayBufferView: (v) => ArrayBuffer.isView(v),
    isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
    isMap: (v) => v instanceof Map,
    isSet: (v) => v instanceof Set,
    isWeakMap: (v) => v instanceof WeakMap,
    isWeakSet: (v) => v instanceof WeakSet,
    isNativeError: (v) => v instanceof Error,
    isAsyncFunction: (v) => v && v.constructor && v.constructor.name === "AsyncFunction",
    isGeneratorFunction: (v) => v && v.constructor && v.constructor.name === "GeneratorFunction",
    isProxy: (v) => false,
    isBoxedPrimitive: (v) => v instanceof Boolean || v instanceof Number
      || v instanceof String || (typeof v === "object" && v !== null && (v.constructor === Symbol || v.constructor === BigInt)),
  },
  inherits: (c, s) => {
    // X.5-Z5 Defect-B fix: guard against null/undefined superCtor or a
    // superCtor whose .prototype is null/undefined. Without this guard,
    // Object.create(undefined.prototype, ...) and Object.create(null, ...)
    // both throw 'Object prototype may only be an Object or null: undefined'
    // — same surface as Defect A but for shim namespaces with no synthetic
    // .prototype. Mirrors the canonical inherits_browser.js fallback.
    // See audit/sections/X5Z5-plan.md §1.3 Defensive fix.
    if (s == null || s.prototype == null) return;
    c.super_ = s;
    c.prototype = Object.create(s.prototype, { constructor: { value: c, enumerable: false, writable: true, configurable: true } });
  },
  deprecate: (fn, msg) => fn,
  debuglog: () => () => {},
  isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
};

// ═══════════════════════════════════════════════════════════════════════
// ──  url module ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// X.5-M (M-3): lenient URL constructor for rolldown-bundled CJS packages.
//
// Rolldown/rollup-bundled CJS packages (vite v7, esbuild plugins, …)
// emit at module top-level:
//
//     const X = new URL("../../../src/node/constants.ts", import.meta.url);
//
// where the rolldown-CJS polyfill for import.meta.url evaluates to literal
// null (the bare word) in our facet (no document, no location, polyfill doesn't reach
// __filename for CJS-loaded modules — see audit/sections/X5M-plan.md §1
// M-3 + audit/probes/x5m/investigate/vite-url-stack{5,A,B,D}.txt).
//
// workerd's URL constructor strict-rejects null/undefined base, throwing
// "Invalid URL string." at module top-level eval — breaks require('vite').
//
// Fix: wrap globalThis.URL so null/undefined base for a string input
// defaults to "file:///" (after first trying the input as an absolute
// URL). All other URL behaviour is passthrough; instanceof checks and
// static methods (canParse, parse, createObjectURL, ...) preserved.
//
// Stage A (this commit): vite no longer throws at the URL constructor;
// it now progresses to a deeper fs-URL composition gap (vite passes URL
// instances / file:// strings to fs.readFileSync, which our fs shim
// doesn't strip) — that's out-of-charter, see X5M-retro §3.
//
// X.5-M3 (this section): when esbuild ESM-to-CJS pre-compile substitutes
// import.meta.url with undefined (its documented empty-import-meta
// warning behavior), new URL(rel, undefined) falls into the null-base
// branch below. Pre-M3 the fallback was a literal "file:///", which
// resolved every new URL("../foo", import.meta.url) to root-relative
// file:///foo — wrong for vite/dist/node/chunks/logger.js:75 et al.
//
// M3 plumbs the currently-loading module's path via globalThis.__currentModulePath
// (set+restored by __loadModule per call). When set, the fallback becomes
// "file:///" + __currentModulePath so relative URLs resolve against
// the real on-VFS module location — restoring proper import.meta.url
// semantics for ESM-transformed CJS. See audit/sections/X5M3-plan.md §3.
(() => {
  const _Orig = globalThis.URL;
  class _Shim extends _Orig {
    constructor(input, base) {
      if (base == null && typeof input === "string") {
        try { super(input); return; }
        catch {
          // X.5-M3: prefer current module path when known, so
          //   new URL(rel, undefined) === new URL(rel, "file:///" + __filename)
          // matches real ESM import-meta-url resolution.
          const cur = globalThis.__currentModulePath;
          const fallback = (typeof cur === "string" && cur.length > 0)
            ? "file:///" + cur.replace(/^\\/+/, "")
            : "file:///";
          super(input, fallback);
          return;
        }
      }
      super(input, base);
    }
  }
  for (const k of Object.getOwnPropertyNames(_Orig)) {
    if (typeof _Orig[k] === "function" && !(k in _Shim)) {
      try { _Shim[k] = _Orig[k].bind(_Orig); } catch (_e) {}
    }
  }
  // NOTE: cannot reassign _Shim.prototype = _Orig.prototype — workerd treats
  // class.prototype as read-only. Inheritance via "extends _Orig" is enough:
  // _Shim instances are instanceof _Orig, and _Shim.prototype's __proto__ is
  // _Orig.prototype (so all native URL methods are reachable via the chain).
  globalThis.URL = _Shim;
})();
const __urlMod = {
  URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
  parse: (s) => { try { const u = new URL(s); return { protocol: u.protocol, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, href: u.href, host: u.host }; } catch { return { href: s }; } },
  format: (o) => { if (typeof o === "string") return o; if (o instanceof URL) return o.href; return (o.protocol || "http:") + "//" + (o.hostname || "") + (o.port ? ":" + o.port : "") + (o.pathname || "/") + (o.search || ""); },
  resolve: (from, to) => new URL(to, from).href,
  pathToFileURL: (p) => new URL("file://" + p),
  fileURLToPath: (u) => (typeof u === "string" ? u : u.pathname).replace(/^file:\\/\\//, ""),
};
__urlMod.URL = globalThis.URL;

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

// ═══════════════════════════════════════════════════════════════════════
// ──  child_process — W8 facet-mapped impl ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// Routes through __supervisor.cp{Spawn,StdinWrite,StdinEnd,ReadOutput,
// DrainOutput,Kill,Wait}. When __supervisor is unavailable (rare — the
// facet is normally instantiated with one), every API surfaces a clean
// ERR_CHILD_PROCESS_UNAVAILABLE error rather than silently returning
// success.
//
// Key differences from the pre-W8 stub:
//   1. spawn() actually spawns. Returns a ChildProcess emitter whose
//      stdio streams are real workerd Readable/Writable instances.
//   2. exec/execFile route through spawn (Node-doc semantics). The
//      callback fires (err, stdout, stderr) once the child exits.
//   3. fork() establishes a JSON-newline IPC channel via the stdin
//      queue. ChildProcess.send(msg)→cpStdinWrite of JSON.stringify(msg)+'\\n'.
//      Phase 1 limit: messages are JSON, NOT v8.serialize. Buffer/Date
//      project to their JSON shapes ({type:'Buffer',data:[...]} and
//      ISO strings respectively). Documented in cp-fork-ipc.mjs probe.
//   4. spawnSync/execSync are FAKE-SYNC: they kick off the async spawn
//      and return a sentinel that resolves under a normal microtask
//      drain. The facet's existing __pendingIO drain handles the rest.
//      cross-spawn.sync uses execSync; husky uses spawnSync for git
//      config queries — both rely on this fake-sync working.
//   5. Live children are tracked in __cpChildren so the facet's exit-
//      time drain (see __cpDrainAllChildren below) can issue a
//      cpDrainOutput RPC for each before reportExit fires. This is
//      the BLOCKER-1 fix from W8-plan §8.5: without it, output from
//      unawaited children dies between the last 'data' poll and the
//      facet's reportExit.
const __cpChildren = new Map();   // pid → ChildProcess (for exit-time drain)

const __childProcessMod = (() => {
  const HAS_SUPERVISOR = !!(__supervisor && typeof __supervisor.cpSpawn === "function");

  /**
   * Create a workerd-PassThrough that auto-resumes when a 'data' listener
   * is attached. Nimbus's __streamMod.Readable does NOT auto-resume on
   * addListener('data') the way real Node does, so we patch in the
   * behaviour by overriding addListener/on for 'data'. Without this,
   * cross-spawn-style consumers that call .on('data', cb) never see
   * chunks (the Readable buffer fills, flowing stays null).
   */
  function _makeReadable() {
    const r = new __streamMod.PassThrough();
    // Default encoding to utf8 so consumers see strings (matches the
    // common cross-spawn / husky pattern of reading text). Callers can
    // override via .setEncoding('hex'), .setEncoding(null), etc.
    let _encoding = "utf8";
    r.setEncoding = function(enc) { _encoding = enc; return r; };
    const origOn = r.on.bind(r);
    function patched(event, listener) {
      // Wrap data listener to decode bytes per current encoding.
      if (event === "data" && typeof listener === "function") {
        const wrapped = (chunk) => {
          let out = chunk;
          if (_encoding && (chunk instanceof Uint8Array)) {
            try { out = new TextDecoder(_encoding === "buffer" ? "utf-8" : _encoding).decode(chunk); }
            catch { out = chunk; }
          }
          return listener(out);
        };
        // Stash so removeListener still works against the original.
        listener.__wrapped = wrapped;
        const result = origOn("data", wrapped);
        if (typeof r.resume === "function") {
          try { r.resume(); } catch {}
        }
        return result;
      }
      return origOn(event, listener);
    }
    r.on = patched;
    r.addListener = patched;
    return r;
  }

  /**
   * Create a workerd-Writable backed by cpStdinWrite RPC.
   * Decodes Uint8Array chunks to UTF-8 strings before pushing to RPC
   * (workerd's Writable encodes string→bytes internally; we need to
   * round-trip back to a string for the supervisor's stdin queue).
   */
  function _toUtf8(chunk) {
    if (typeof chunk === "string") return chunk;
    if (chunk instanceof Uint8Array) {
      try { return new TextDecoder("utf-8").decode(chunk); } catch { return String(chunk); }
    }
    return String(chunk);
  }
  function _makeWritable(child) {
    const w = new __streamMod.Writable({
      write(chunk, enc, cb) {
        const s = _toUtf8(chunk);
        if (!child.pid) {
          // Child not yet spawned — buffer until pid available.
          child._pendingStdin = child._pendingStdin || [];
          child._pendingStdin.push(s);
          cb();
          return;
        }
        if (!HAS_SUPERVISOR) { cb(new Error("ERR_CHILD_PROCESS_UNAVAILABLE")); return; }
        Promise.resolve(__supervisor.cpStdinWrite(child.pid, s))
          .then(() => cb())
          .catch((e) => cb(e));
      },
      final(cb) {
        if (!child.pid) { cb(); return; }
        if (!HAS_SUPERVISOR) { cb(); return; }
        Promise.resolve(__supervisor.cpStdinEnd(child.pid))
          .then(() => cb())
          .catch(() => cb()); // best-effort end
      },
    });
    return w;
  }

  /** Normalize stdio config to a 3-tuple of 'pipe'|'ignore'|'inherit'. */
  function _normalizeStdio(stdio) {
    if (!stdio) return ["pipe", "pipe", "pipe"];
    if (Array.isArray(stdio)) {
      const a = stdio.slice(0, 3);
      while (a.length < 3) a.push("pipe");
      return a.map((v) => (v === "ignore" || v === "inherit" || v === "pipe") ? v : "pipe");
    }
    if (stdio === "ignore" || stdio === "inherit" || stdio === "pipe") return [stdio, stdio, stdio];
    return ["pipe", "pipe", "pipe"];
  }

  /** Build a fresh ChildProcess emitter with real streams. */
  function _makeChild(opts) {
    const stdio = _normalizeStdio((opts || {}).stdio);
    const child = new __eventsMod();
    child.pid = 0;
    child.connected = false;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    // For 'inherit' or 'ignore', set the corresponding stream to null
    // (Node-doc semantics). 'inherit' → parent's stdio; we don't have
    // one, so null is the closest honest value. Consumers that try to
    // attach .on('data', ...) on null will throw — same as real Node.
    child.stdin  = stdio[0] === "pipe" ? _makeWritable(child) : null;
    child.stdout = stdio[1] === "pipe" ? _makeReadable() : null;
    child.stderr = stdio[2] === "pipe" ? _makeReadable() : null;
    child.stdio = [child.stdin, child.stdout, child.stderr];
    child._pendingKill = null;       // {signal} if kill called before pid
    child._exitFired = false;
    child._closeFired = false;
    // For non-piped fds, treat them as already-ended so 'close' can
    // fire after exit without waiting for end events that never come.
    child._stdoutEnded = stdio[1] !== "pipe";
    child._stderrEnded = stdio[2] !== "pipe";
    // Listen to the underlying streams' 'end' events so 'close' fires
    // only after actual data has flushed.
    if (child.stdout) {
      child.stdout.on("end", () => { child._stdoutEnded = true; _maybeFireClose(child); });
    }
    if (child.stderr) {
      child.stderr.on("end", () => { child._stderrEnded = true; _maybeFireClose(child); });
    }

    child.kill = function(signal) {
      // Node semantics: kill() returns true even on already-exited
      // children (it's a best-effort syscall). Reserve false for "no
      // pid known" (kill called before spawn settled and we have
      // nothing to queue).
      const sig = signal || "SIGTERM";
      child.killed = true;
      if (child._exitFired) return true;
      if (!child.pid) { child._pendingKill = { signal: sig }; return true; }
      if (!HAS_SUPERVISOR) return true;
      __pendingIO.push(
        Promise.resolve(__supervisor.cpKill(child.pid, sig)).catch(() => {}),
      );
      return true;
    };
    child.ref = function() { return child; };
    child.unref = function() { return child; };
    child.disconnect = function() {
      child.connected = false;
      try { child.emit("disconnect"); } catch {}
    };

    return child;
  }

  /**
   * Coalesce the close event: emit only after exit AND both streams
   * have ended. Once close fires, evict the child from __cpChildren so
   * a long-running parent that spawns thousands of children doesn't
   * leak ChildProcess emitters + PassThrough buffers into memory.
   */
  function _maybeFireClose(child) {
    if (child._exitFired && child._stdoutEnded && child._stderrEnded && !child._closeFired) {
      child._closeFired = true;
      try { child.emit("close", child.exitCode, child.signalCode); } catch {}
      // Evict from the live-children map after a microtask so any
      // close listeners that re-read child state see consistent values.
      queueMicrotask(() => {
        try { if (child.pid) __cpChildren.delete(child.pid); } catch {}
      });
    }
  }

  /**
   * Read-loop for a single fd. Long-polls cpReadOutput, pushes chunks
   * into the Readable via .push, handles closure.
   */
  async function _runReadLoop(child, fd, stream, sinceSeqRef) {
    // Exponential backoff for idle children: start at 100ms, double up
    // to 1500ms cap. Reset to 100ms whenever a chunk arrives. Caps
    // workerd subrequest budget consumption for many concurrent
    // children — a 30-way 'concurrently' would otherwise sustain 60
    // in-flight RPCs at 250ms intervals.
    let backoff = 100;
    const BACKOFF_MAX = 1500;
    while (HAS_SUPERVISOR && child.pid && !child._streamsClosed) {
      try {
        const r = await __supervisor.cpReadOutput(child.pid, fd, sinceSeqRef.value, backoff);
        if (r && Array.isArray(r.chunks) && r.chunks.length > 0) {
          backoff = 100;  // reset — child is producing
          for (const c of r.chunks) {
            stream.write(c.data);
            if (typeof c.seq === "number" && c.seq > sinceSeqRef.value) {
              sinceSeqRef.value = c.seq;
            }
          }
        } else {
          backoff = Math.min(backoff * 2, BACKOFF_MAX);
        }
        if (r && r.closed) {
          stream.end();
          // _stdoutEnded / _stderrEnded flag is set in the stream's
          // 'end' listener (see _makeChild) so 'close' fires AFTER
          // actual data flushes.
          break;
        }
      } catch (e) {
        // RPC failure → close the stream and bail.
        stream.end();
        break;
      }
    }
  }

  /**
   * Wait-loop: long-poll cpWait until the child reports exit. Emits
   * 'exit' once stamped.
   */
  async function _runWaitLoop(child) {
    while (HAS_SUPERVISOR && child.pid && !child._exitFired) {
      try {
        const r = await __supervisor.cpWait(child.pid, 1000);
        if (r && r.done) {
          child.exitCode = r.exitCode;
          child.signalCode = r.signal;
          child._exitFired = true;
          try { child.emit("exit", r.exitCode, r.signal || null); } catch {}
          _maybeFireClose(child);
          break;
        }
      } catch (e) {
        // Couldn't wait — synthesize an error exit.
        child.exitCode = 1;
        child._exitFired = true;
        try { child.emit("exit", 1, null); } catch {}
        _maybeFireClose(child);
        break;
      }
    }
  }

  /**
   * Internal spawn primitive. Always returns a ChildProcess emitter;
   * any failure (no supervisor, bad cmd) surfaces via 'error' + 'exit'
   * events, never a synchronous throw.
   */
  function _spawn(cmd, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || [];
    opts = opts || {};
    const child = _makeChild(opts);

    if (!HAS_SUPERVISOR) {
      queueMicrotask(() => {
        const err = Object.assign(new Error("ERR_CHILD_PROCESS_UNAVAILABLE"), {
          code: "ERR_CHILD_PROCESS_UNAVAILABLE", cmd,
        });
        try { child.emit("error", err); } catch {}
        child._exitFired = true;
        try { child.emit("exit", 1, null); } catch {}
        // End the streams synchronously; their 'end' listeners flip the
        // _stdoutEnded/_stderrEnded flags and trigger _maybeFireClose.
        try { child.stdout && child.stdout.end(); } catch {}
        try { child.stderr && child.stderr.end(); } catch {}
        _maybeFireClose(child);
      });
      return child;
    }

    // Issue cpSpawn asynchronously. Return the emitter immediately so
    // callers can attach 'data' listeners before any chunk arrives.
    __pendingIO.push((async () => {
      try {
        const r = await __supervisor.cpSpawn({
          command: cmd,
          args,
          env: { ...(__processMod.env || {}), ...(opts.env || {}) },
          cwd: opts.cwd || cwd || "/home/user",
          stdio: opts.stdio || ["pipe", "pipe", "pipe"],
          detached: !!opts.detached,
          shell: opts.shell || false,
        });
        child.pid = r.childPid;
        child.connected = true;
        __cpChildren.set(child.pid, child);
        try { child.emit("spawn"); } catch {}

        // Flush any stdin written before pid was known.
        if (child._pendingStdin && child._pendingStdin.length > 0) {
          for (const d of child._pendingStdin) {
            __pendingIO.push(__supervisor.cpStdinWrite(child.pid, d).catch(() => {}));
          }
          child._pendingStdin = null;
        }

        // Flush a queued kill if .kill() was called before pid landed.
        if (child._pendingKill) {
          const sig = child._pendingKill.signal;
          child._pendingKill = null;
          __pendingIO.push(__supervisor.cpKill(child.pid, sig).catch(() => {}));
        }

        // Start the loops.  Each of these is its own async task pushed
        // onto __pendingIO so the facet's main drain knows to await.
        // For non-piped fds (stdio: 'inherit' or 'ignore'), the stream
        // is null and we skip the read-loop entirely.
        const stdoutSeq = { value: 0 };
        const stderrSeq = { value: 0 };
        if (child.stdout) __pendingIO.push(_runReadLoop(child, 1, child.stdout, stdoutSeq));
        if (child.stderr) __pendingIO.push(_runReadLoop(child, 2, child.stderr, stderrSeq));
        __pendingIO.push(_runWaitLoop(child));
      } catch (e) {
        try { child.emit("error", e); } catch {}
        child._exitFired = true;
        try { child.emit("exit", 1, null); } catch {}
        try { child.stdout && child.stdout.end(); } catch {}
        try { child.stderr && child.stderr.end(); } catch {}
        _maybeFireClose(child);
      }
    })());

    return child;
  }

  /**
   * exec(cmd, opts, cb) — Node semantics: passes cmd to a shell
   * (we use 'sh -c'). Buffers stdout/stderr; cb fires once on exit.
   */
  function exec(cmd, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    opts = opts || {};
    // Use sh -c so shell metacharacters work for husky/concurrently/etc.
    const child = _spawn("sh", ["-c", cmd], { ...opts, shell: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    // Use 'close' (fires after exit AND both stdio streams ended) so all
    // chunks have landed before cb resolves.
    child.on("close", (code) => {
      if (cb) {
        if (code === 0) cb(null, stdout, stderr);
        else {
          const err = Object.assign(new Error("Command failed: " + cmd), {
            code, cmd, stdout, stderr,
          });
          cb(err, stdout, stderr);
        }
      }
    });
    return child;
  }

  /**
   * execFile(file, args, opts, cb) — like exec but no shell.
   */
  function execFile(file, args, opts, cb) {
    if (typeof args === "function") { cb = args; args = []; opts = {}; }
    if (typeof opts === "function") { cb = opts; opts = {}; }
    opts = opts || {};
    const child = _spawn(file, args || [], { ...opts, shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code) => {
      if (cb) {
        if (code === 0) cb(null, stdout, stderr);
        else {
          const err = Object.assign(new Error("Command failed: " + file), {
            code, stdout, stderr,
          });
          cb(err, stdout, stderr);
        }
      }
    });
    return child;
  }

  /**
   * Fake-sync spawn. Phase-1 limit: V8/Workers can't truly block JS
   * execution. We approximate "synchronous" semantics by:
   *   1. Issuing the underlying _spawn (which queues async work onto
   *      __pendingIO).
   *   2. Returning a result object that LAZILY accumulates fields as
   *      stdout/stderr/exit events fire. Callers like cross-spawn.sync
   *      that read result.status get null until the spawn settles.
   *   3. When the parent facet's main drain settles __pendingIO before
   *      reportExit (facet-manager.ts), the result object's fields are
   *      filled in by the time the supervisor sees the parent exit.
   *
   * Cross-spawn.sync's typical pattern is "const r = spawnSync(...);
   * if (r.status !== 0) throw". To make THIS work synchronously, we
   * also expose a .__deferred promise; idiomatic Nimbus consumers
   * await r.__deferred to get a fully-populated result. Probes test
   * both shapes.
   *
   * Real Node spawnSync truly blocks the event loop via libuv; matching
   * that semantic in workerd would require Atomics.wait on shared state
   * which workerd doesn't expose to userland. Phase 1 documents this.
   */
  function spawnSync(cmd, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || []; opts = opts || {};
    const child = _spawn(cmd, args, opts);
    let stdout = "", stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => { stdout += String(d); });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += String(d); });

    const result = { pid: 0, stdout: "", stderr: "", status: null, signal: null, output: [null, "", ""] };
    let _done = false;
    result.__deferred = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        result.pid = child.pid;
        result.stdout = stdout;
        result.stderr = stderr;
        result.status = code;
        result.signal = signal;
        result.output = [null, stdout, stderr];
        _done = true;
        resolve(result);
      });
    });
    // Best-effort eager population: as 'data' events flow we already
    // mutate stdout/stderr above; once 'exit' fires we also populate
    // .status synchronously (before 'close' which fires after streams
    // drain). This narrows the window where a sync caller sees
    // status=null.
    child.on("exit", (code, signal) => {
      if (result.status === null) result.status = code;
      if (result.signal === null) result.signal = signal;
    });
    return result;
  }

  function execSync(cmd, opts) {
    opts = opts || {};
    const r = spawnSync("sh", ["-c", cmd], { ...opts, shell: true });
    // Caller awaits __deferred under normal drain.
    return r;
  }

  function execFileSync(file, args, opts) {
    args = args || []; opts = opts || {};
    return spawnSync(file, args, opts);
  }

  /**
   * fork(modulePath, args, opts) — spawn a child node facet with an IPC
   * channel. IPC is JSON-newline over the stdin queue. Phase-1 limits:
   *   - Buffer → {type:'Buffer', data:[...]} (JSON.stringify projection)
   *   - Date   → ISO string
   *   - Map/Set lose all entries (become {})
   * Documented + asserted in cp-fork-ipc.mjs.
   */
  function fork(modulePath, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || []; opts = opts || {};
    // The child runs the requested module with __NIMBUS_FORK_IPC=1 in env
    // so a corresponding fork-aware runtime in the child knows to listen
    // on stdin for IPC frames.
    const childEnv = { ...(__processMod.env || {}), ...(opts.env || {}), NIMBUS_FORK_IPC: "1" };
    const child = _spawn("node", [modulePath, ...args], { ...opts, env: childEnv });
    child.connected = true;
    child.send = function(msg) {
      if (!child.connected) return false;
      if (!child.stdin) return false;
      try {
        const line = JSON.stringify(msg) + "\\n";
        child.stdin.write(line);
        return true;
      } catch (e) {
        return false;
      }
    };
    // 'message' events: parent listens to child.stdout newline-
    // delimited and parses each as JSON. Real Node IPC uses a side-
    // channel fd; Phase 1 multiplexes through stdout. Any well-formed
    // JSON line counts as a message — non-JSON lines are dropped
    // silently (real fork would route them to stderr-style handling).
    // No __nimbusIpc envelope: round-trip is symmetric with the
    // parent's child.send which writes raw JSON.stringify(msg)+'\\n'.
    child.stdout.on("data", (d) => {
      const lines = String(d).split("\\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try { msg = JSON.parse(trimmed); }
        catch { continue; }
        try { child.emit("message", msg); } catch {}
      }
    });
    child.on("exit", () => {
      child.connected = false;
      try { child.emit("disconnect"); } catch {}
    });
    return child;
  }

  /**
   * Exit-time drain: walk __cpChildren and issue cpDrainOutput RPCs so
   * any unawaited children's stdout lands before the facet's reportExit.
   * Called automatically by the facet's exit path AND exposed for tests.
   */
  async function __cpDrainAllChildren() {
    if (!HAS_SUPERVISOR) return;
    const drains = [];
    for (const [pid, child] of __cpChildren) {
      drains.push((async () => {
        try {
          const r = await __supervisor.cpDrainOutput(pid);
          if (r && r.stdout && child.stdout) {
            try { child.stdout.write(r.stdout); } catch {}
          }
          if (r && r.stderr && child.stderr) {
            try { child.stderr.write(r.stderr); } catch {}
          }
          // Force-close streams so listeners receive 'end'. The 'end'
          // event listeners in _makeChild flip _stdoutEnded/_stderrEnded.
          try { child.stdout && child.stdout.end(); } catch {}
          try { child.stderr && child.stderr.end(); } catch {}
          if (!child._exitFired) {
            // No exit reported yet — wait briefly, then synthesize.
            try {
              const w = await __supervisor.cpWait(pid, 500);
              if (w && w.done) {
                child.exitCode = w.exitCode;
                child.signalCode = w.signal;
              } else {
                child.exitCode = child.exitCode == null ? 0 : child.exitCode;
              }
            } catch {
              child.exitCode = child.exitCode == null ? 0 : child.exitCode;
            }
            child._exitFired = true;
            try { child.emit("exit", child.exitCode, child.signalCode); } catch {}
          }
          _maybeFireClose(child);
        } catch { /* best-effort */ }
      })());
    }
    await Promise.allSettled(drains);
  }

  return {
    spawn: _spawn,
    spawnSync,
    exec,
    execSync,
    execFile,
    execFileSync,
    fork,
    ChildProcess: __eventsMod,
    __cpDrainAllChildren,    // exposed for the facet exit hook + tests
  };
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
// X.5-R: real Node's \`require('stream')\` re-exports EventEmitter
// (verified: \`require('stream').EventEmitter === require('events').EventEmitter\`
// in Node 20). Older CJS code reads EE off the stream module instead of
// events — e.g., @redis/client/dist/lib/client/cache.js:301:
// \`class ClientSideCacheProvider extends stream_1.EventEmitter {}\` where
// \`stream_1 = require("stream")\`. Without this re-export, \`stream_1.EventEmitter\`
// is undefined and \`class … extends undefined\` throws "Class extends value
// undefined is not a constructor or null". See audit/sections/X5R-plan.md §3
// + audit/probes/x5r/functional/r-stream-eventemitter-shape.mjs.
// Idempotent guard so a future streams.ts revision that already exposes
// EventEmitter doesn't get clobbered.
if (!__streamMod.EventEmitter) __streamMod.EventEmitter = __eventsMod;
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
    // X.5-M (M-1): http.Server.setTimeout no-op for fastify.
    // fastify's lib/server.js calls server.setTimeout(connectionTimeout)
    // immediately after createServer(). Pre-X5M the Server class lacked
    // this method → "TypeError: server.setTimeout is not a function".
    // Mirror the net.Socket.setTimeout pattern at the bottom of this file
    // (same builtins/net IIFE): no-op + chainable. Idle timeouts have no
    // facet-side meaning (we don't own outbound TCP), but we honour the
    // 1-arg callback form so listeners that emit on 'timeout' still run.
    setTimeout(ms, cb) { if (typeof ms === "function") { cb = ms; } if (cb) this.on("timeout", cb); return this; }
    setKeepAlive() { return this; }
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
// X.5-Z5 §3 follow-on: minimal v8 stub for jiti (used transitively by
// @tailwindcss/vite). jiti reads v8.startupSnapshot.isBuildingSnapshot()
// to decide whether to skip JIT compilation; workerd never builds v8
// snapshots, so 'false' is the correct answer. Other v8 introspection
// APIs (cachedDataVersionTag, getHeapStatistics, etc.) return inert
// values that satisfy the shape contract without offering real data.
// See audit/sections/X5Z5-build-retro.md §3.
builtins.v8 = {
  startupSnapshot: {
    isBuildingSnapshot: () => false,
    addSerializeCallback: () => {},
    addDeserializeCallback: () => {},
    setDeserializeMainFunction: () => {},
    setDeserializeData: () => {},
  },
  cachedDataVersionTag: () => 0,
  getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0, malloced_memory: 0 }),
  getHeapSpaceStatistics: () => [],
  setFlagsFromString: () => {},
  serialize: (v) => __BufferMod.from(JSON.stringify(v)),
  deserialize: (b) => JSON.parse(__BufferMod.from(b).toString()),
  writeHeapSnapshot: () => "",
};
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

// X.5-M (M-2): dns/promises subpath registration for redis.
// @redis/client/dist/lib/client does require('dns/promises') to do
// hostname → IP resolution. Pre-fix the only exposure was
// builtins.dns.promises (an object property of the parent dns shim);
// __requireFrom matches keys exactly, so 'dns/promises' missed.
// Mirror the timers/promises pattern above. builtins.dns.promises is
// already a complete object (DoH-backed lookup/resolve/resolve4) —
// re-exposing it as a subpath builtin is a 2-line registration.
builtins["dns/promises"] = builtins.dns.promises;
builtins["node:dns/promises"] = builtins["dns/promises"];

// X.5-Q: util/types subpath registration for jsdom's bundled undici.
// undici@7.x calls require('node:util/types').{isUint8Array,isArrayBuffer}
// directly from lib/web/fetch/util.js + body.js + websocket/websocket.js.
// __requireFrom matches keys exactly; pre-fix the only exposure was
// builtins.util.types (object property of parent util shim), so the
// subpath missed. Mirror the dns/promises (M-2) pattern. The
// builtins.util.types object is the X.5-Q-expanded 17-method polyfill
// (see line 707), sufficient for undici@7.25.0 + undici@8.2.0.
// See audit/probes/x5npqo/investigate/Q-undici-types-survey.md.
builtins["util/types"] = builtins.util.types;
builtins["node:util/types"] = builtins["util/types"];

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
// W3.5 Fix A: strict-file membership probe. __fileExists also returns true for
// directories (it has to — __resolveNodeModule and __resolveImportsField call
// it to check whether a node_modules/<pkg> directory exists). __resolveFile's
// empty-extension probe needs the inverse: "is this an actual file?" — so the
// loop falls through to /index.js when "base" is a directory rather than
// short-circuiting and returning the directory path (which __loadModule then
// can't read, throwing "Cannot read module: <dir>"). See W3 retro §S3 for
// the fastify ret/dist/types failure.
function __pathIsFile(path) {
  const k = path.replace(/^\\/+/, "");
  if (__vfsBundle && k in __vfsBundle) return true;
  if (__vfsWrites && k in __vfsWrites) return true;
  // Deliberately does NOT consult __vfsDirs nor do the prefix scan.
  return false;
}
function __resolveFile(base) {
  // Extensions probed when a path doesn't include one. Must mirror the
  // install-time pre-bundler: see audit/sections/03-resolver-gaps.md §3.5.
  // The first ext is "" (exact-match). It must be probed via __pathIsFile,
  // not __fileExists, so directories don't short-circuit before /index.* —
  // see W3.5-plan.md §1 Failure 1.
  const exts = ["", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.cjs", "/index.mjs", "/index.json"];
  for (const ext of exts) {
    const cand = base + ext;
    if (ext === "") {
      if (__pathIsFile(cand)) return cand;
      continue;
    }
    if (__fileExists(cand)) return cand;
  }
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
  // X.5-F R3: ESM-condition fallback for pure-ESM packages whose
  // dist/.mjs files were transformed to CJS by transformEsmInBundle
  // at install time (facet-manager.ts:842, W3.5 Fix B). Without this,
  // packages like nuxt — whose exports map only contains
  // {types, import} for the root subpath — return null from the CJS
  // walk and dead-end with "Cannot find module 'nuxt'" even though
  // dist/index.mjs is in the bundle and runnable as CJS. We only fall
  // back when the package actually declares an exports map (so we
  // don't shadow legit "package not installed" misses).
  if (entry == null && pkg.exports != null) {
    entry = resolvePackageEntry(pkg, subpath, DEFAULT_ESM_CONDITIONS);
  }
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

// ═══════════════════════════════════════════════════════════════════════
// ──  X.5-S: __mkCompiledFn — conditional-param-rename wrap for new Function
// ═══════════════════════════════════════════════════════════════════════
//
// vite's chunks/node.js (transitive bundle of open@10.2.0) contains the
// ESM idiom \`const __dirname = path.dirname(fileURLToPath(import.meta.url))\`.
// W3.5 Fix B's esbuild ESM→CJS transform preserves that line verbatim
// while substituting \`import.meta\` with \`const import_meta = {}\`. Wrapping
// the body in \`new Function("exports","require","module","__filename","__dirname", code)\`
// then collides at parse time:
//
//     SyntaxError: Identifier '__dirname' has already been declared
//
// (VERIFY-23417C5 §4 #1 / X5M3-retro §"Next bucket".) The helper RENAMES
// the conflicting param to a placeholder name so the body's own
// \`const __dirname\` becomes the single declarer. We rename rather than
// drop because callers pass 5 positional arguments and dropping a slot
// would mis-align downstream slots (e.g. the USER_CODE wrap appends
// \`console\` / \`process\` / etc. after \`__dirname\`). Renaming preserves
// slot alignment while letting the body's binding win.
//
// Symmetric for \`__filename\` because open@10's idiom often emits both.
// See audit/sections/X5S-plan.md §3, audit/probes/x5s/investigation/repro.mjs.
function __mkCompiledFn(code) {
  const reFn = /(?:^|\\n|;)\\s*(?:const|let|var)\\s+__filename\\s*=/m;
  const reDn = /(?:^|\\n|;)\\s*(?:const|let|var)\\s+__dirname\\s*=/m;
  const fnName = reFn.test(code) ? "__filename__nimbus_unused" : "__filename";
  const dnName = reDn.test(code) ? "__dirname__nimbus_unused"  : "__dirname";
  return new Function("exports", "require", "module", fnName, dnName, code);
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
  // G2 (runtime-pkg wave): scopedRequire.main mirrors the top-level
  // __require.main (set to the entry module by the runner). Pre-fix
  // it was hardcoded null, so:
  //   - 'require.main' inside a sub-module returned null
  //   - 'require.main === module' was false for the entry too
  //     (because in the entry, require.main was null too)
  //
  // Post-fix: in the ENTRY, __require.main === entry's module ⇒
  // require.main === module is true. In a SUB-MODULE (loaded via
  // __loadModule), scopedRequire.main === entry's module, but
  // module === sub-module's mod, so require.main === module is
  // FALSE — exactly the canonical 'is this file being executed
  // directly?' semantics.
  scopedRequire.main = __require.main;

  // X.5-M3: thread currently-loading module path through globalThis so the
  // URL shim null-base fallback (in node-shims url module) can compose
  // relative URLs against the real module location — synthesizing
  // import.meta.url semantics for ESM that esbuild CJS-emit reduced to
  // const import_meta = {}. Save+restore for recursive __loadModule.
  // See audit/sections/X5M3-plan.md §3.
  const __prevModulePath = globalThis.__currentModulePath;
  globalThis.__currentModulePath = resolvedPath;
  try {
    // Use pre-compiled function from startup (new Function allowed at module eval time)
    // Normalize path to match VFS bundle key format (no leading /)
    const normalizedPath = resolvedPath.replace(/^\\/+/, "");
    const precompiled = __compiledModules.get(normalizedPath) || __compiledModules.get(resolvedPath);
    // G2/G3 (runtime-pkg wave): pass console/process/Buffer + timer
    // shims into every sub-module so process.exit() inside a required
    // file routes through __processMod (NOT workerd's real process,
    // which crashes with 'Canceling the request'). Pre-fix call site
    // passed only 5 params; sub-modules' references to these globals
    // resolved up the V8 scope chain to workerd's real bindings.
    //
    // The compile-time params list at manager.ts already added the
    // extras; here we provide them at call time. Order MUST match
    // the params list at manager.ts:225+.
    if (precompiled) {
      precompiled(
        mod.exports, scopedRequire, mod, "/" + resolvedPath, "/" + modDir,
        __consoleMod, __processMod, __BufferMod,
        globalThis.setTimeout, globalThis.setInterval, globalThis.clearTimeout, globalThis.clearInterval,
      );
    } else {
      // Fallback: try new Function at request time (works if eval is permitted)
      // X.5-S: conditional-param-rename via __mkCompiledFn — see helper
      // comment above. Without this, esbuild-transformed ESM that declares
      // \`const __dirname = …\` at top level (e.g. vite's chunks/node.js)
      // collides with the previously hardcoded \`__dirname\` parameter.
      try {
        // G2/G3: same extra-params extension on the fallback path.
        const fn = __mkCompiledFn(code, [
          "console", "process", "Buffer",
          "setTimeout", "setInterval", "clearTimeout", "clearInterval",
        ]);
        fn(
          mod.exports, scopedRequire, mod, "/" + resolvedPath, "/" + modDir,
          __consoleMod, __processMod, __BufferMod,
          globalThis.setTimeout, globalThis.setInterval, globalThis.clearTimeout, globalThis.clearInterval,
        );
      } catch (evalErr) {
        // W3.5 Fix C: if the file was in the bundle but its pre-compile
        // failed at facet startup, surface the original SyntaxError
        // instead of the misleading "file was not pre-bundled" text.
        // See audit/sections/W3.5-plan.md §1 Failure 2.
        const normalizedPath2 = resolvedPath.replace(/^\\/+/, "");
        const compileErr =
          (typeof __compileFailures !== "undefined" && __compileFailures &&
            (__compileFailures.get(normalizedPath2) || __compileFailures.get(resolvedPath))) || null;
        if (compileErr) {
          throw new Error(
            "Cannot load module '" + resolvedPath +
            "': pre-compile failed at facet startup: " + compileErr,
          );
        }
        if (evalErr.message && evalErr.message.includes("Code generation from strings disallowed")) {
          throw new Error("Cannot load module '" + resolvedPath + "': file was not pre-bundled. Add it to the VFS bundle.");
        }
        throw evalErr;
      }
    }
  } catch (e) {
    __moduleCache.delete(resolvedPath);
    throw e;
  } finally {
    globalThis.__currentModulePath = __prevModulePath;
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
  // X.5-P: literal "." / ".." are CommonJS aliases for "./" / "../".
  // Pre-fix they slipped past the startsWith("./")/("../") guards (which
  // require >= 3 / >= 4 chars respectively) and fell into the bare-spec
  // branch — querying __resolveNodeModule for a package literally named
  // "." → "Cannot find module '.'" (verify-90993b3 §3 bucket P:
  // fastify via ajv/dist/compile/jtd, redis via @redis/client/dist/lib/client).
  // Normalize so they take the relative-resolve branch (which then probes
  // index.js / package.json#main via __resolveFile). See
  // audit/probes/x5npqo/functional/p-parent-dir.mjs.
  if (id === ".") id = "./";
  else if (id === "..") id = "../";
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
