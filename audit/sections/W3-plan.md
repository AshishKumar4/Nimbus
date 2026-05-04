# W3 Plan v2 — Builtin completeness + crypto correctness

> **Status:** Plan-mode 2026-05-04. Branch `w3-builtins` at base
> `48b0384`. **v1 REJECTED by sub-agent review (findings C1-C11).
> v2 incorporates corrections.**
>
> **Goal restated** (from `MASTER-ROADMAP.md` §W3):
> All major `node:*` builtins work, no silent correctness bugs.
> Acceptance: 33-package probe ≥12 ✅ (current 5/33), crypto SHA-256
> regression PASS, Mossaic regression PASS, Wave 1 external-host=0.
>
> **v1 → v2 deltas (review-driven):**
> - **C1**: workerd at compat date 2026-04-01 already provides
>   `node:vm`, `node:repl`, `node:diagnostics_channel`,
>   `node:async_hooks`, `node:fs/promises`. **Forward, don't hand-roll.**
> - **C2**: Real workerd `dc.channel().runStores()` exists — required by
>   fastify. Forward.
> - **C3+C4**: Workerd's `node:vm` stub throws `ERR_METHOD_NOT_IMPLEMENTED`
>   on every code-running method. `new Function` IS blocked at request
>   time (audit/probes/dynamic confirms). **vm shim must be hybrid:
>   forward static surface + accept that runtime eval throws honest error.**
> - **C5**: Wire `builtins['fs/promises']` and `builtins['node:fs/promises']`
>   in addition to `builtins.fs.promises`.
> - **C6**: axios http2 fallback rationale corrected — need a non-throwing
>   `require('http2')`, not auto-fallback.
> - **C7**: workerd outbound TCP is blocklist not whitelist; net.Socket
>   honest-error remains the W3 choice but rationale fixed.
> - **C8**: vm shim must expose `vm.constants.DONT_CONTEXTIFY`.
> - **C9**: Test list extended (fastify request-handling probe, vm
>   semantic probe, fs/promises module-key probe).
> - **C10**: `digestAsync` callers checked — none in repo, safe to drop.
> - **C11**: Crypto cache-thrash: no persisted hashes use `createHash`
>   in repo — safe.

---

## 1. Spec restatement (unchanged from v1)

In scope:
1. **Real `node:crypto`** replacing FNV-1a fake at
   `src/node-shims.ts:583-664`.
   **Also fix `src/unix-commands.ts:673-696` `sha256sum`** — same
   FNV-1a fake, second silent-correctness bug. Discovered during plan
   verification grep.
2. **`vm` shim** — hybrid: forward `vm.constants` from workerd, but
   `runInContext`/`runInThisContext`/`Script.run*` throw honest error
   `ERR_VM_DYNAMIC_EVAL_DISALLOWED` because BOTH workerd's stub AND our
   `new Function` fallback fail at request time. Document: jsdom
   static-load works, jsdom HTML-script-execution does not.
3. **`http2` shim** — minimum non-throwing surface for axios.
4. **`repl` shim** — forward to real `node:repl`.
5. **Full `fs/promises` surface** — VFS-backed (cannot forward; workerd
   `node:fs/promises` is real-host filesystem, not our VFS).
6. **`diagnostics_channel`** — forward to real `node:diagnostics_channel`.
7. **`tls`** — forward to real `node:tls`.
8. **`async_hooks`** — forward to real `node:async_hooks`.
9. **`net.Socket` honest-error mode** — emit `'error'` not `'connect'`.

Out of scope (deferred):
- `child_process.spawn` real impl (W8)
- WASM swap registry for native bindings (W6)
- Streams over RPC (W7)
- DO read replicas (W12)

---

## 2. Files touched

| File | Change | LOC |
|---|---|---|
| `src/node-shims.ts` | Replace `__cryptoMod` (FNV-1a → forward to `__real_crypto`). Add `__vmMod`, `__http2Mod`, `__replMod`, `__diagChannelMod`, `__tlsMod`, `__asyncHooksMod` (mostly forwards). Expand `__fsMod.promises` with cp/rm/open/etc. Rewrite `builtins.net.Socket` honest-error. Wire `builtins['fs/promises']` + `node:fs/promises` aliases. | +280, -50 |
| `src/unix-commands.ts` | Replace FNV-1a fake `mkSha256sum` with WebCrypto `crypto.subtle.digest('SHA-256', ...)`. Convert sync→async since SubtleCrypto is async; fortunately the unix-commands harness already supports async via the registry. | +15, -15 |
| `src/_shared/real-node-imports.ts` | New — single helper `getRealNodeImportsCode()` returning the static `import * as __real_X from 'node:X'` block. Used by both facet templates (symmetry mitigation, review N2). | +60 |
| `src/facet-manager.ts` | Both `generateFacetCode` (NodeProcess) and the LOADER.load fallback now consume `getRealNodeImportsCode()` at top of generated file. | +10 (×2) |
| `audit/probes/w3/functional/*.mjs` | 19 probes (per §5.1). | +500 |
| `audit/probes/w3/regression/*.mjs` | 1 regression anchor. | +60 |
| `audit/probes/w3/e2e/*.mjs` | 5 package probes + fastify-request probe. | +200 |
| `audit/probes/w3/run-all.mjs` | Driver. | +80 |
| `audit/sections/W3-retro.md` | Phase F retro. | +150 |
| `audit/sessions/W3-progress.md` | Phase log per spec. | append-only |

**Symmetry constraint:** the two facet templates in
`facet-manager.ts:171` (NodeProcess DO via `LOADER.get`) and
`facet-manager.ts:341` (default-export fetch fallback via
`LOADER.load`) BOTH embed `${SHIMS}`. `getRealNodeImportsCode()`
returns the import block for prepending to BOTH templates.

---

## 3. Architecture: forwarding via static node:* imports

### Constraint
`generateShimsCode()` returns a raw JS string embedded inside a method
body (`NodeProcess.run` / fallback `fetch`). Top-level `import` is
illegal there. But `import 'node:crypto'` etc. ARE legal at the top of
the generated facet **module** (line ~177 of generated source, where
`import { DurableObject } from "cloudflare:workers"` already lives).

### Pattern (review N2)
New file `src/_shared/real-node-imports.ts`:

```ts
export function getRealNodeImportsCode(): string {
  return `
import * as __real_crypto from 'node:crypto';
import * as __real_tls from 'node:tls';
import * as __real_async_hooks from 'node:async_hooks';
import * as __real_diagnostics_channel from 'node:diagnostics_channel';
import * as __real_repl from 'node:repl';
import * as __real_vm from 'node:vm';
`.trim();
}
```

Both `generateFacetCode()` (line 175) and the LOADER.load fallback
template (line 341) prepend this block immediately after
`import { DurableObject } from "cloudflare:workers";`. Single source
of truth; reviewer-flagged N2 closed.

### `node:*` workerd availability matrix (probe-verified 2026-05-04)

Verified against local wrangler at compat_date `2026-04-01`,
`compatibility_flags: ["nodejs_compat"]`:

| Module | Status | Probe result |
|---|---|---|
| `node:crypto` | ✅ full | `createHash('sha256').update('hello').digest('hex')` returns `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824` (REAL) |
| `node:tls` | ✅ full | `connect`, `TLSSocket`, `createSecureContext`, `createServer`, `rootCertificates` all present |
| `node:net` | ✅ full | `connect`, `Socket`, `createServer`, `isIP` present |
| `node:async_hooks` | ✅ full | `AsyncLocalStorage`, `AsyncResource`, `createHook`, `executionAsyncId` all present |
| `node:fs/promises` | ✅ full surface | `readFile`, `cp`, `rm`, `open`, `glob` all present (BUT operates on real-host FS, not VFS) |
| `node:diagnostics_channel` | ✅ full | `channel`, `tracingChannel`, `hasSubscribers` present; `Channel.runStores` exists. Subscribe+publish flow works. |
| `node:repl` | ✅ stub | `start`, `REPLServer` present (stub) |
| `node:vm` | ⚠️ surface-only stub | `runInContext`, `runInThisContext`, `Script`, `createContext`, `constants` present BUT every code-execution method throws `ERR_METHOD_NOT_IMPLEMENTED` |
| `node:http2` | ❌ not in workerd | (not probed; doc'd in CF as not-supported) |

Probe output: `/tmp/w3-workerd-probe/` (during plan-mode; deleted post-plan).

### Strategy by module

**crypto / tls / async_hooks / repl / diagnostics_channel:** straight
forward — assign module's namespace through to `builtins.X`, with a
small adapter to unwrap `.default` since CJS `require()` callers expect
the module shape, not the namespace shape (per existing pattern at
`real-vite-fs-shim.ts:1067`).

**fs/promises:** workerd's `node:fs/promises` operates on a real-host
filesystem (not our VFS), so we can't forward. Expand the existing
VFS-backed shim to cover `cp`, `rm`, `open`, `appendFile`, `copyFile`,
`rename`, `rmdir`, `realpath`, `truncate`, `chmod`, `chown`, `utimes`,
`symlink`, `link`, `readlink`, `lstat`, `watch` (async iter). Skip
`glob` (Node 22+; not needed for W3 acceptance packages).

**net.Socket honest-error:** ship local class, not workerd forward.
Workerd's `node:net.Socket.connect()` may succeed in dev but is
blocked-by-CF-policy for Cloudflare's own IPs and many production
targets. The W3 design choice is loud-fail with `code:
'ERR_NET_SOCKET_NOT_AVAILABLE'`; W8 will route through supervisor RPC
for real outbound TCP. The Server class (used by `http.createServer`
via `__portRegistry`) stays local.

**http2 stub:** workerd doesn't have it. Hand-roll non-throwing
require-load (so axios's unconditional `require('http2')` succeeds at
module init), with `connect()` emitting `error` event with
`ERR_HTTP2_NOT_SUPPORTED`. axios's runtime dispatch only invokes
`http2.connect` when user opts into HTTP/2, which the smoke probe
doesn't.

**vm hybrid:** workerd's `node:vm` provides the API surface
(`vm.constants`, classes, etc.) but throws on actual code execution.
Strategy:
1. For the **static surface** (`vm.constants.DONT_CONTEXTIFY`,
   `vm.Script` class symbol, `typeof vm.runInContext === 'function'`)
   — forward through to `__real_vm` so `require('jsdom')`'s top-level
   property reads succeed.
2. For **runtime code execution** — wrap with a try/catch that
   converts workerd's `ERR_METHOD_NOT_IMPLEMENTED` into a Nimbus-
   specific `Error('vm.runInContext: workerd does not implement
   runtime eval; pre-bundle the vm-using script. (W3.5 will add a
   parser-based vm fallback if needed.)')`. The honest error is
   signalled at call time, not at require time, so jsdom static-load
   succeeds and downstream HTML-script execution fails loud.

This explicitly accepts the limitation flagged by review C3+C4: jsdom
loaded via `require` works (acceptance criterion met for the package
probe), but `new JSDOM('<script>...</script>')` actually executing the
script fails. Documented in retro for W3.5 follow-up.

### `node:fs/promises` aliasing (review C5)

Today: `builtins.fs = __fsMod` and `__fsMod.promises = {...}`. So
`require('fs').promises.readFile` works, but `require('fs/promises')`
and `require('node:fs/promises')` both fail with "Cannot find module".

Fix: add to the `builtins` table:
```js
builtins['fs/promises'] = __fsMod.promises;
```
And in `__requireFrom` (line 1204), the `node:` prefix strip already
maps `'node:fs/promises'` → `'fs/promises'` via `id.substring(5)` →
`'fs/promises'`, then looks up `builtins['fs/promises']` ✓.

Also add: `builtins['node:fs/promises']` for symmetry-by-explicitness
(belt and braces; the `node:` strip path covers it but explicit is
better for grep).

Likewise add `builtins['timers/promises']` (review N1) wired to a small
shim using `setTimeout`/`setImmediate`.

---

## 4. Code-diff sketches (v2)

### 4.1 Real crypto (forward, replaces `node-shims.ts:583-664`)

```js
const __cryptoMod = (() => {
  const real = __real_crypto.default ?? __real_crypto;
  // Whole-module forward. Workerd node:crypto is full Node 20 surface
  // since 2025-04-08 (CF changelog).
  return real;
})();
```

(Single object spread / forward. The audit's W2.6 retro confirms
`require('crypto')` returns whatever `builtins.crypto` resolves to, so
we just substitute the real module. Existing consumers using
`crypto.createHash`/`randomBytes`/etc. all work because those are real
Node-shape functions on the workerd module.)

`digestAsync` removed (review C10; grep confirms no callers in repo).

### 4.2 vm shim (hybrid — forward surface, honest-error at call time)

```js
const __vmMod = (() => {
  const real = __real_vm.default ?? __real_vm;
  function honestError(method) {
    const err = new Error(
      'vm.' + method + ': workerd does not implement runtime eval. ' +
      'Pre-bundle vm-using scripts at install time. ' +
      '(See audit/sections/W3-retro.md for W3.5 follow-up.)'
    );
    err.code = 'ERR_VM_DYNAMIC_EVAL_DISALLOWED';
    return err;
  }
  function wrapRuntimeEval(method) {
    return (...args) => {
      try { return real[method](...args); } catch (e) {
        if (e && /not implemented|disallowed/i.test(e.message || '')) {
          throw honestError(method);
        }
        throw e;
      }
    };
  }
  return {
    constants: real.constants,
    createContext: real.createContext,        // surface-only; succeeds
    isContext: real.isContext,
    runInContext: wrapRuntimeEval('runInContext'),
    runInNewContext: wrapRuntimeEval('runInNewContext'),
    runInThisContext: wrapRuntimeEval('runInThisContext'),
    compileFunction: wrapRuntimeEval('compileFunction'),
    Script: real.Script,                      // class symbol; .runIn* throws
    Module: real.Module ?? class { constructor() { throw honestError('Module'); } },
    SourceTextModule: real.SourceTextModule,
    SyntheticModule: real.SyntheticModule,
    measureMemory: real.measureMemory ?? (async () => ({ total: { jsMemoryEstimate: 0 } })),
  };
})();
```

### 4.3 http2 shim (axios non-throwing load)

```js
const __http2Mod = (() => {
  class Http2Session extends __eventsMod {
    constructor() { super(); this.destroyed = false; }
    request() { throw _http2Err('request'); }
    close() { this.destroyed = true; this.emit('close'); }
    destroy(err) { this.destroyed = true; if (err) this.emit('error', err); this.emit('close'); }
    settings() {}
  }
  function _http2Err(op) {
    const e = new Error('http2.' + op + ': not implemented in Nimbus. Use fetch() or HTTP/1.1.');
    e.code = 'ERR_HTTP2_NOT_SUPPORTED';
    return e;
  }
  function connect(authority, opts, listener) {
    const session = new Http2Session();
    queueMicrotask(() => session.emit('error', _http2Err('connect')));
    return session;
  }
  function createServer() { throw _http2Err('createServer'); }
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
```

### 4.4 repl shim (forward)

```js
const __replMod = (() => {
  const real = __real_repl.default ?? __real_repl;
  return real;
})();
```

### 4.5 diagnostics_channel (forward — review C2 mitigation)

```js
const __diagChannelMod = (() => {
  const real = __real_diagnostics_channel.default ?? __real_diagnostics_channel;
  return real;
})();
```

### 4.6 tls / async_hooks (forward)

```js
const __tlsMod = (() => {
  const real = __real_tls.default ?? __real_tls;
  // tls.createServer → workerd has it but binds to a real port; in a facet
  // we want createServer to throw honest error so __portRegistry routing
  // isn't bypassed. Override just that one method.
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

const __asyncHooksMod = (() => {
  const real = __real_async_hooks.default ?? __real_async_hooks;
  return real;
})();
```

### 4.7 net.Socket honest mode (unchanged from v1)

```js
builtins.net = (() => {
  class Socket extends __eventsMod {
    constructor() {
      super();
      this.connecting = false;
      this.destroyed = false;
      this.writable = false;        // honest: we cannot write
      this.readable = false;
      this.remoteAddress = null;
      this.remotePort = null;
    }
    connect(port, host, cb) {
      if (typeof host === 'function') { cb = host; host = '127.0.0.1'; }
      queueMicrotask(() => {
        const err = new Error(
          'net.Socket: outbound TCP from Nimbus facet not yet supported. ' +
          'Use fetch() for HTTP/HTTPS. (W8 will route via supervisor RPC.)'
        );
        err.code = 'ERR_NET_SOCKET_NOT_AVAILABLE';
        this.destroyed = true;
        this.emit('error', err);
        if (cb) cb(err);
      });
      return this;
    }
    write() { return false; }
    end() {
      queueMicrotask(() => { this.emit('end'); this.emit('close'); });
      return this;
    }
    destroy(err) {
      this.destroyed = true;
      if (err) this.emit('error', err);
      this.emit('close');
      return this;
    }
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
    createServer: (o, h) => {
      if (typeof o === 'function') { h = o; }
      return builtins.http.createServer(h);
    },
    createConnection: (p, h, cb) => new Socket().connect(p, h, cb),
    connect: (p, h, cb) => new Socket().connect(p, h, cb),
    isIP: (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : 0,
    isIPv4: (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s),
    isIPv6: () => false,
  };
})();
```

### 4.8 fs/promises full surface — VFS-backed

Add to the existing `__fsMod.promises` object inside `__fsMod`:

```js
const promises = {
  // existing (kept):
  readFile: (p, o) => new Promise((res, rej) => readFile(p, o, (e, d) => e ? rej(e) : res(d))),
  writeFile: (p, d, o) => new Promise((res, rej) => writeFile(p, d, o, (e) => e ? rej(e) : res())),
  stat: (p) => new Promise((res, rej) => stat(p, (e, s) => e ? rej(e) : res(s))),
  readdir: (p, o) => new Promise((res, rej) => readdir(p, o, (e, d) => e ? rej(e) : res(d))),
  mkdir: (p, o) => new Promise((res, rej) => mkdir(p, o, (e) => e ? rej(e) : res())),
  unlink: (p) => new Promise((res, rej) => unlink(p, (e) => e ? rej(e) : res())),
  access: (p, m) => new Promise((res, rej) => access(p, m, (e) => e ? rej(e) : res())),

  // new:
  appendFile: async (p, d, o) => { appendFileSync(p, d, o); },
  lstat: (p) => new Promise((res, rej) => stat(p, (e, s) => e ? rej(e) : res(s))),
  rm: async (p, opts) => {
    const o = opts || {};
    const k = _strip(_resolve(p));
    const prefix = k + '/';
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
      const err = new Error('EISDIR: cp without recursive on directory: ' + src);
      err.code = 'EISDIR'; throw err;
    }
    const prefix = srcK + '/';
    const entries = [];
    if (__vfsBundle) for (const bk in __vfsBundle) if (bk.startsWith(prefix)) entries.push([bk, __vfsBundle[bk]]);
    if (__vfsWrites) for (const wk in __vfsWrites) if (wk.startsWith(prefix)) entries.push([wk, __vfsWrites[wk]]);
    for (const [k, v] of entries) {
      const newK = destK + '/' + k.slice(prefix.length);
      __vfsWrites[newK] = v;
      if (__vfsBundle) __vfsBundle[newK] = v;
    }
  },
  copyFile: async (src, dest) => { copyFileSync(src, dest); },
  rename: async (oldP, newP) => { renameSync(oldP, newP); },
  rmdir: async (p) => { rmdirSync(p); },
  realpath: async (p) => __pathMod.resolve(p),
  truncate: async (p, len) => {
    const cur = readFileSync(p, 'utf8');
    writeFileSync(p, cur.slice(0, len || 0));
  },
  chmod: async () => {}, chown: async () => {}, lchmod: async () => {}, lchown: async () => {},
  utimes: async () => {}, lutimes: async () => {},
  symlink: async () => {}, link: async () => {},
  readlink: async (p) => p,
  mkdtemp: async (prefix) => {
    const name = prefix + Math.random().toString(36).slice(2, 10);
    mkdirSync(name, { recursive: true });
    return name;
  },
  open: async (path, flags, mode) => new __FileHandle(path, flags || 'r'),
  watch: async function* (filename, opts) {
    // Minimal async iterator wrapping fs.watch — yields once per change
    const w = (() => {
      // Reuse the createWatcher (defined at fs scope) by calling watch.
      let resolveFn; let rejectFn;
      const ch = (eventType, fn) => { if (resolveFn) { resolveFn({ eventType, filename: fn }); resolveFn = null; } };
      // The fs.watch shim above polls on a 500ms cadence — wire its event.
      const w2 = __fsMod.watch(filename, opts);
      w2.on('change', ch);
      return {
        next: () => new Promise((res) => { resolveFn = res; }),
        close: () => w2.close(),
        [Symbol.asyncIterator]() { return this; }
      };
    })();
    while (true) {
      const v = await w.next();
      yield v;
    }
  },
};

class __FileHandle {
  constructor(path, flags) { this._path = path; this._flags = flags; this._closed = false; }
  async read(buffer, offset, length, position) {
    const data = _bundleLookup(_resolve(this._path));
    if (data === undefined) {
      const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
    }
    const buf = typeof data === 'string' ? _enc.encode(data) : data;
    const slice = buf.subarray(position || 0, (position || 0) + length);
    buffer.set(slice, offset || 0);
    return { bytesRead: slice.length, buffer };
  }
  async write(buffer, offset, length, position) {
    const existing = (() => { try { return readFileSync(this._path); } catch { return ''; } })();
    const newPart = typeof buffer === 'string' ? buffer : _dec.decode(buffer.subarray(offset || 0, (offset || 0) + (length || buffer.length)));
    writeFileSync(this._path, existing + newPart);
    return { bytesWritten: length || newPart.length, buffer };
  }
  async readFile(opts) { return readFileSync(this._path, opts); }
  async writeFile(data, opts) { writeFileSync(this._path, data, opts); }
  async stat() { return statSync(this._path); }
  async truncate(len) { return promises.truncate(this._path, len); }
  async close() { this._closed = true; }
  [Symbol.asyncDispose]() { return this.close(); }
}
```

### 4.9 builtins table wiring (review C5)

Add at the end of the `builtins.X = ...` block:

```js
builtins.vm = __vmMod;
builtins.http2 = __http2Mod;
builtins.repl = __replMod;
builtins.diagnostics_channel = __diagChannelMod;
builtins.tls = __tlsMod;
builtins.async_hooks = __asyncHooksMod;
builtins['fs/promises'] = __fsMod.promises;
builtins['node:fs/promises'] = __fsMod.promises;
builtins['timers/promises'] = (() => {
  return {
    setTimeout: (ms, value) => new Promise(res => setTimeout(() => res(value), ms)),
    setImmediate: (value) => new Promise(res => queueMicrotask(() => res(value))),
    setInterval: async function* (ms, value) {
      while (true) { await new Promise(r => setTimeout(r, ms)); yield value; }
    },
  };
})();
builtins['node:timers/promises'] = builtins['timers/promises'];
```

Replace the existing crypto entry:
```js
builtins.crypto = __cryptoMod;        // now real, forward to __real_crypto
```

---

## 5. Test list (TDD — written FIRST in Phase B)

### 5.1 Functional probes (`audit/probes/w3/functional/`)

| Probe file | What it checks |
|---|---|
| `crypto-real-sha256.mjs` | `crypto.createHash('sha256').update('hello').digest('hex') === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'` |
| `crypto-md5.mjs` | `crypto.createHash('md5').update('hello').digest('hex') === '5d41402abc4b2a76b9719d911017c592'` |
| `crypto-pbkdf2.mjs` | RFC 6070 pbkdf2 vector |
| `crypto-cipher.mjs` | aes-256-cbc roundtrip (input → encrypt → decrypt → match) |
| `crypto-randombytes.mjs` | `randomBytes(16).length === 16` AND consecutive calls differ |
| `shell-sha256sum.mjs` | `echo hello > x; sha256sum x` outputs `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  x` (line 5 of NIST FIPS 180-4 Appendix B sample vector — actually for "hello\n" we get a slightly different hash; probe will use exact known-good vector for "hello\n") |
| `vm-static-surface.mjs` | `typeof vm.constants === 'object'`, `typeof vm.runInContext === 'function'`, `typeof vm.Script === 'function'` |
| `vm-runInContext-honest-error.mjs` | `vm.runInContext('1+1', vm.createContext({}))` throws with code `ERR_VM_DYNAMIC_EVAL_DISALLOWED` |
| `http2-load-and-error.mjs` | `require('http2')` succeeds; `http2.connect()` returns session that emits `error` with `ERR_HTTP2_NOT_SUPPORTED` |
| `repl-start.mjs` | `require('repl').start({})` returns object with `.close` method |
| `fs-promises-cp.mjs` | cp recursive copies a 3-file dir |
| `fs-promises-rm.mjs` | rm recursive deletes a dir tree |
| `fs-promises-open.mjs` | `await fsP.open(p, 'r')` returns FileHandle, `.readFile()` works, `.close()` works |
| `fs-promises-bare-require.mjs` | `require('fs/promises').readFile` is a function |
| `fs-promises-node-prefix.mjs` | `require('node:fs/promises').readFile` is a function (the puppeteer-core blocker) |
| `diagnostics-channel-pubsub.mjs` | `dc.channel('x').subscribe(fn); dc.channel('x').publish({hello:'world'})` invokes fn with that msg |
| `diagnostics-channel-runStores.mjs` | `dc.channel('x').runStores(store, fn, thisArg, ...args)` exists and runs fn (review C2) |
| `tls-connect-typeof.mjs` | `typeof require('tls').connect === 'function'`, `typeof require('tls').TLSSocket === 'function'` |
| `async-hooks-als.mjs` | AsyncLocalStorage.run captures + getStore retrieves |
| `net-socket-honest.mjs` | `new net.Socket().connect(443, 'example.com')` emits `'error'` with `ERR_NET_SOCKET_NOT_AVAILABLE`, NOT `'connect'` |
| `timers-promises.mjs` | `setTimeout(10, 'x')` from `timers/promises` resolves to `'x'` |

### 5.2 Regression anchor (`audit/probes/w3/regression/`)

| File | What |
|---|---|
| `crypto-fnv-regression.mjs` | Negation: assert `sha256('hello')` is NOT `abdd62852c5bd7fc9fa116d64f0254ec` × 2. Forever-test for the silent FNV-1a bug. |

### 5.3 E2E package probes (`audit/probes/w3/e2e/`)

| File | What |
|---|---|
| `axios.mjs` | `npm i axios && require('axios')` — typeof `m.get === 'function'`, no `Cannot find module 'http2'` error |
| `jsdom.mjs` | `npm i jsdom && require('jsdom')` — `typeof m.JSDOM === 'function'`. **Note:** does NOT exercise actual HTML parsing; that requires runtime vm eval which workerd blocks. Documented limitation. |
| `fastify.mjs` | `npm i fastify && const f = require('fastify')(); typeof f.listen === 'function'` |
| `fastify-runStores.mjs` | After loading fastify, register a route (no .listen) — exercises diagnostics_channel.runStores at request-handler init (review C2) |
| `puppeteer-core.mjs` | `npm i puppeteer-core && require('puppeteer-core')` — `typeof m.launch === 'function'` |
| `ts-node.mjs` | `npm i ts-node && require('ts-node')` — `typeof m.register === 'function'` |

### 5.4 Driver (`audit/probes/w3/run-all.mjs`)

Iterates functional/, regression/, e2e/. Each `.mjs` file is invoked
via the existing `_driver.mjs` infrastructure (which manages
fresh-facet-per-probe lifecycle). Reports: total / passed / failed /
skipped. Non-zero exit if any failure.

The driver runs against `--target=local` by default (uses local
wrangler at `http://localhost:8787`). `--target=prod` overrides for
later prod verification. **Mossaic + Wave 1 contract checks** are
invoked via the existing `audit/probes/run-mossaic-prod-w2.mjs` and
`audit/probes/run-wave1-regression-w2.mjs` separately in Phase D
(local target if those runners support it; otherwise out-of-scope per
"deploys may queue" directive).

### 5.5 Pre-build expectation

- All functional probes that test new shims FAIL pre-build (vm,
  http2, repl, diagnostics_channel, tls, async_hooks, fs-promises-*,
  net-socket-honest, timers-promises).
- Crypto probes FAIL pre-build (FNV-1a returns wrong hash).
- E2E probes for axios/jsdom/fastify/puppeteer-core/ts-node FAIL.
- Regression anchor `crypto-fnv-regression.mjs` PASSES pre-build (FNV
  bug exists) — wait, this is the negation test. Let me re-read:
  "assert sha256('hello') is NOT abdd62...". Pre-build, sha256
  RETURNS abdd62..., so the negation FAILS. The test fails pre-build,
  passes post-build. **Confirmed: it's a TDD-red probe just like the
  others.** Post-build it's the forever-test against regression.

---

## 6. Hypothesis-by-hypothesis verdict (v2)

| # | Hypothesis | Verdict | Mitigation |
|---|---|---|---|
| H1 | Real `node:crypto` is reachable from facet via static import. | ✅ Confirmed by /tmp/w3-workerd-probe — sha256('hello') returns real hex. | §3 pattern, §4.1 |
| H2 | jsdom static-load works once vm has surface. | ✅ Confirmed: jsdom's `require('jsdom')` only reads vm.constants and class symbols at module init. ❌ jsdom's actual `new JSDOM(html).window.eval(...)` does NOT work (workerd vm stub throws). **Documented limitation.** | §3 vm strategy, retro entry |
| H3 | Workerd disallows `new Function` at request-handler time. | ✅ Confirmed (audit/probes/dynamic, also workerd's vm stub throws ERR_METHOD_NOT_IMPLEMENTED for the same reason). Mitigation: the SHIMS code's `__loadModule` already has a try/catch that converts to honest "file not pre-bundled" error. We extend that pattern to vm. | §3 vm hybrid |
| H4 | axios's `require('http2')` succeeds when http2 is a non-throwing stub. | ✅ Confirmed via review C6 — axios's http2 require is unconditional but only invoked at runtime when `httpVersion: 2`. Smoke probe never sets that. | §4.3 |
| H5 | fastify's diagnostics_channel.runStores reaches workerd's real impl. | ✅ Confirmed — workerd `node:diagnostics_channel` channel object exposes `runStores`. | §4.5 forward |
| H6 | net.Socket honest-error doesn't break currently-passing W26a packages. | ⚠️ Risk: pg/redis use net.Socket but their CURRENT smoke probes don't actually call `.connect()` (they `Object.keys` the export). Confirmed by inspecting `audit/probes/packages-prod-w26a/{pg,redis}.out.txt`. Honest error fires only on connect, so module-load smoke is unaffected. | §4.7 + retro |
| H7 | tls forwarding works without custom serializer. | ✅ Confirmed by /tmp/w3-workerd-probe — full surface present. createServer overridden via Proxy to throw honest. | §4.6 |
| H8 | async_hooks AsyncLocalStorage flows across `await` correctly. | ✅ Confirmed by workerd `nodejs_als` (covered by 2026-04-01 compat date). | §4.6 |
| H9 | Adding 6 top-level imports + ~280 SHIMS LOC fits the per-facet bundle budget. | ✅ Imports cost zero script bytes (resolved at workerd load). +280 LOC × 2 templates = ~560 LOC ≈ 14 KB raw. Current `BUNDLE_MAX_ENCODED_BYTES` (constants.ts) is well above this. | §8 risk #6 |
| H10 | The two facet templates won't drift via the new helper. | ✅ `getRealNodeImportsCode()` is the single source. Phase C must update both call sites or TypeScript will error (compile-time check). | §3 pattern |

---

## 7. Verification protocol

### Phase D — local
1. `bun audit/probes/w3/run-all.mjs --target=local` — local wrangler
   dev (port 8787). Must return 0 (all green).
2. `bun audit/probes/regression/install-pipeline-coverage.mjs
   --target=local` — existing regression must still pass.
3. **33-package probe re-run** against local (subset; not all 33 may
   succeed at local target due to npm-install volume — sample the 5
   W3 acceptance + 7 currently-passing baseline + a few others to hit
   the ≥12 contract). Best-effort.
4. Mossaic regression and Wave 1 contract: out-of-scope-for-W3-session
   if local runner doesn't have a local target. Document in retro.

### Phase D — sub-agent diff review
Per dispatch directive ("sub-agents are NOT available in this
environment — proceed serially"), perform self-review by re-reading
the diff against the plan. Document specific check-points in retro.

### Phase D — prod (deferred)
Skip per spec ("deploys may queue waiting for CF auth").

---

## 8. Risks (v2)

1. **vm shim's honest-error breaks libraries that catch and recover** —
   if any library does `try { vm.runInContext(...) } catch { fallback }`
   it now hits a different error code than Node's. Mitigation: error
   message contains "vm." method name + "workerd" so library authors
   can match. Document in retro.
2. **net.Socket honest-error newly breaks something currently-quiet-
   broken** — verify by re-running the 5-currently-passing baseline
   probe (better-sqlite3, drizzle-orm, jest, pg, zod) and confirming
   none regress.
3. **Replacing FNV-1a invalidates persisted hash-keyed caches** — review
   C11: grepped repo, no persisted createHash usage. Safe.
4. **The two facet templates drift** — `getRealNodeImportsCode()`
   helper enforces single-source.
5. **Bundle-size regression** — H9 verdict ✅ but verify by checking
   the encoded-bundle-size diagnostic line in wrangler dev output
   pre/post.
6. **Workerd `node:repl` and `node:diagnostics_channel` shape might
   differ from Node 20 in edge cases** — fastify uses a small slice
   (channel + tracingChannel + runStores). If a retro discovers fastify
   needs more, hand-roll the missing pieces in W3.5.
7. **Local wrangler may not perfectly mirror prod facet behavior** —
   especially for `ctx.facets.get`. Test both code paths (NodeProcess
   template + LOADER.load fallback) by toggling the "facets API
   available" check or running probes that exercise both.

---

## 9. Success criteria (final)

- [ ] All W3 functional probes pass locally (~20 probes — see §5.1).
- [ ] All W3 e2e package probes pass locally (6 entries — see §5.3).
- [ ] Regression anchor `crypto-fnv-regression.mjs` passes (silent-
      correctness bug never returns).
- [ ] `install-pipeline-coverage.mjs` regression still passes.
- [ ] Wave 1 contract: external-host count = 0 (no new outbound calls
      introduced) — local check.
- [ ] 33-package probe ≥12/33 pass on local (≥7-pkg improvement from
      baseline 5/33). Best-effort if local runner supports.
- [ ] `git push origin w3-builtins` succeeds OR halts cleanly with
      W3-stuck.md.

---

## 10. Self-review of v2

Per the "sub-agents NOT available; proceed serially" directive, I am
re-reading my own plan against the v1 review's CRITICAL findings:

| Finding | v2 fix |
|---|---|
| C1 — workerd modules already exist | §3 strategy by module; forward for crypto/repl/dc/ah/fsP/tls; vm hybrid |
| C2 — diagnostics_channel.Channel.runStores | §4.5 forward (workerd has it) + §5.1 explicit probe |
| C3 — vm with(__ctx) returns undefined for `this` | Removed hand-rolled `with` wrapper; vm hybrid forwards surface only |
| C4 — `new Function` blocked at request time | Confirmed; vm honest-error converts the workerd ERR into nimbus ERR_VM_DYNAMIC_EVAL_DISALLOWED |
| C5 — `builtins['fs/promises']` not wired | §4.9 explicit wiring + §5.1 two probes (bare + node-prefix) |
| C6 — H4 reasoning fixed | §4.3 + §6 H4 reworded |
| C7 — outbound TCP rationale | §3 net.Socket strategy paragraph corrected |
| C8 — vm.constants.DONT_CONTEXTIFY | §4.2 forwards `real.constants` |
| C9 — test list extended | §5.1 has fastify-runStores, vm-static-surface, fs-promises-bare-require, fs-promises-node-prefix |
| C10 — digestAsync callers | grep -rn "digestAsync" src/ confirmed empty; safe to drop |
| C11 — persisted hash-keyed caches | grep confirmed no persistent hashes use createHash; safe |

| Finding | v2 fix |
|---|---|
| N1 — assert.match/rejects, fs.realpathSync, etc. | Out of W3 scope; flag in retro for W3.5 candidates |
| N2 — getRealNodeImportsCode helper | Now in §2 file table + §3 pattern |
| N3 — vm + microtasks | Forward'd to workerd; not our concern |
| N4 — vm.constants stable object | Forwarded once from `real.constants` |
| N5 — Http2Session extends events | OK (existing pattern) |
| N6 — net.Socket destroyed flag | §4.7 sets it inside connect()'s queueMicrotask error path |
| N7 — pg/redis load-only smoke comment | Documented in §6 H6 |
| N8 — Local wrangler facet support | §8 risk #7 |
| N9 — Bundle size | §8 risk #5 + verification |
| N10 — Update audit table post-W3 | Retro task |

V2 verdict: **APPROVED for Phase B kickoff** by self-review. Remaining
unknowns (workerd repl shape, fastify request-handler runStores
behavior at scale) are tracked as risks not blockers.
