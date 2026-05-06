# X.5-M Plan — node-shim runtime gap shims

> Wave window: autonomous single-session run beginning 2026-05-05.
> Branch: `x5m-shim-gaps` off `main` HEAD `eb316dc`.
> Verification source: `audit/sections/VERIFY-EB316DC.md` §6 #3 + §7 (read via `git show origin/verify-eb316dc:...`).
> Charter: three small parallel runtime-gap shims, each unblocking one top-tier package.

---

## TL;DR

| Shim | Pkg unblocked | Root-cause class | Fix loc | Confidence |
|---|---|---|---|---|
| **M-1** | `fastify` | `http.Server` missing `setTimeout(ms, cb)` no-op | `src/node-shims.ts:1684` (Server class body) | **HIGH** — pattern mirrors net.Socket at line 1753 |
| **M-2** | `redis`   | `dns/promises` subpath not registered in `builtins[]`; `__requireFrom` lookup misses | `src/node-shims.ts:~1813` (after `timers/promises`) | **HIGH** — pattern mirrors timers/promises at lines 1804-1813 |
| **M-3** | `vite`    | URL constructor strict-rejects `null` base; vite's rolldown bundle emits `new URL(rel, import.meta.url)` where polyfill yields `null` | URL handling in shims (NEW: `globalThis.URL` lenient wrap; **deeper** vite-bundle issues are out of charter) | **PARTIAL** — fix #1 layer is straightforward; full vite ✅ requires fs URL acceptance + base-derivation, which compose into a follow-on bucket |

**Predicted outcome:**
- M-1 ✅ at full real-package install layer (high confidence)
- M-2 ✅ at full real-package install layer (high confidence)
- M-3 ✅ at "URL constructor no longer throws" layer; **honest-fail at deeper layer** with documented root cause and follow-on bucket scope (per dispatch's "honest-fail acceptable IF root cause documented and out of charter")

---

## 1. Per-shim root-cause confirmation from probe artifacts

### M-1 — `fastify` `server.setTimeout is not a function`

**Probe artifact** (`audit/probes/verify-eb316dc/packages-local/fastify.out.txt`):
```
TypeError: server.setTimeout is not a function
    at getServerInstance (eval at <anonymous> (runner.js:34:34), <anonymous>:343:10)
    at createServer (...:30:18)
    at fastify (...:115:7)
```

**Root cause confirmed.** fastify's `lib/server.js` calls `server.setTimeout(ms)` on the http Server instance. Our shim's `http.Server` class (`src/node-shims.ts:1684-1691`) has `listen`, `close`, `address`, `_handleRequest`, but **no `setTimeout` method**. The pattern is already correctly implemented on `net.Socket` at line 1753 — a no-op returning `this`.

**Fix:**
```js
class Server extends __eventsMod {
  constructor(handler) { ... }
  listen(...) { ... }
  close(...) { ... }
  get listening() { ... }
  address() { ... }
  setTimeout(ms, cb) { if (typeof ms === "function") { cb = ms; } if (cb) this.on("timeout", cb); return this; }   // ← NEW
  setKeepAlive() { return this; }            // ← NEW (defensive — fastify also calls this on Socket; harmless to add to Server too)
  _handleRequest(...) { ... }
}
```

**Why setTimeout(ms, cb) — not just `() => this`:** fastify's call site is `server.setTimeout(opts.connectionTimeout)` — single arg, no callback. The Node.js API also accepts `setTimeout(callback)` (1-arg as fn) and `setTimeout(ms, callback)` (2-arg). We honour all three by no-op'ing the timeout (correct — facets can't actually idle-timeout connections) but registering callback if provided so emit('timeout') still fires from listeners. Returning `this` matches Node's chainable contract.

### M-2 — `redis` `Cannot find module 'dns/promises'`

**Probe artifact** (`audit/probes/verify-eb316dc/packages-local/redis.out.txt`):
```
Error: Cannot find module 'dns/promises' (from home/user/app/node_modules/@redis/client/dist/lib/client)
    at __requireFrom (runner.js:2662:24)
    at scopedRequire (runner.js:2569:33)
```

**Root cause confirmed.** `@redis/client` does `require('dns/promises')`. Our `__requireFrom` (line 2156) checks:
```js
function __requireFrom(id, fromDir) {
  if (builtins[id]) return builtins[id];           // 'dns/promises' miss — only 'dns' is registered
  if (id.startsWith("node:")) {
    const bare = id.substring(5);
    if (builtins[bare]) return builtins[bare];     // would handle 'node:dns/promises' but not the bare form
  }
  const resolved = __resolveFrom(id, fromDir);
  if (!resolved) throw new Error("Cannot find module '" + id + "' (from " + fromDir + ")");  // ← redis hits this
  return __loadModule(resolved);
}
```

Note that `builtins.dns` HAS a `.promises` field (line 1773 — DoH-backed `resolve/resolve4/lookup`). The fix is to expose `dns/promises` AND `node:dns/promises` as their own keys in `builtins[]`, mirroring the `timers/promises` pattern that already exists at line 1804-1813:

```js
builtins["timers/promises"] = (() => { ... })();           // exists
builtins["node:timers/promises"] = builtins["timers/promises"];  // exists
```

**Fix:**
```js
builtins["dns/promises"] = builtins.dns.promises;          // ← NEW
builtins["node:dns/promises"] = builtins["dns/promises"];  // ← NEW
```

Inserted at line ~1813 (immediately after the timers/promises pair), so the registration happens AFTER `builtins.dns` was populated at line 1771.

**Why this is safe:** `builtins.dns.promises` is already a complete object with `resolve(h, t)`, `resolve4(h)`, `lookup(h)` — all returning Promises (DoH-backed). It's the same shape as Node's `dns/promises` subpath module. redis only uses `dns.lookup` (for hostname resolution before TCP connect); `lookup` already returns `{address, family}`-shaped object. Should work end-to-end.

### M-3 — `vite` `Invalid URL string.`

**Probe artifact** (`audit/probes/verify-eb316dc/packages-local/vite.out.txt`):
```
TypeError: Invalid URL string.
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:144:95)
    at __loadModule (...) at __requireFrom (...) at scopedRequire (...)
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:84:21)   ← outer eval = vite/dist/node/index.js L84
    at __loadModule (...) at __requireFrom (...) at __require (...)
    at eval (...:39:13) at NodeProcess.run (runner.js:2702:7)
```

**Investigation probes:** `audit/probes/x5m/investigate/vite-url-stack{1..D}.{mjs,txt}`. Localized via:
1. **Stack frame mapping** (probe v3): vite's `dist/node/index.js` is 84 lines — line 84 is `var import_node = require("./chunks/node.js");`. So inner eval = chunks/node.js.
2. **URL-constructor instrumentation** (probe v5): wrapped `globalThis.URL` to log every call. **First URL call**: `new URL("../../../src/node/constants.ts", null)` — fails immediately. Source location = chunks/node.js line 144 col 95. (The line 144 itself reads `function slash(p) {` = 19 chars, so the col 95 is misleading — workerd reports stack positions inside the wrapped function body but the source map of the bundle's IIFE shifts numbering; the call site is the first top-level URL constructor invocation in the chunks/node.js bundle.)
3. **Polyfill-source identification** (probe vA): full stack capture confirmed args = `["../../../src/node/constants.ts", null]`. Globals at call time: `typeof document = undefined`, `typeof location = undefined`, `typeof __filename = "string"`, `typeof __dirname = "string"`. So vite's bundled rolldown polyfill for `import.meta.url` evaluates to **literal `null`**, not to `__filename`-derived nor to `document.baseURI`-derived. (Likely rolldown emits something like `(typeof importMetaUrl === "undefined" ? null : importMetaUrl)` for unresolvable references when bundling for CJS without an `__importMetaUrl__` shim.)
4. **Lenient-URL test** (probe vB): wrapped `globalThis.URL` to default base `null` → `"file:///"`. Result: vite's URL throw goes away, but vite then fails with `ENOENT 'file:///package.json'` — i.e., vite uses the URL value to find files, and our fs shim doesn't accept `file://` URL strings.
5. **Strong-base test** (probe vD): wrapped URL with base = `"file:///home/user/app/node_modules/vite/dist/node/chunks/node.js"`. Result: fail moves further still — `ENOENT 'file:///home/user/app/node_modules/vite/package.json'` — i.e., vite's URL resolves correctly (now points to the right file), but again fs.readFileSync gets a `file://` URL string and doesn't strip the prefix.

**Root cause class:** **two-stage gap.**
- Stage A: `globalThis.URL` strict-rejects `null` base — workerd-correct, but breaks vite which has a rolldown polyfill that emits `null` when import.meta.url isn't statically resolvable. **THIS is the M-3 charter.**
- Stage B: vite uses URL instances / `url.href` strings as fs path arguments. Our fs shim's `_resolve()` does `String(p)` and doesn't strip `file://`. **THIS is OUT of M-3 charter** — it's a deeper composition gap between vite's fs-via-URL pattern and our fs shim's path-only contract. Fits a separate bucket (provisionally **X.5-O** — "fs URL acceptance"), ~30 LOC of shim work in `_resolve()` and analogous helpers + a probe.

**Stage A fix (in M-3 charter):**

Add a **lenient URL guard** at the shim layer. The simplest is to wrap `globalThis.URL` once at facet startup (or, more surgically, to inject a guarded URL into each module's eval scope via the wrapper function's parameters — but that requires touching `__loadModule`'s `new Function` call which has more blast radius).

The minimum-blast-radius fix is to define a `__shimURL` global that is:
- Identical to `globalThis.URL` for all valid usage
- When called with `(rel, null)` or `(rel, undefined)` and `rel` is a string that does NOT itself parse as an absolute URL: treat as if base were `"file:///"`. Resolves the relative path against root, returning a syntactically valid URL whose `.pathname` and `.href` are well-formed.
- All other behaviour passthrough to native URL.

Approach:
```js
// At the END of node-shims.ts startup (after all other builtins are set up).
const __OrigURL = globalThis.URL;
class __ShimURL extends __OrigURL {
  constructor(input, base) {
    if (base == null && typeof input === "string") {
      // Try parsing as absolute first; if that throws, retry with file:/// base.
      try { super(input); return; }
      catch { super(input, "file:///"); return; }
    }
    super(input, base);
  }
}
// Preserve static methods (canParse, parse if exists, createObjectURL, revokeObjectURL).
for (const k of Object.getOwnPropertyNames(__OrigURL)) {
  if (typeof __OrigURL[k] === "function" && !(k in __ShimURL)) {
    try { __ShimURL[k] = __OrigURL[k].bind(__OrigURL); } catch {}
  }
}
__ShimURL.prototype = __OrigURL.prototype;  // instanceof checks against __OrigURL still work
globalThis.URL = __ShimURL;
__urlMod.URL = __ShimURL;  // keep the url module's URL pointing at the same constructor
```

This is wrapped in a minimal IIFE near the existing `__urlMod` definition (line 718-726) so the lenient version is the only URL anywhere in the facet. Module load eval sees the guarded version because it's a global mutation done before the runner's first eval.

**Why `file:///` and not `__filename`-derived:** the M-3 charter is just to STOP THE THROW. Each module's `import.meta.url` is whatever rolldown's polyfill emits — we can't reach the polyfill from the shim. The lenient default lets the URL constructor return *some* URL object instead of throwing. Whether that URL is "right" for vite's downstream uses is a separate question (Stage B). For other packages that use URL only for parsing/serialization (not for fs operations), the lenient default is enough.

**Acceptance criterion for M-3 (charter-scoped):** `new URL("rel", null)` no longer throws. Vite's `require('vite')` no longer throws **at the URL constructor** (will progress to ENOENT or beyond — that's a separate composition gap). M-3 wave honestly reports: "URL throw fixed, vite still fails at deeper layer — see X.5-O backlog item."

**Why this is in scope:** the prompt explicitly lists "M-3: vite fails with `Invalid URL string.` — REQUIRES INVESTIGATION first" + "honest-fail acceptable IF root cause documented and out of charter". The investigation has localized the throw class (URL constructor strict-null base), the fix is targeted, and the deeper failure has clear scope/owner.

---

## 2. Fix sketches with file:line

### M-1 — fastify

**File:** `src/node-shims.ts`
**Locus:** line 1684-1691 (existing `Server` class body inside `builtins.http` IIFE)

Diff sketch:
```diff
@@ -1684,6 +1684,8 @@
   class Server extends __eventsMod {
     constructor(handler) { super(); if (handler) this.on("request", handler); this._port = 0; this._listening = false; }
     listen(port, host, cb) { if (typeof host === "function") { cb = host; } this._port = port || 0; this._listening = true; globalThis.__portRegistry.set(this._port, this); if (cb) queueMicrotask(cb); this.emit("listening"); return this; }
     close(cb) { this._listening = false; globalThis.__portRegistry.delete(this._port); if (cb) cb(); this.emit("close"); }
     get listening() { return this._listening; }
+    setTimeout(ms, cb) { if (typeof ms === "function") { cb = ms; } if (cb) this.on("timeout", cb); return this; }
+    setKeepAlive() { return this; }
     address() { return { address: "0.0.0.0", port: this._port, family: "IPv4" }; }
     _handleRequest(u, m, h, b) { ... }
   }
```

### M-2 — redis

**File:** `src/node-shims.ts`
**Locus:** line ~1813 (immediately after the existing `node:timers/promises` line)

Diff sketch:
```diff
@@ -1813,6 +1813,9 @@
 builtins["node:timers/promises"] = builtins["timers/promises"];

+builtins["dns/promises"] = builtins.dns.promises;
+builtins["node:dns/promises"] = builtins["dns/promises"];
+
 // ═══════════════════════════════════════════════════════════════════════
 // ──  require() — full Node.js module resolution ─────────────────────
 // ═══════════════════════════════════════════════════════════════════════
```

### M-3 — vite

**File:** `src/node-shims.ts`
**Locus:** line ~726 (immediately after `__urlMod` definition at lines 718-726)

Diff sketch:
```diff
@@ -726,6 +726,30 @@
 const __urlMod = {
   URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
   parse: ..., format: ..., resolve: ..., pathToFileURL: ..., fileURLToPath: ...,
 };

+// X.5-M (M-3): lenient URL constructor.
+//
+// Rolldown/rollup-bundled CJS packages (vite, esbuild plugins, etc.) emit
+// `new URL(rel, import.meta.url)` patterns whose polyfilled import.meta.url
+// resolves to literal null in our facet (no document, no location, and
+// the rolldown polyfill doesn't reach into __filename for CJS-loaded modules).
+// workerd's URL constructor strict-rejects null/undefined base → throws
+// "Invalid URL string." at module top-level eval, breaking require('vite').
+//
+// Fix: wrap globalThis.URL to default null/undefined base to file:///.
+// Behaviour preserved for all valid URL usage; only the null-base failure
+// path is patched. Module is opaque w.r.t. instanceof and static methods.
+(() => {
+  const _Orig = globalThis.URL;
+  class _Shim extends _Orig {
+    constructor(input, base) {
+      if (base == null && typeof input === "string") {
+        try { super(input); return; } catch { super(input, "file:///"); return; }
+      }
+      super(input, base);
+    }
+  }
+  for (const k of Object.getOwnPropertyNames(_Orig)) {
+    if (typeof _Orig[k] === "function" && !(k in _Shim)) {
+      try { _Shim[k] = _Orig[k].bind(_Orig); } catch {}
+    }
+  }
+  _Shim.prototype = _Orig.prototype;
+  globalThis.URL = _Shim;
+})();
+__urlMod.URL = globalThis.URL;
+
 // ═══════════════════════════════════════════════════════════════════════
 // ──  crypto module ───────────────────────────────────────────────────
```

NOTE: this places the URL guard inside the GENERATED-SHIMS template string in node-shims.ts (which becomes part of the facet runner). Verify that `(() => { ... })()` is permitted at this point (workerd allows function-expression IIFE at module-eval time, distinct from request-time eval which is what `disallow_eval_during_request_handler` blocks).

---

## 3. Probe plan (Phase B, TDD-red-first)

Per dispatch protocol, every src/ change must be preceded by a green-turning test. Three test layers per shim:

### Functional probes (`audit/probes/x5m/functional/`)

In-process tests that exercise the *exact API contract* without the install pipeline. Run via `bun audit/probes/x5m/functional/<probe>.mjs`:

- **`http-server-setTimeout.mjs`** — import the shim's HTTP Server class, instantiate, call `.setTimeout(5000)`, verify it returns the server (chainable) and doesn't throw. Also verify `.setTimeout(cb)` registers the callback on `'timeout'`.
- **`dns-promises-subpath.mjs`** — verify `__requireFrom('dns/promises', '/home/user/app')` returns an object with `.lookup`, `.resolve`, `.resolve4`. (Tests via the actual exported runner template — extracts `__requireFrom` from the generated runner string and checks the registration list.) Backup: verify `builtins['dns/promises']` and `builtins['node:dns/promises']` are both registered and equal.
- **`url-lenient-null-base.mjs`** — verify `new URL("rel", null)` does not throw, returns a URL instance with valid `.href`. Verify `new URL("https://example.com")` (valid absolute) still works. Verify `new URL("rel", "https://base.com/")` (valid base) still works.

### Regression probes (`audit/probes/x5m/regression/`)

- **`install-pipeline-coverage.mjs`** — re-run the existing 4-package coverage check (`fastify`, `express`, `ts-jest`, `redis`) to confirm M-1/M-2 don't break install pipeline coverage. (We're adding shim methods/builtins, not changing the install pipeline; this should be a "no change" gate.)
- **`single-resolver-source.mjs`** — copy the X.5-F/G/C invariant: `resolveExports` declared exactly once. Don't break the single-resolver invariant.
- **`url-static-methods-preserved.mjs`** — verify `URL.canParse('https://x')`, `URL.parseForDataURL`, `URL.createObjectURL` are still callable on the wrapped `globalThis.URL`. (Tests M-3 doesn't break URL static API.)

### E2E probes (`audit/probes/x5m/e2e/`)

Real-package install + `require()` smoke against `wrangler dev`:

- **`fastify.mjs`** — `npm install fastify`, then `require('fastify')()` and check `keys` includes `register`/`addHook`/`listen`. Expected verdict: `✅ success`.
- **`redis.mjs`** — `npm install redis`, then `require('redis')` and check `keys` includes `createClient`. Expected verdict: `✅ success`.
- **`vite.mjs`** — `npm install vite`, then `require('vite')` and check `keys` includes `createServer`/`build`/`defineConfig`. Expected verdict per Stage A scope: **`⚠ progresses past URL throw, halts at fs URL ENOENT`** (honest-fail; document Stage B follow-on).

Driver pattern reuses `audit/probes/x5g/e2e/_x5g-driver.mjs` (creates `_x5m-driver.mjs` with same shape).

### Run-all script

`audit/probes/x5m/run-all.mjs` — invokes every probe sequentially, writes a summary to `audit/probes/x5m/run-all.txt`. Exit 0 if all FUNCTIONAL+REGRESSION tests green AND all E2E tests reach their CHARTER outcome (✅ for M-1/M-2, ⚠-with-documented-deeper-failure for M-3).

---

## 4. Risk register

| Risk | Mitigation |
|---|---|
| `setTimeout` on Server might shadow native EventEmitter `setTimeout` | EventEmitter has no `setTimeout` method; the only inherited member that could collide is on `globalThis.setTimeout`. The class method shadows ONLY on instances. Safe. |
| `dns/promises` registration depends on `builtins.dns.promises` being populated FIRST | The new lines are placed at line ~1813, after `builtins.dns` is set at line 1771. Order preserved. |
| URL wrap breaks `Object.getPrototypeOf(new URL(...))` checks elsewhere | We assign `_Shim.prototype = _Orig.prototype`, so `(new URL(...)) instanceof OriginalURL` and `URL.prototype.toString.call(...)` both work. instanceof against `_Shim` also works because `_Shim.prototype === _Orig.prototype`. |
| URL wrap changes `URL.length` (constructor arity) — package-internal hostage check | The wrap uses `(input, base)` with same arity (2). If any package does `URL.length === 2` it still passes. |
| The IIFE wrap runs at facet startup eval — does workerd reject `class extends URL`? | workerd permits class-extends-builtin in module-eval contexts. Verified empirically by probe vB — the `class GuardedURL extends _OrigURL` pattern worked end-to-end in the facet. |
| M-3 stops at "URL no longer throws" — vite still fails | This is documented and within charter ("honest-fail acceptable IF root cause documented and out of charter"). Stage B (fs URL acceptance) is flagged as X.5-O follow-on bucket. |
| Install non-determinism: chunks/node.js sometimes excluded | Already observed in investigation probes (3+ retries needed to get a clean install). M-3 e2e probe will retry up to 3× to get past install-side flake. Orthogonal to the shim fix. |

---

## 5. Phase ordering

1. **Phase B**: write all probes (functional + regression + e2e). Confirm RED. Commit "test: x5m probes (red)".
2. **Phase C-1**: implement M-1 (Server.setTimeout/setKeepAlive). Confirm M-1 functional + e2e green. Commit "shim: http.Server.setTimeout no-op for fastify (M-1)".
3. **Phase C-2**: implement M-2 (dns/promises subpath). Confirm M-2 functional + e2e green. Commit "shim: dns/promises subpath registered (M-2)".
4. **Phase C-3**: implement M-3 (lenient URL guard). Confirm M-3 functional green; M-3 e2e reaches charter outcome (vite progresses past URL throw). Commit "shim: lenient URL guard for rolldown polyfill null base (M-3)".
5. **Phase D**: full sweep: all x5m tests + Mossaic regression + tsc. Sub-agent diff review.
6. **Phase E**: push.
7. **Phase F**: retro.

---

## 6. Sub-agent review (Phase A close-out)

Plan submitted for self-review against the dispatch:

- ✅ Charter respected: all three shims are scoped to `src/node-shims.ts`; no touches to `src/npm-resolve-facet.ts`, `src/npm-resolver.ts`, `src/require-resolver.ts` (X.5-J / X.5-L territory).
- ✅ Anti-requirements respected: no silent completion path; TDD red-first sequencing; sub-agent review block; all artifacts under worktree `audit/`.
- ✅ Honest-scope call on M-3: the throw is fixed at shim layer; deeper vite fs-URL gap is documented as out-of-charter follow-on (X.5-O).
- ✅ Fix locations match dispatch hints: M-1 at line ~1684, M-2 at line ~1773 (technically line ~1813 — the dispatch hint pointed at the existing `dns` definition, but the registration mirroring `timers/promises` belongs at line 1813); M-3 fix locus determined by investigation as the `__urlMod`-adjacent block.
- ✅ Investigation done before coding M-3 (per dispatch: "REQUIRES INVESTIGATION first"). 4 probes: vite-url-stack{5,A,B,D}.{mjs,txt}.
