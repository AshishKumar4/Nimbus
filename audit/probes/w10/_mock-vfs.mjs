// W10 mock SqliteVFS — in-memory file blobs with the same surface that
// nimbus-wrangler / binding-{kv,d1,r2} consume:
//
//   exists, readFile, readFileBytes, readFileString, writeFile,
//   readdir, stat, unlink, mkdir, isDirectory, events
//
// Plus a tiny VfsEventEmitter clone that fires async-batched events on
// writeFile/unlink. Used for hot-reload regression tests.

class MockVfsEventEmitter {
  constructor() {
    this._globalListeners = [];
    this._pending = [];
    this._flushScheduled = false;
  }
  on(listener) {
    this._globalListeners.push(listener);
    return () => {
      const idx = this._globalListeners.indexOf(listener);
      if (idx >= 0) this._globalListeners.splice(idx, 1);
    };
  }
  emit(type, path, oldPath) {
    this._pending.push({ type, path, timestamp: Date.now(), oldPath });
    if (!this._flushScheduled) {
      this._flushScheduled = true;
      queueMicrotask(() => this._flush());
    }
  }
  _flush() {
    this._flushScheduled = false;
    const batch = this._pending;
    this._pending = [];
    if (batch.length === 0) return;
    for (const l of this._globalListeners) {
      try { l(batch); } catch (e) { console.error('mock vfs listener error', e); }
    }
  }
}

function te(s) { return new TextEncoder().encode(s); }
function td(u) { return new TextDecoder('utf-8').decode(u); }

export class MockVfs {
  constructor() {
    this.files = new Map();   // path → Uint8Array
    this.dirs = new Set(['']);
    this.events = new MockVfsEventEmitter();
    this._writeCount = 0;
  }

  _norm(p) { return String(p).replace(/^\/+/, '').replace(/\/+$/, ''); }

  exists(p) {
    const n = this._norm(p);
    if (n === '' || this.dirs.has(n)) return true;
    return this.files.has(n);
  }

  isDirectory(p) {
    const n = this._norm(p);
    return n === '' || this.dirs.has(n);
  }

  readFile(p) {
    const n = this._norm(p);
    const v = this.files.get(n);
    if (!v) throw new Error('ENOENT: ' + n);
    return v;
  }

  readFileBytes(p) { return this.readFile(p); }

  readFileString(p) {
    return td(this.readFile(p));
  }

  writeFile(p, content) {
    const n = this._norm(p);
    const isAdd = !this.files.has(n);
    const buf = typeof content === 'string' ? te(content) : new Uint8Array(content);
    this.files.set(n, buf);
    // Make parent dirs
    let parent = n;
    while (parent.includes('/')) {
      parent = parent.substring(0, parent.lastIndexOf('/'));
      this.dirs.add(parent);
    }
    this._writeCount++;
    this.events.emit(isAdd ? 'add' : 'change', n);
  }

  unlink(p) {
    const n = this._norm(p);
    const had = this.files.delete(n);
    if (had) this.events.emit('unlink', n);
  }

  mkdir(p, opts) {
    const n = this._norm(p);
    if (opts?.recursive) {
      const parts = n.split('/').filter(Boolean);
      let cur = '';
      for (const seg of parts) {
        cur = cur ? cur + '/' + seg : seg;
        this.dirs.add(cur);
      }
    } else {
      this.dirs.add(n);
    }
  }

  readdir(p) {
    const n = this._norm(p);
    if (n !== '' && !this.dirs.has(n) && !this.files.has(n)) {
      throw new Error('ENOENT: ' + n);
    }
    const out = [];
    const seenDirs = new Set();
    const prefix = n === '' ? '' : n + '/';

    for (const fp of this.files.keys()) {
      if (n !== '' && !fp.startsWith(prefix)) continue;
      const rest = n === '' ? fp : fp.substring(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        out.push({ name: rest, type: 'file' });
      } else {
        const dirName = rest.substring(0, slash);
        if (!seenDirs.has(dirName)) { seenDirs.add(dirName); out.push({ name: dirName, type: 'directory' }); }
      }
    }
    for (const d of this.dirs) {
      if (!d) continue;
      if (n === '') {
        if (!d.includes('/')) {
          if (!seenDirs.has(d)) { seenDirs.add(d); out.push({ name: d, type: 'directory' }); }
        }
      } else if (d.startsWith(prefix)) {
        const rest = d.substring(prefix.length);
        if (rest && !rest.includes('/')) {
          if (!seenDirs.has(rest)) { seenDirs.add(rest); out.push({ name: rest, type: 'directory' }); }
        }
      }
    }
    return out;
  }

  stat(p) {
    const n = this._norm(p);
    if (this.files.has(n)) return { isFile: true, isDirectory: false, size: this.files.get(n).length, mtime: Date.now() };
    if (n === '' || this.dirs.has(n)) return { isFile: false, isDirectory: true, size: 0, mtime: Date.now() };
    throw new Error('ENOENT: ' + n);
  }
}

export function makeMockVfs() {
  return new MockVfs();
}

// ── Mock RpcTarget so binding emulators can `extend RpcTarget` ──────────
//
// In a real workerd inner Worker, RpcTarget is imported from
// 'cloudflare:workers'. In Bun unit tests we provide a no-op base class.
// Emulators that do `class X extends RpcTarget {}` get a plain JS object;
// that's enough for unit-level testing of method correctness. The actual
// workerd RPC marshaling is untested at unit level (only e2e with deployed
// LOADER.load can exercise that).

export class MockRpcTarget {}

// ── Sub-VFS provider, mirroring SqliteVFSProvider in src/sqlite-vfs.ts ──

export class MockVfsProvider {
  constructor(vfs, prefix) {
    this.vfs = vfs;
    this.prefix = String(prefix).replace(/^\/+/, '').replace(/\/+$/, '');
  }
  _r(sub) {
    const c = String(sub).replace(/^\/+/, '').replace(/\/+$/, '');
    return c ? this.prefix + '/' + c : this.prefix;
  }
  readFile(s) { return this.vfs.readFile(this._r(s)); }
  readFileString(s) { return this.vfs.readFileString(this._r(s)); }
  writeFile(s, c) {
    const fp = this._r(s);
    const pp = fp.includes('/') ? fp.substring(0, fp.lastIndexOf('/')) : '';
    if (pp && !this.vfs.exists(pp)) this.vfs.mkdir(pp, { recursive: true });
    this.vfs.writeFile(fp, c);
  }
  exists(s) { return this.vfs.exists(this._r(s)); }
  stat(s) { return this.vfs.stat(this._r(s)); }
  readdir(s) { return this.vfs.readdir(this._r(s)); }
  unlink(s) { this.vfs.unlink(this._r(s)); }
  mkdir(s, opts) { this.vfs.mkdir(this._r(s), opts); }
}
