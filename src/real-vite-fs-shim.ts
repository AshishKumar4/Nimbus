/**
 * real-vite-fs-shim.ts — Phase 1 VFS-backed fs shim for the real-vite facet.
 *
 * What this file exports:
 *
 *   generateFsShimModuleCode()  — returns the ESM source of the module the
 *                                 facet imports as `node:fs` (via
 *                                 the esbuild alias in
 *                                 scripts/bundle-real-vite.mjs).
 *   generateFsPromisesShimModuleCode()
 *                               — ditto for `node:fs/promises`.
 *   buildFsSnapshot(vfs, root)  — supervisor-side helper that walks the
 *                                 SqliteVFS and returns a `{path: content}`
 *                                 snapshot to seed the facet's sync-fs Map.
 *
 * Design notes:
 *
 *   workerd facets are **async-only** for RPC. But Vite's code (and its
 *   bundled deps like readdirp, picomatch, magic-string, etc.) calls a
 *   LOT of synchronous node:fs functions during module initialization
 *   and config resolution — readFileSync, existsSync, statSync,
 *   readdirSync. We can't block on SUPERVISOR.readFile() from a sync
 *   call site.
 *
 *   Solution: the supervisor pre-builds an in-memory snapshot of the
 *   project VFS (all text files + synthetic vite package.json +
 *   node_modules of known-useful packages) and passes it to the facet
 *   via a synthetic `synthetic.js` module that seeds
 *   globalThis.__cirrusRealSynthetic. Every sync fs call first checks
 *   that Map. Async fs.promises calls fall through to
 *   env.SUPERVISOR.readFile(), letting Vite's middleware read files
 *   modified after boot.
 *
 *   Writes (writeFile, writeFileSync, mkdir, mkdirSync, rename, unlink)
 *   update the facet-local Map immediately AND fire an async RPC to
 *   the supervisor. Sync writes are best-effort fire-and-forget — the
 *   supervisor eventually persists, but a sync writer that reads back
 *   what it just wrote will Just Work because the local Map is
 *   coherent.
 *
 *   Watch (fs.watch, fs.watchFile): the facet runs a long-poll loop
 *   against SUPERVISOR.waitForVfsEvents(), translating VFS events into
 *   chokidar-shaped callbacks. This module exposes a minimal FSWatcher
 *   class that Vite's bundled chokidar sees via the esbuild alias
 *   (chokidar → this module).
 *
 *   All this logic is emitted as a JS string and loaded into the
 *   facet via LOADER.load({ modules }). Keeping it here (in a .ts
 *   source file) instead of a .generated.ts means editor + typecheck
 *   can read it even though TypeScript doesn't compile it.
 */

import type { SqliteVFS } from './sqlite-vfs.js';

/**
 * Walk the VFS and produce a snapshot suitable for seeding the facet's
 * sync-fs Map.
 *
 * Included:
 *   - Everything under `root/` except large binary blobs (over 256 KB)
 *     and files that won't be read synchronously (images, fonts, .node,
 *     .map > 1 MB).
 *   - Every `package.json` under `root/node_modules/**` (needed for
 *     Vite's dep resolver walk-ups).
 *   - All `.js/.mjs/.cjs/.ts/.tsx/.jsx/.css/.json/.html/.svg` text files
 *     under `root/node_modules/vite/**` (Vite's own client assets) and
 *     `root/node_modules/@vitejs/**` (plugin source).
 *
 * Excluded:
 *   - Binary .node addons (workerd can't load them anyway).
 *   - .git/** (irrelevant).
 *   - Any file > MAX_FILE_BYTES (skipped with a diagnostic).
 *
 * Returns a Record<path, content>. Paths are absolute filesystem paths
 * as seen by Vite (/home/user/app/src/main.tsx).
 */
const MAX_FILE_BYTES = 256 * 1024;           // 256 KB per file
const MAX_TOTAL_USER_BYTES = 16 * 1024 * 1024; // 16 MB cap on USER project
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts',
  '.json', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.vue', '.svelte', '.astro',
  '.svg', '.md', '.mdx', '.txt',
  '.map',
]);
const SKIP_DIRS_IN_USER_PROJECT = new Set([
  '.git', '.cache', '.svelte-kit', 'coverage',
  '.next', '.nuxt', '.parcel-cache',
  '.wrangler', '.turbo', '.vercel',
  'dist', 'build',
  'node_modules', // walked separately, lazily
]);

function isLikelyText(filename: string): boolean {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return false;
  return TEXT_EXTENSIONS.has(filename.slice(idx).toLowerCase());
}

/**
 * Build a LAZY snapshot of the project for the facet's sync-fs Map.
 *
 * What gets eagerly seeded:
 *   - Every file under the user project (outside node_modules) up to
 *     16 MB total.
 *   - Every package.json under node_modules/** (needed for Vite's
 *     resolver walk-ups and for __cirrusRealUserspaceRequire).
 *
 * What does NOT get eagerly seeded:
 *   - Everything else in node_modules (JS source, CSS, etc.).
 *
 * Not-eagerly-seeded files are fetched on demand via the
 * SUPERVISOR.readFile RPC from the facet's async fs-promises shim,
 * AND populate the in-facet Map the first time they're read so
 * subsequent sync reads hit local memory.
 *
 * This keeps the facet boot memory footprint bounded (typical real
 * React project: ~2 MB instead of 10+ MB) while still delivering
 * correctness — Vite reads deps lazily during the transform pipeline,
 * so async-first-then-cache is the natural fit.
 */
export function buildFsSnapshot(
  vfs: SqliteVFS,
  projectRoot: string,
): {
  files: Record<string, string>;
  dirs: string[];
  existingPaths: string[];
  totalBytes: number;
  skipped: number;
  fileCount: number;
  packageJsonCount: number;
  pathIndexCount: number;
} {
  const files: Record<string, string> = {};
  const dirsSet = new Set<string>();
  // existingPaths: a LIGHTWEIGHT index of every file path in
  // node_modules (paths only, no content). The fs-shim's existsSync
  // and statSync consult this so Vite's resolver walks deep
  // module trees correctly without us having to eager-cache every
  // file. Async readFile RPCs fetch content on demand.
  //
  // Path-only storage is cheap: ~50-100 bytes per path × thousands
  // of files ≈ several hundred KB. Compare with content (avg 5 KB
  // per file × thousands = tens of MB).
  const existingPaths: string[] = [];
  let totalBytes = 0;
  let skipped = 0;
  let pkgJsonCount = 0;

  const pRoot = projectRoot.replace(/^\/+/, '').replace(/\/+$/, '');

  // Pass 1: walk the user project tree (skipping node_modules) and
  // seed every text file up to the byte budget.
  function walkUserTree(relDir: string, depth: number) {
    if (depth > 32) return;
    if (totalBytes >= MAX_TOTAL_USER_BYTES) return;
    let entries: { name: string; type: string }[];
    try { entries = vfs.readdir(relDir); } catch { return; }
    dirsSet.add('/' + relDir);
    for (const entry of entries) {
      const childRel = relDir ? relDir + '/' + entry.name : entry.name;
      const absPath = '/' + childRel;
      if (entry.type === 'directory') {
        if (SKIP_DIRS_IN_USER_PROJECT.has(entry.name)) continue;
        walkUserTree(childRel, depth + 1);
      } else if (entry.type === 'file') {
        const isPkgJson = entry.name === 'package.json';
        if (!isPkgJson && !isLikelyText(entry.name)) { skipped++; continue; }
        if (totalBytes >= MAX_TOTAL_USER_BYTES) { skipped++; continue; }
        try {
          const st = vfs.stat(childRel);
          if (st.size > MAX_FILE_BYTES && !isPkgJson) { skipped++; continue; }
          const content = vfs.readFileString(childRel);
          files[absPath] = content;
          totalBytes += content.length;
        } catch { skipped++; }
      }
    }
  }

  // Pass 2: walk every node_modules/** package.json AND collect the
  // entry files it points at (main / module / exports.* / types).
  // Without this, Vite's resolvePackageEntry uses fs.existsSync to
  // test entry paths — which returns false for files NOT in our
  // snapshot, making the resolver fail with
  // `Failed to resolve entry for package "react"`.
  //
  // We extract all plausible entry paths from the package.json's
  // exports/main/module/browser fields and eagerly include just
  // those specific files (and any subpath exports they reference).
  // Typical package yields 2-5 entries, so the byte cost is
  // bounded.
  const entryFilesToSeed: Set<string> = new Set();

  function collectExportPaths(node: unknown, out: Set<string>): void {
    if (!node) return;
    if (typeof node === 'string') {
      if (node.startsWith('./')) out.add(node.slice(2));
      return;
    }
    if (Array.isArray(node)) { for (const n of node) collectExportPaths(n, out); return; }
    if (typeof node === 'object') {
      for (const k of Object.keys(node as object)) {
        collectExportPaths((node as Record<string, unknown>)[k], out);
      }
    }
  }

  function walkNodeModules(relDir: string, depth: number) {
    if (depth > 32) return;
    let entries: { name: string; type: string }[];
    try { entries = vfs.readdir(relDir); } catch { return; }
    dirsSet.add('/' + relDir);
    for (const entry of entries) {
      const childRel = relDir ? relDir + '/' + entry.name : entry.name;
      const absPath = '/' + childRel;
      if (entry.type === 'directory') {
        if (entry.name === '.bin' || entry.name === '.cache' ||
            entry.name === 'node_modules' || entry.name === 'test' ||
            entry.name === 'tests' || entry.name === '__tests__' ||
            entry.name === 'docs' || entry.name === 'doc' ||
            entry.name === 'examples' || entry.name === 'example') {
          continue;
        }
        walkNodeModules(childRel, depth + 1);
      } else if (entry.type === 'file') {
        // Index the path (cheap — string only, no content).
        // Used by fs.existsSync / statSync so Vite's resolver walks
        // deep module imports correctly without paying to cache the
        // content eagerly.
        existingPaths.push(absPath);
        if (entry.name === 'package.json') {
          try {
            const content = vfs.readFileString(childRel);
            files[absPath] = content;
            totalBytes += content.length;
            pkgJsonCount++;
            const pkg = JSON.parse(content);
            const pkgDir = childRel.slice(0, -('/package.json'.length));
            const candidates = new Set<string>();
            if (typeof pkg.main === 'string') candidates.add(pkg.main);
            if (typeof pkg.module === 'string') candidates.add(pkg.module);
            if (typeof pkg.browser === 'string') candidates.add(pkg.browser);
            if (typeof pkg.types === 'string') candidates.add(pkg.types);
            if (typeof pkg.typings === 'string') candidates.add(pkg.typings);
            if (pkg.exports) collectExportPaths(pkg.exports, candidates);
            if (pkg.imports) collectExportPaths(pkg.imports, candidates);
            for (const idx of ['index.js', 'index.mjs', 'index.cjs']) {
              candidates.add(idx);
            }
            for (const rel of candidates) {
              const clean = rel.replace(/^\.\//, '');
              if (!clean || clean.includes('*')) continue;
              entryFilesToSeed.add(pkgDir + '/' + clean);
            }
          } catch { skipped++; }
        }
      }
    }
  }

  walkUserTree(pRoot, 0);
  const nmPath = pRoot + '/node_modules';
  if (vfs.exists(nmPath)) walkNodeModules(nmPath, 0);

  // Pass 3: read every entry file collected above. Cap at ~256KB/file
  // since some packages ship big bundles we don't need eagerly.
  for (const rel of entryFilesToSeed) {
    const abs = '/' + rel;
    if (files[abs]) continue;
    try {
      const st = vfs.stat(rel);
      if (st.type !== 'file') continue;
      if (st.size > MAX_FILE_BYTES) { skipped++; continue; }
      const content = vfs.readFileString(rel);
      files[abs] = content;
      totalBytes += content.length;
    } catch { /* missing — that's OK */ }
  }

  return {
    files,
    dirs: [...dirsSet].sort(),
    existingPaths,
    totalBytes,
    skipped,
    fileCount: Object.keys(files).length,
    packageJsonCount: pkgJsonCount,
    pathIndexCount: existingPaths.length,
  };
}

/**
 * ESM source of the fs-shim module. esbuild's bundler sees
 *   import * as fs from 'node:fs'
 * in vite's bundle and (thanks to the alias plugin in
 * scripts/bundle-real-vite.mjs) rewrites those imports to this
 * module. The shim exports every fs name Vite touches, routing them
 * through `globalThis.__cirrusRealFs` — which we populate before the
 * first import of vite.bundle.js in synthetic.js.
 *
 * The runtime lives in globalThis so it survives cross-module
 * lookups AND can be re-seeded on facet reload.
 */
export function generateFsShimModuleCode(): string {
  // The shim is plain ESM. It re-exports a handful of names that most
  // libraries import from 'node:fs', routing reads through a Map we
  // populate before the first vite.bundle.js import. The constants
  // from the real node:fs are passed through.
  return `
// ── fs shim (sync) — generated by src/real-vite-fs-shim.ts ────────
import * as _real from 'real-node-fs.js';

// The supervisor-seeded snapshot + live-write overlay.
// Shape: {
//   files: Map<absPath, string>         — cached content
//   dirs: Set<absPath>                  — directories known to exist
//   existingPaths: Set<absPath>         — node_modules file paths
//                                         (content lazy; index only)
// }
// Seeded by synthetic.js BEFORE vite.bundle.js evaluates.
const _g = globalThis;
if (!_g.__cirrusRealFs) _g.__cirrusRealFs = { files: new Map(), dirs: new Set(), existingPaths: new Set() };
if (!_g.__cirrusRealFs.existingPaths) _g.__cirrusRealFs.existingPaths = new Set();

function _norm(p) {
  if (p == null) return null;
  if (typeof p === 'object') {
    // URL-ish
    try { p = p.pathname || String(p); } catch { return null; }
  }
  if (typeof p !== 'string') return null;
  return p.replace(/^file:\\/\\//, '').replace(/\\/+$/, p === '/' ? '/' : '');
}

function _makeStats(size, isDir) {
  return {
    isFile: () => !isDir,
    isDirectory: () => !!isDir,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size: size | 0,
    mtime: new Date(0), ctime: new Date(0), atime: new Date(0), birthtime: new Date(0),
    mtimeMs: 0, ctimeMs: 0, atimeMs: 0, birthtimeMs: 0,
    mode: isDir ? 0o040755 : 0o100644,
    uid: 0, gid: 0, ino: 0, nlink: 1, dev: 0, rdev: 0, blksize: 4096, blocks: 1,
  };
}

// ── Sync read methods ──
export const readFileSync = function(p, ...rest) {
  let n = _norm(p);
  if (globalThis.__cirrusFsDebug) console.log('[fs.readFileSync]', n);
  if (globalThis.__cirrusResolveDebug && n && (n.includes('/react/') || n.includes('/react-dom/'))) console.log('[fs.readFileSync react]', n);
  // Relative paths: the caller used _require.resolve("./x") which
  // didn't fully resolve. Try the snapshot with ./x stripped to /x.
  if (n && n.startsWith('./')) n = '/' + n.slice(2);
  // Special case: rollup's wasm binding. Return the pre-seeded bytes.
  if (n && n.endsWith('bindings_wasm_bg.wasm') && _g.__cirrusRealFs.getWasmBytes) {
    const bytes = _g.__cirrusRealFs.getWasmBytes();
    const opts = rest[0], enc = typeof opts === 'string' ? opts : opts?.encoding;
    if (enc === 'base64') return btoa(String.fromCharCode(...bytes));
    return bytes;
  }
  if (n != null && _g.__cirrusRealFs.files.has(n)) {
    const c = _g.__cirrusRealFs.files.get(n);
    const opts = rest[0], enc = typeof opts === 'string' ? opts : opts?.encoding;
    if (enc) return c;
    try { return globalThis.Buffer.from(c, 'utf-8'); }
    catch { return new TextEncoder().encode(c); }
  }
  try { return _real.readFileSync.call(_real, p, ...rest); }
  catch (e) {
    throw new Error('[cirrus-real fs] readFileSync missing from snapshot: ' + n + ' (' + (e?.message || e) + ')');
  }
};

export const existsSync = function(p) {
  const n = _norm(p);
  if (globalThis.__cirrusFsDebug) console.log('[fs.existsSync]', n);
  if (n != null) {
    if (_g.__cirrusRealFs.files.has(n)) return true;
    if (_g.__cirrusRealFs.dirs.has(n)) return true;
    // Path-only index: answers "is this file in VFS?" without the
    // file being eagerly cached. Vite's tryNodeResolve / tryFsResolve
    // rely on existsSync to walk deep node_modules trees.
    if (_g.__cirrusRealFs.existingPaths.has(n)) return true;
    // Also treat any parent-dir of a known file as existing.
    for (const k of _g.__cirrusRealFs.files.keys()) {
      if (k.startsWith(n + '/')) return true;
    }
    // Check the path index for subpath-existence too (faster than
    // iterating \`files\`).
    const nSlash = n + '/';
    for (const k of _g.__cirrusRealFs.existingPaths) {
      if (k.startsWith(nSlash)) return true;
    }
  }
  try { return _real.existsSync.call(_real, p); } catch { return false; }
};

export const statSync = function(p, ...rest) {
  const n = _norm(p);
  if (globalThis.__cirrusFsDebug && n && (n.includes('react') || n.includes('/src/'))) console.log('[fs.statSync]', n);
  if (n != null) {
    if (_g.__cirrusRealFs.files.has(n)) return _makeStats(_g.__cirrusRealFs.files.get(n).length, false);
    if (_g.__cirrusRealFs.dirs.has(n)) return _makeStats(0, true);
    // Path-only index: we know the file exists but don't have its
    // size. Return a placeholder stat with size=0 (accurate enough
    // for resolver logic — it only checks isFile()/isDirectory()).
    if (_g.__cirrusRealFs.existingPaths.has(n)) return _makeStats(0, false);
    for (const k of _g.__cirrusRealFs.files.keys()) {
      if (k.startsWith(n + '/')) return _makeStats(0, true);
    }
    const nSlash = n + '/';
    for (const k of _g.__cirrusRealFs.existingPaths) {
      if (k.startsWith(nSlash)) return _makeStats(0, true);
    }
  }
  try { return _real.statSync.call(_real, p, ...rest); }
  catch (e) {
    if (rest[0]?.throwIfNoEntry === false) return undefined;
    throw e;
  }
};

export const lstatSync = statSync;

export const realpathSync = function(p) {
  const n = _norm(p);
  if (n != null && (_g.__cirrusRealFs.files.has(n) || _g.__cirrusRealFs.dirs.has(n) || _g.__cirrusRealFs.existingPaths.has(n))) return n;
  try { return _real.realpathSync.call(_real, p); } catch { return n || p; }
};
realpathSync.native = realpathSync;

export const readdirSync = function(p, opts) {
  const n = _norm(p);
  const out = new Set();
  const outTypes = new Map();
  if (n != null) {
    // Collect direct children from files + dirs.
    const prefix = n === '/' ? '/' : n + '/';
    for (const k of _g.__cirrusRealFs.files.keys()) {
      if (k.startsWith(prefix)) {
        const rel = k.slice(prefix.length);
        const slash = rel.indexOf('/');
        if (slash < 0) {
          out.add(rel);
          outTypes.set(rel, 'file');
        } else {
          const seg = rel.slice(0, slash);
          out.add(seg);
          if (!outTypes.has(seg)) outTypes.set(seg, 'directory');
        }
      }
    }
    // Path-only index: include those too.
    for (const k of _g.__cirrusRealFs.existingPaths) {
      if (k.startsWith(prefix)) {
        const rel = k.slice(prefix.length);
        const slash = rel.indexOf('/');
        if (slash < 0) {
          out.add(rel);
          if (!outTypes.has(rel)) outTypes.set(rel, 'file');
        } else {
          const seg = rel.slice(0, slash);
          out.add(seg);
          if (!outTypes.has(seg)) outTypes.set(seg, 'directory');
        }
      }
    }
    for (const d of _g.__cirrusRealFs.dirs) {
      if (d.startsWith(prefix)) {
        const rel = d.slice(prefix.length);
        const slash = rel.indexOf('/');
        const seg = slash < 0 ? rel : rel.slice(0, slash);
        if (seg) { out.add(seg); if (!outTypes.has(seg)) outTypes.set(seg, 'directory'); }
      }
    }
  }
  const names = [...out].sort();
  if (names.length === 0) {
    try { return _real.readdirSync.call(_real, p, opts); } catch { /* empty */ }
  }
  if (opts?.withFileTypes) {
    return names.map((name) => {
      const t = outTypes.get(name) || 'file';
      return {
        name,
        isFile: () => t === 'file',
        isDirectory: () => t === 'directory',
        isSymbolicLink: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      };
    });
  }
  return names;
};

export const accessSync = function(p) {
  if (!existsSync(p)) throw new Error('ENOENT: ' + p);
};

// ── Sync write methods ──
// Update the in-facet Map synchronously so subsequent reads see the
// change, then fire-and-forget an RPC to the supervisor for
// persistence. Callers that must wait for the write to persist
// should use fs.promises.writeFile instead.
export const writeFileSync = function(p, data, opts) {
  const n = _norm(p);
  if (n == null) throw new Error('writeFileSync: invalid path');
  let content;
  if (typeof data === 'string') content = data;
  else if (data && typeof data.toString === 'function') content = new TextDecoder('utf-8').decode(data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data));
  else content = String(data);
  _g.__cirrusRealFs.files.set(n, content);
  // Register parent dirs
  let cur = n;
  while (cur.lastIndexOf('/') > 0) {
    cur = cur.slice(0, cur.lastIndexOf('/'));
    _g.__cirrusRealFs.dirs.add(cur);
  }
  // Fire-and-forget RPC — if SUPERVISOR is bound, persist.
  const sup = _g.__cirrusRealSupervisor;
  if (sup?.writeFile) {
    sup.writeFile(n.replace(/^\\/+/, ''), content).catch((e) => {
      console.warn('[cirrus-real fs] async writeFile RPC failed for', n, e?.message);
    });
  }
};

export const mkdirSync = function(p, opts) {
  const n = _norm(p);
  if (n == null) return undefined;
  _g.__cirrusRealFs.dirs.add(n);
  if (opts?.recursive) {
    let cur = n;
    while (cur.lastIndexOf('/') > 0) {
      cur = cur.slice(0, cur.lastIndexOf('/'));
      _g.__cirrusRealFs.dirs.add(cur);
    }
  }
  const sup = _g.__cirrusRealSupervisor;
  if (sup?.mkdir) {
    sup.mkdir(n.replace(/^\\/+/, '')).catch(() => {});
  }
  return n;
};

export const unlinkSync = function(p) {
  const n = _norm(p);
  if (n != null) _g.__cirrusRealFs.files.delete(n);
  const sup = _g.__cirrusRealSupervisor;
  if (sup?.unlink) sup.unlink(n.replace(/^\\/+/, '')).catch(() => {});
};

export const rmSync = unlinkSync;
export const rmdirSync = function(p) { /* no-op */ };

export const renameSync = function(from, to) {
  const f = _norm(from), t = _norm(to);
  if (f && t && _g.__cirrusRealFs.files.has(f)) {
    _g.__cirrusRealFs.files.set(t, _g.__cirrusRealFs.files.get(f));
    _g.__cirrusRealFs.files.delete(f);
  }
  const sup = _g.__cirrusRealSupervisor;
  if (sup?.writeFile && f && t && _g.__cirrusRealFs.files.has(t)) {
    sup.writeFile(t.replace(/^\\/+/, ''), _g.__cirrusRealFs.files.get(t)).catch(() => {});
    if (sup.unlink) sup.unlink(f.replace(/^\\/+/, '')).catch(() => {});
  }
};

export const appendFileSync = function(p, data) {
  const n = _norm(p);
  if (n == null) return;
  const prev = _g.__cirrusRealFs.files.get(n) || '';
  const chunk = typeof data === 'string' ? data : new TextDecoder().decode(data);
  writeFileSync(p, prev + chunk);
};

// ── Sync-shaped no-ops for things Vite occasionally touches ──
export const chmodSync = function() {};
export const chownSync = function() {};
export const utimesSync = function() {};
export const truncateSync = function() {};
export const symlinkSync = function() { throw new Error('symlinkSync not supported'); };
export const linkSync = function() { throw new Error('linkSync not supported'); };
export const readlinkSync = function() { throw new Error('readlinkSync not supported (no symlinks)'); };

// ── fs.watch ──
// Vite (via bundled chokidar) calls fs.watch in a few places. Our
// esbuild alias swaps chokidar out entirely, but the fs-shim still
// needs a safe watch() so plugins that call it directly don't explode.
// Implementation: no-op watcher that never fires. HMR is driven by
// the chokidar-alias + long-polled supervisor events, not by this.
export const watch = function() {
  return {
    close() {},
    on() { return this; },
    removeListener() {},
    addListener() { return this; },
  };
};
export const watchFile = function() {};
export const unwatchFile = function() {};

// ── Async methods (Promises + callback API) ──
// Callback-style: translate to our promise layer, then invoke the cb.
function _cb(fn) {
  return function(...args) {
    const cb = args[args.length - 1];
    if (typeof cb !== 'function') throw new Error(fn.name + ': missing callback');
    fn(...args.slice(0, -1)).then((v) => cb(null, v), (e) => cb(e));
  };
}

export const readFile = _cb(async (p, opts) => readFilePromise(p, opts));
export const writeFile = _cb(async (p, data, opts) => writeFilePromise(p, data, opts));
export const stat = _cb(async (p) => statPromise(p));
export const lstat = _cb(async (p) => statPromise(p));
export const readdir = _cb(async (p, opts) => readdirPromise(p, opts));
export const mkdir = _cb(async (p, opts) => mkdirPromise(p, opts));
export const unlink = _cb(async (p) => unlinkPromise(p));
export const rename = _cb(async (from, to) => renamePromise(from, to));
export const access = _cb(async (p) => { if (!existsSync(p)) throw new Error('ENOENT: ' + p); });
export const realpath = _cb(async (p) => realpathSync(p));
Object.defineProperty(realpath, 'native', { value: realpath });

// Async "promise-returning" helpers used by the promises module too.
// ── LRU cap to bound the facet-resident cache ──────────────────
// Without this, every big node_modules source file (framer-motion,
// lucide-react, etc.) that Vite's transform pulls in sticks in
// \`__cirrusRealFs.files\` forever. On a real React project with
// 10+ deps transformed at once, that's tens of MB — compounded
// with Babel ASTs in flight, we blow the workerd isolate memory
// budget and exit 137.
//
// Strategy:
//   - Files from the user's project (not under node_modules) are
//     ALWAYS cached — they're small, seeds into the original
//     snapshot, and needed synchronously for HMR transforms.
//   - node_modules files go in an LRU with a 4 MB budget. Every
//     cache hit touches access order; on insertion that would
//     exceed the budget, oldest entries are evicted.
//   - Files over SINGLE_FILE_CACHE_MAX (128 KB) are NEVER cached
//     at all: they're re-read from supervisor on each access.
//     Better to pay the RPC roundtrip than hold a multi-MB string
//     that only gets parsed once.
//
// Sync reads from the snapshot are immune to this eviction. Only
// async RPC fetches get capped.
const _NM_LRU_LIMIT = 4 * 1024 * 1024;
const _SINGLE_FILE_CACHE_MAX = 128 * 1024;
_g.__cirrusRealFsLruSize = 0;
_g.__cirrusRealFsLruOrder = [];

function _cacheSetLru(path, content) {
  // Only apply LRU to node_modules paths. User source stays sticky.
  const inNodeModules = path.includes('/node_modules/');
  if (!inNodeModules) {
    _g.__cirrusRealFs.files.set(path, content);
    return;
  }
  if (content.length > _SINGLE_FILE_CACHE_MAX) {
    // Too big — don't cache. Let future reads hit the supervisor again.
    return;
  }
  // Evict until there's room.
  while (_g.__cirrusRealFsLruSize + content.length > _NM_LRU_LIMIT && _g.__cirrusRealFsLruOrder.length > 0) {
    const victim = _g.__cirrusRealFsLruOrder.shift();
    const v = _g.__cirrusRealFs.files.get(victim);
    if (v !== undefined) {
      _g.__cirrusRealFsLruSize -= v.length;
      _g.__cirrusRealFs.files.delete(victim);
    }
  }
  _g.__cirrusRealFs.files.set(path, content);
  _g.__cirrusRealFsLruSize += content.length;
  _g.__cirrusRealFsLruOrder.push(path);
}

function _cacheTouchLru(path) {
  if (!path.includes('/node_modules/')) return;
  const i = _g.__cirrusRealFsLruOrder.indexOf(path);
  if (i >= 0 && i < _g.__cirrusRealFsLruOrder.length - 1) {
    _g.__cirrusRealFsLruOrder.splice(i, 1);
    _g.__cirrusRealFsLruOrder.push(path);
  }
}

export async function readFilePromise(p, opts) {
  const n = _norm(p);
  if (globalThis.__cirrusFsDebug) console.log('[fs.readFile]', n);
  const enc = typeof opts === 'string' ? opts : opts?.encoding;
  if (n != null && _g.__cirrusRealFs.files.has(n)) {
    _cacheTouchLru(n);
    const c = _g.__cirrusRealFs.files.get(n);
    if (enc) return c;
    try { return globalThis.Buffer.from(c, 'utf-8'); } catch { return new TextEncoder().encode(c); }
  }
  // Fall back to RPC (async path can block).
  const sup = _g.__cirrusRealSupervisor;
  if (sup?.readFile && n) {
    const content = await sup.readFile(n.replace(/^\\/+/, ''));
    if (typeof content === 'string') {
      _cacheSetLru(n, content);
      if (enc) return content;
      try { return globalThis.Buffer.from(content, 'utf-8'); } catch { return new TextEncoder().encode(content); }
    }
  }
  throw Object.assign(new Error('ENOENT: ' + n), { code: 'ENOENT', errno: -2, path: n });
}

export async function writeFilePromise(p, data, opts) {
  // Same as sync path but awaits the RPC.
  const n = _norm(p);
  if (n == null) throw new Error('writeFile: invalid path');
  let content;
  if (typeof data === 'string') content = data;
  else if (data instanceof Uint8Array) content = new TextDecoder('utf-8').decode(data);
  else content = String(data);
  _g.__cirrusRealFs.files.set(n, content);
  let cur = n;
  while (cur.lastIndexOf('/') > 0) {
    cur = cur.slice(0, cur.lastIndexOf('/'));
    _g.__cirrusRealFs.dirs.add(cur);
  }
  const sup = _g.__cirrusRealSupervisor;
  if (sup?.writeFile) {
    try { await sup.writeFile(n.replace(/^\\/+/, ''), content); }
    catch (e) { /* supervisor may reject for read-only paths; local copy is authoritative */ }
  }
}

export async function statPromise(p) { return statSync(p); }
export async function readdirPromise(p, opts) { return readdirSync(p, opts); }
export async function mkdirPromise(p, opts) { mkdirSync(p, opts); return p; }
export async function unlinkPromise(p) { unlinkSync(p); }
export async function renamePromise(from, to) { renameSync(from, to); }
export async function realpathPromise(p) { return realpathSync(p); }

// ── Constants + other exports Vite + deps look for ──
// _real may be a module namespace with direct named exports OR a
// default-exporting wrapper — pick whichever has the function. Keeps
// the shim robust across node / workerd import-resolution quirks.
function _pick(name) {
  return (_real && (_real[name] || _real.default?.[name])) || (() => { throw new Error('[cirrus-real fs] ' + name + ' not available in workerd'); });
}
function _pickMaybe(name) {
  return (_real && (_real[name] || _real.default?.[name])) || undefined;
}
export const constants = _pickMaybe('constants') || {};
export const Stats = _pickMaybe('Stats');
export const Dirent = _pickMaybe('Dirent');
export const Dir = _pickMaybe('Dir');
export const ReadStream = _pickMaybe('ReadStream');
export const WriteStream = _pickMaybe('WriteStream');
export const createReadStream = _pickMaybe('createReadStream');
export const createWriteStream = _pickMaybe('createWriteStream');
export const opendir = _pickMaybe('opendir');
export const opendirSync = _pickMaybe('opendirSync');
export const open = _pickMaybe('open');
export const openSync = _pickMaybe('openSync');
export const close = _pickMaybe('close');
export const closeSync = _pickMaybe('closeSync');
export const read = _pickMaybe('read');
export const readSync = _pickMaybe('readSync');
export const write = _pickMaybe('write');
export const writeSync = _pickMaybe('writeSync');
export const fstat = _pickMaybe('fstat');
export const fstatSync = _pickMaybe('fstatSync');
export const fsync = _pickMaybe('fsync');
export const fsyncSync = _pickMaybe('fsyncSync');
export const fdatasync = _pickMaybe('fdatasync');
export const fdatasyncSync = _pickMaybe('fdatasyncSync');
export const ftruncate = _pickMaybe('ftruncate');
export const ftruncateSync = _pickMaybe('ftruncateSync');
export const futimes = _pickMaybe('futimes');
export const futimesSync = _pickMaybe('futimesSync');
export const fchmod = _pickMaybe('fchmod');
export const fchmodSync = _pickMaybe('fchmodSync');
export const fchown = _pickMaybe('fchown');
export const fchownSync = _pickMaybe('fchownSync');
export const readv = _pickMaybe('readv');
export const readvSync = _pickMaybe('readvSync');
export const writev = _pickMaybe('writev');
export const writevSync = _pickMaybe('writevSync');
export const mkdtemp = _pickMaybe('mkdtemp');
export const mkdtempSync = _pickMaybe('mkdtempSync');
export const cp = _pickMaybe('cp');
export const cpSync = _pickMaybe('cpSync');
export const copyFile = _pickMaybe('copyFile');
export const copyFileSync = _pickMaybe('copyFileSync');
export const appendFile = _cb(async (p, data) => { appendFileSync(p, data); });
export const chmod = _cb(async () => {});
export const chown = _cb(async () => {});
export const utimes = _cb(async () => {});
export const truncate = _cb(async () => {});
export const symlink = _cb(async () => { throw new Error('symlink not supported'); });
export const link = _cb(async () => { throw new Error('link not supported'); });
export const readlink = _cb(async () => { throw new Error('readlink not supported'); });
export const rm = _cb(async (p) => unlinkSync(p));
export const rmdir = _cb(async () => {});

// The promises namespace — re-export the Promise-shaped versions.
export const promises = {
  readFile: readFilePromise,
  writeFile: writeFilePromise,
  stat: statPromise,
  lstat: statPromise,
  readdir: readdirPromise,
  mkdir: mkdirPromise,
  unlink: unlinkPromise,
  rename: renamePromise,
  realpath: realpathPromise,
  access: async (p) => { if (!existsSync(p)) throw new Error('ENOENT: ' + p); },
  appendFile: async (p, data) => { appendFileSync(p, data); },
  chmod: async () => {},
  chown: async () => {},
  utimes: async () => {},
  truncate: async () => {},
  symlink: async () => { throw new Error('symlink not supported'); },
  link: async () => { throw new Error('link not supported'); },
  readlink: async () => { throw new Error('readlink not supported'); },
  rm: async (p) => unlinkSync(p),
  rmdir: async () => {},
  cp: _real.promises?.cp || (async () => { throw new Error('cp not supported'); }),
  copyFile: _real.promises?.copyFile || (async () => {}),
  opendir: _real.promises?.opendir || (async () => { throw new Error('opendir not supported'); }),
  mkdtemp: _real.promises?.mkdtemp || (async () => { throw new Error('mkdtemp not supported'); }),
  open: _real.promises?.open || (async () => { throw new Error('open not supported'); }),
  constants: _real.constants,
};

const _defaultExport = {
  // Shimmed (snapshot + RPC backed)
  readFileSync, existsSync, statSync, lstatSync, realpathSync, readdirSync,
  writeFileSync, mkdirSync, unlinkSync, rmSync, rmdirSync, renameSync,
  appendFileSync, accessSync, chmodSync, chownSync, utimesSync, truncateSync,
  symlinkSync, linkSync, readlinkSync, watch, watchFile, unwatchFile,
  readFile, writeFile, stat, lstat, readdir, mkdir, unlink, rename, realpath,
  access, rm, rmdir, appendFile, chmod, chown, utimes, truncate, symlink,
  link, readlink,
  // Passthrough from workerd's node:fs (may be undefined for some — the
  // _pickMaybe helper tolerates that).
  constants, Stats, Dirent, Dir, ReadStream, WriteStream,
  createReadStream, createWriteStream, opendir, opendirSync,
  open, openSync, close, closeSync, read, readSync, write, writeSync,
  fstat, fstatSync, fsync, fsyncSync, fdatasync, fdatasyncSync,
  ftruncate, ftruncateSync, futimes, futimesSync, fchmod, fchmodSync,
  fchown, fchownSync, readv, readvSync, writev, writevSync,
  mkdtemp, mkdtempSync, cp, cpSync, copyFile, copyFileSync,
  promises,
};
// Expose on globalThis for the __require polyfill so CJS callers
// that do \`require('fs')\` get the same snapshot-backed impl.
globalThis.__cirrusRealFsShim = _defaultExport;
export default _defaultExport;
`.trim();
}

/**
 * ESM source of the fs/promises shim. Thin wrapper around the main
 * fs shim so `import x from 'node:fs/promises'` picks up the
 * snapshot-backed impl.
 *
 * Uses a RELATIVE import to ./cirrus-fs.js (not 'node:fs') because
 * cirrus-fs-promises.js is loaded as a LOADER module alongside
 * cirrus-fs.js — bare 'node:fs' here would route through workerd's
 * real node:fs instead of our shim.
 */
export function generateFsPromisesShimModuleCode(): string {
  return `
// ── fs/promises shim — generated by src/real-vite-fs-shim.ts ─────
import fs from './cirrus-fs.js';
export const readFile = fs.promises.readFile;
export const writeFile = fs.promises.writeFile;
export const stat = fs.promises.stat;
export const lstat = fs.promises.lstat;
export const readdir = fs.promises.readdir;
export const mkdir = fs.promises.mkdir;
export const unlink = fs.promises.unlink;
export const rename = fs.promises.rename;
export const realpath = fs.promises.realpath;
export const access = fs.promises.access;
export const appendFile = fs.promises.appendFile;
export const chmod = fs.promises.chmod;
export const chown = fs.promises.chown;
export const utimes = fs.promises.utimes;
export const truncate = fs.promises.truncate;
export const symlink = fs.promises.symlink;
export const link = fs.promises.link;
export const readlink = fs.promises.readlink;
export const rm = fs.promises.rm;
export const rmdir = fs.promises.rmdir;
export const cp = fs.promises.cp;
export const copyFile = fs.promises.copyFile;
export const opendir = fs.promises.opendir;
export const mkdtemp = fs.promises.mkdtemp;
export const open = fs.promises.open;
export const constants = fs.promises.constants;
export default fs.promises;
`.trim();
}

/**
 * ESM source for synthetic.js — seeds the globalThis-backed
 * snapshot BEFORE vite.bundle.js evaluates. Takes the output of
 * buildFsSnapshot() plus a few hard-coded synthetic files (vite's
 * package.json + client assets) that the Phase 0 spike already
 * proved we need.
 *
 * The supervisor binding (env.SUPERVISOR) is exposed as a global
 * via the facet entrypoint — not here, because env access requires
 * an async boot step.
 */
export function generateSyntheticModuleCode(opts: {
  viteVersion: string;
  snapshotFiles: Record<string, string>;
  snapshotDirs: string[];
  /**
   * Path-only index of every file under node_modules (no content).
   * Populated by buildFsSnapshot.existingPaths. Drives existsSync /
   * statSync so Vite's resolver walks deep module trees correctly
   * without us eager-caching every file.
   */
  existingPaths?: string[];
  /**
   * Base64-encoded rollup wasm bindings.
   */
  rollupWasmBase64?: string;
  /**
   * Map from user-project CJS package file-path patterns to
   * pre-built ESM bundle code.
   */
  cjsPrebuiltBundles?: Record<string, string>;
  /**
   * Real vite client runtime (dist/client/client.mjs). Served to
   * the browser at /@vite/client. Without this the browser loads
   * a stub and HMR+env don't work.
   */
  viteClientMjs?: string;
  /**
   * Real vite env runtime (dist/client/env.mjs).
   */
  viteEnvMjs?: string;
}): string {
  const {
    viteVersion, snapshotFiles, snapshotDirs, existingPaths, rollupWasmBase64,
    cjsPrebuiltBundles, viteClientMjs, viteEnvMjs,
  } = opts;

  const vitePkgJson = JSON.stringify({
    name: 'vite', version: viteVersion, type: 'module',
    engines: { node: '>=20.0.0' }, dependencies: {},
  });

  // Pre-populated + Vite-specific synthetics. Vite's bundle has
  // import.meta.url = 'file:///vite.bundle.js' (set by our bundler),
  // so its relative URL lookups resolve under /. These entries seed
  // /package.json and /dist/client/* for Vite's self-bootstrap.
  // When the caller provides viteClientMjs/viteEnvMjs we use the REAL
  // runtime (~32 KB) so the browser's HMR client actually works;
  // otherwise we fall back to tiny stubs for server-side init.
  const viteSynthetics: Record<string, string> = {
    '/package.json': vitePkgJson,
    '/dist/client/index.html': '<!doctype html><html><head></head><body></body></html>',
    '/dist/client/client.mjs': viteClientMjs ?? '// vite client stub',
    '/dist/client/env.mjs': viteEnvMjs ?? 'export {};',
    '/dist/client/CLIENT.mjs': viteClientMjs ?? '// vite client stub (case probe)',
  };

  // Merge: snapshot files take precedence (they reflect the real
  // project), but vite synthetics fill in anything the snapshot
  // didn't cover.
  const allFiles: Record<string, string> = { ...viteSynthetics, ...snapshotFiles };

  // Emit as a Map literal. Large projects can push this to ~several
  // MB, but we're already shipping a 2.3 MB vite bundle so an extra
  // 1–3 MB of project text is acceptable.
  const entries = Object.entries(allFiles);
  const body = entries
    .map(([k, v]) => `  [${JSON.stringify(k)}, ${JSON.stringify(v)}]`)
    .join(',\n');

  const dirEntries = snapshotDirs.map((d) => JSON.stringify(d)).join(', ');

  return `
// ── Synthetic fs seed (generated by src/real-vite-fs-shim.ts) ────
// Populates globalThis.__cirrusRealFs BEFORE vite.bundle.js evaluates
// via ESM import hoisting (this module is the first import in main.js).
//
// Also pre-imports all node:* builtins that bundled CJS modules
// might require() at runtime, and exposes them via a table the
// patched __require polyfill consults before falling back to
// createRequire.

import * as __n_assert from 'node:assert';
import * as __n_buffer from 'node:buffer';
import * as __n_childProcess from 'node:child_process';
import * as __n_crypto from 'node:crypto';
import * as __n_dns from 'node:dns';
import * as __n_events from 'node:events';
import * as __n_fs from 'node:fs';
import * as __n_fsPromises from 'node:fs/promises';
import * as __n_http from 'node:http';
import * as __n_https from 'node:https';
import * as __n_module from 'node:module';
import * as __n_net from 'node:net';
import * as __n_os from 'node:os';
import * as __n_path from 'node:path';
import * as __n_perfHooks from 'node:perf_hooks';
import * as __n_process from 'node:process';
import * as __n_querystring from 'node:querystring';
import * as __n_readline from 'node:readline';
import * as __n_stream from 'node:stream';
import * as __n_string_decoder from 'node:string_decoder';
import * as __n_timers from 'node:timers';
import * as __n_timersPromises from 'node:timers/promises';
import * as __n_tls from 'node:tls';
import * as __n_tty from 'node:tty';
import * as __n_url from 'node:url';
import * as __n_util from 'node:util';
import * as __n_zlib from 'node:zlib';
import * as __n_workerThreads from 'node:worker_threads';

const _builtinTable = {
  'assert': __n_assert, 'node:assert': __n_assert,
  'buffer': __n_buffer, 'node:buffer': __n_buffer,
  'child_process': __n_childProcess, 'node:child_process': __n_childProcess,
  'crypto': __n_crypto, 'node:crypto': __n_crypto,
  'dns': __n_dns, 'node:dns': __n_dns,
  'events': __n_events, 'node:events': __n_events,
  'fs': __n_fs, 'node:fs': __n_fs,
  'fs/promises': __n_fsPromises, 'node:fs/promises': __n_fsPromises,
  'http': __n_http, 'node:http': __n_http,
  'https': __n_https, 'node:https': __n_https,
  'module': __n_module, 'node:module': __n_module,
  'net': __n_net, 'node:net': __n_net,
  'os': __n_os, 'node:os': __n_os,
  'path': __n_path, 'node:path': __n_path,
  'perf_hooks': __n_perfHooks, 'node:perf_hooks': __n_perfHooks,
  'process': __n_process, 'node:process': __n_process,
  'querystring': __n_querystring, 'node:querystring': __n_querystring,
  'readline': __n_readline, 'node:readline': __n_readline,
  'stream': __n_stream, 'node:stream': __n_stream,
  'string_decoder': __n_string_decoder, 'node:string_decoder': __n_string_decoder,
  'timers': __n_timers, 'node:timers': __n_timers,
  'timers/promises': __n_timersPromises, 'node:timers/promises': __n_timersPromises,
  'tls': __n_tls, 'node:tls': __n_tls,
  'tty': __n_tty, 'node:tty': __n_tty,
  'url': __n_url, 'node:url': __n_url,
  'util': __n_util, 'node:util': __n_util,
  'zlib': __n_zlib, 'node:zlib': __n_zlib,
  'worker_threads': __n_workerThreads, 'node:worker_threads': __n_workerThreads,
};
// Flatten \`.default\` out of namespace imports where a CJS require
// caller expects a bare module export (most do — e.g. \`require('path')\`
// returns the path module's default export, not a namespace).
const _normalize = (ns) => (ns && ns.default !== undefined && Object.keys(ns).length <= 2) ? ns.default : ns;
globalThis.__cirrusNodeBuiltinTable = {};
for (const [k, v] of Object.entries(_builtinTable)) {
  // Pass through both the namespace AND the default-collapsed form
  // because the two styles have different shapes. Storing the NS
  // directly is safer: most callers use \`path.resolve\`, which is
  // on the NS as a named export AND on the default via re-export.
  globalThis.__cirrusNodeBuiltinTable[k] = v.default ?? v;
}

// __cirrusRealUserspaceRequire: tiny VFS-backed CJS loader. Used by
// the __require polyfill in vite.bundle.js and by the rewritten
// dynamic-imports inside user-vite-config.js. Defined HERE (in
// synthetic.js) so it's available before any other LOADER module
// evaluates — essential because userspace/vitejs-plugin-react.js
// and user-vite-config.js both reach for it at module-init.
globalThis.__cirrusRealUserspaceRequire = function __cirrusRealUserspaceRequire(name) {
  const fs = globalThis.__cirrusRealFs;
  if (!fs) return null;
  // First: try the builtin table (node:*).
  const bt = globalThis.__cirrusNodeBuiltinTable?.[name];
  if (bt) return bt;
  // Walk snapshot for /<...>/node_modules/<name>/package.json.
  const pkgSuffix = '/node_modules/' + name + '/package.json';
  for (const [path, content] of fs.files) {
    if (!path.endsWith(pkgSuffix)) continue;
    try {
      const pkg = JSON.parse(content);
      const pkgDir = path.slice(0, -('package.json'.length));
      // Prefer ESM entry via exports.import.default -> module -> main
      let entry = null;
      if (pkg.exports) {
        const e = pkg.exports;
        if (typeof e === 'string') entry = e;
        else if (e['.']) {
          const d = e['.'];
          entry = typeof d === 'string' ? d : (d.import?.default || d.import || d.require || d.default);
        }
      }
      if (!entry) entry = pkg.module || pkg.main || 'index.js';
      if (typeof entry === 'object' && entry?.default) entry = entry.default;
      if (typeof entry !== 'string') continue;
      const entryAbs = pkgDir + entry.replace(/^\\.\\//, '');
      const resolvedPath = (() => {
        if (fs.files.has(entryAbs)) return entryAbs;
        for (const ext of ['.js', '.mjs', '.cjs', '.json']) {
          if (fs.files.has(entryAbs + ext)) return entryAbs + ext;
        }
        if (fs.files.has(entryAbs + '/index.js')) return entryAbs + '/index.js';
        return null;
      })();
      if (!resolvedPath) continue;
      const code = fs.files.get(resolvedPath);
      const mod = { exports: {} };
      const moduleDir = resolvedPath.slice(0, resolvedPath.lastIndexOf('/'));
      const nestedRequire = (n) => {
        const b = globalThis.__cirrusNodeBuiltinTable?.[n];
        if (b) return b;
        if (n.startsWith('./') || n.startsWith('../')) {
          // Relative require — resolve against moduleDir.
          const segs = (moduleDir + '/' + n).split('/').reduce((acc, s) => {
            if (s === '..') acc.pop();
            else if (s && s !== '.') acc.push(s);
            return acc;
          }, []);
          const relAbs = '/' + segs.join('/');
          for (const ext of ['', '.js', '.mjs', '.cjs', '.json']) {
            if (fs.files.has(relAbs + ext)) {
              const c = fs.files.get(relAbs + ext);
              if ((relAbs + ext).endsWith('.json')) return JSON.parse(c);
              const subMod = { exports: {} };
              const subWrapped = new Function('module', 'exports', 'require', '__filename', '__dirname', c);
              try { subWrapped(subMod, subMod.exports, nestedRequire, relAbs + ext, relAbs); }
              catch (e) { throw new Error('nested require failed for ' + n + ' in ' + name + ': ' + (e?.message || e)); }
              return subMod.exports;
            }
          }
          throw new Error('relative require not found: ' + n + ' from ' + moduleDir);
        }
        // Nested package require.
        const r = __cirrusRealUserspaceRequire(n);
        if (r) return r;
        throw new Error('nested userspace require failed: ' + n);
      };
      const wrapped = new Function('module', 'exports', 'require', '__filename', '__dirname', code);
      try {
        wrapped(mod, mod.exports, nestedRequire, resolvedPath, moduleDir);
      } catch (e) {
        throw new Error('userspace require failed for ' + name + ': ' + (e?.message || e));
      }
      return mod.exports;
    } catch (e) {
      if (e instanceof SyntaxError || /userspace require failed/.test(e?.message || '')) throw e;
      // Malformed package.json or similar — try next match.
    }
  }
  return null;
};

// Note: we deliberately do NOT ship a runtime CJS→ESM transform.
// workerd forbids \`new Function(src)\` / \`eval()\` outside startup
// scope, so the common "evaluate CJS, emit ESM stub" trick doesnt
// work. Instead we pre-bundle the common CJS packages at build
// time (src/cirrus-npm-cjs.generated.ts, emitted by
// scripts/bundle-npm-cjs.mjs) and ship them as an intercept
// table that the vite:esbuild transform patch checks against.

import { createRequire as __cirrusCreateRequire } from 'node:module';
// Wrap workerd's createRequire so .resolve() works via a VFS walk.
// plugin-react and other packages use \`require.resolve(pkg)\` to
// locate their optional deps on disk; workerd only implements the
// raw require() but not .resolve(). The wrapper walks the snapshot
// for /<...>/node_modules/<pkg>/package.json and returns its path.
globalThis.__cirrusNodeCreateRequire = function(parentUrl) {
  const inner = __cirrusCreateRequire(parentUrl);
  const wrapped = function(name) {
    // Try the builtin table first — same as __require shim.
    const bt = globalThis.__cirrusNodeBuiltinTable?.[name];
    if (bt) return bt;
    const uspace = globalThis.__cirrusRealUserspaceRequire?.(name);
    if (uspace) return uspace;
    return inner(name);
  };
  wrapped.resolve = function(name, _opts) {
    // VFS walk. name can be "pkg" or "pkg/subpath" or an absolute path.
    const fs = globalThis.__cirrusRealFs;
    if (fs && typeof name === 'string') {
      if (name.startsWith('/')) {
        // Absolute path request.
        if (fs.files.has(name)) return name;
      }
      // Package request.
      const parts = name.split('/');
      const pkgName = parts[0].startsWith('@') ? parts[0] + '/' + parts[1] : parts[0];
      const subpath = name.slice(pkgName.length + 1);
      // Walk all file paths looking for .../node_modules/<pkgName>/package.json
      const pkgSuffix = '/node_modules/' + pkgName + '/package.json';
      for (const p of fs.files.keys()) {
        if (p.endsWith(pkgSuffix)) {
          const dir = p.slice(0, -('package.json'.length));
          if (!subpath) return p;
          const sub = dir + subpath;
          if (fs.files.has(sub)) return sub;
          // Try with extension fallbacks.
          for (const ext of ['.js', '.mjs', '.cjs', '.json']) {
            if (fs.files.has(sub + ext)) return sub + ext;
          }
          if (fs.files.has(sub + '/index.js')) return sub + '/index.js';
          // Give up — but still return a plausible path; caller may
          // readFileSync on it and fail with our clearer error.
          return sub;
        }
      }
    }
    // Fallback: try workerds inner.resolve (likely throws).
    try { return inner.resolve ? inner.resolve(name) : name; }
    catch { return name; }
  };
  wrapped.cache = inner.cache || {};
  wrapped.extensions = inner.extensions || {};
  wrapped.main = inner.main || undefined;
  return wrapped;
};

globalThis.__cirrusRealFs = {
  files: new Map([
${body}
  ]),
  dirs: new Set([${dirEntries}]),
  existingPaths: new Set(${
    existingPaths && existingPaths.length > 0
      ? `[\n${existingPaths.map(p => `  ${JSON.stringify(p)}`).join(',\n')}\n]`
      : '[]'
  }),
};
globalThis.__cirrusRealFsStats = {
  fileCount: ${entries.length},
  dirCount: ${snapshotDirs.length},
  pathIndexCount: ${existingPaths ? existingPaths.length : 0},
};

${rollupWasmBase64 ? `
const __rollupWasmBase64 = ${JSON.stringify(rollupWasmBase64)};
let __rollupWasmBytes = null;
Object.defineProperty(globalThis.__cirrusRealFs, 'getWasmBytes', {
  value: () => {
    if (!__rollupWasmBytes) {
      const bin = atob(__rollupWasmBase64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      __rollupWasmBytes = u8;
    }
    return __rollupWasmBytes;
  },
});
` : ''}

${cjsPrebuiltBundles && Object.keys(cjsPrebuiltBundles).length > 0 ? `
// ── Pre-built CJS→ESM bundles ──────────────────────────────────
// workerd forbids runtime new Function/eval at request-handler
// time, so we cant transform CJS inside the facet. Instead we
// ship the common React-ecosystem CJS packages as pre-built ESM
// artifacts (src/cirrus-npm-cjs.generated.ts, bundled at
// facet-build time by scripts/bundle-npm-cjs.mjs). The
// vite:esbuild transform patch calls __cirrusNpmCjsMap(id) and,
// when a match is found, returns the pre-built ESM code instead
// of the CJS source in node_modules.
const __cirrusNpmCjsTable = new Map([
${Object.entries(cjsPrebuiltBundles).map(([pathPattern, code]) =>
  `  [${JSON.stringify(pathPattern)}, ${JSON.stringify(code)}]`,
).join(',\n')}
]);

/**
 * Match an fs path like /home/user/app/node_modules/react/index.js
 * against the pre-built bundle table. The keys in the table are
 * SUFFIXES — e.g. "/node_modules/react/index.js" — so a project
 * at any path resolves correctly.
 */
globalThis.__cirrusNpmCjsMap = function(id) {
  if (typeof id !== 'string') return null;
  // Strip query strings (Vite appends ?v=... for cache-busting).
  const cleanId = id.replace(/\\?.*$/, '');
  for (const [suffix, code] of __cirrusNpmCjsTable) {
    if (cleanId.endsWith(suffix)) return code;
  }
  return null;
};
` : ''}
`.trim();
}
