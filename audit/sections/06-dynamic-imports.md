# Section 06 — Dynamic Semantics in the User `node` Facet

> Probes captured 2026-04-29 against prod `https://nimbus.ashishkmr472.workers.dev`
> at HEAD `e93b18d`. **Probe artifacts:** [`audit/probes/dynamic/<name>.out.txt`](../probes/dynamic/).

## Probe-verified behaviour

| Feature | Status | Probe evidence | Citation |
|---|---|---|---|
| `__dirname` | ✅ string, set to script dir | `__dirname typeof: string "/tmp"` ([dirname-filename.out.txt](../probes/dynamic/dirname-filename.out.txt)) | `src/facet-manager.ts:176-182` (passed positionally to `new Function`) |
| `__filename` | ✅ string, set to script path | `__filename typeof: string "/tmp/dyn_mokemb72_dirname-filename.js"` ([dirname-filename.out.txt](../probes/dynamic/dirname-filename.out.txt)) | same |
| `import.meta.url` | ❌ SyntaxError | `[process killed: facet error: Cannot use 'import.meta' outside a module]` ([import-meta.out.txt](../probes/dynamic/import-meta.out.txt)) | User script wrapped in `new Function()` (`src/facet-manager.ts:176-182`); function bodies cannot use `import.meta` — module syntax only |
| `require(literal)` | ✅ | `literal require ok: function` ([dynamic-require-literal.out.txt](../probes/dynamic/dynamic-require-literal.out.txt)) | shim `__require` at `src/node-shims.ts:1047-1067` |
| `require(variable)` | ✅ | `variable require ok: function` ([dynamic-require-variable.out.txt](../probes/dynamic/dynamic-require-variable.out.txt)) | same |
| `require.resolve(spec)` | ❌ | `resolve fs fail: Cannot resolve 'fs'`, `resolve path fail: Cannot resolve 'path'`, `resolve relative fail: Cannot resolve './nope'` ([require-resolve.out.txt](../probes/dynamic/require-resolve.out.txt)) | shim's `require.resolve` doesn't consult builtins table; only walks `__resolveNodeModule` |
| `import('literal')` | ✅ | `dyn import literal ok: function` ([dynamic-import-literal.out.txt](../probes/dynamic/dynamic-import-literal.out.txt)) | facet runtime intercepts |
| `import(variable)` | ✅ | `dyn import var ok: function` ([dynamic-import-variable.out.txt](../probes/dynamic/dynamic-import-variable.out.txt)) | same |
| `eval()` (request-time) | ❌ | `eval fail: Code generation from strings disallowed for this context` ([eval-and-Function.out.txt](../probes/dynamic/eval-and-Function.out.txt)) | workerd `disallow_eval_during_request_handler` (default for compat date ≥ 2025-06-01) |
| `new Function()` (request-time) | ❌ | `new Function fail: Code generation from strings disallowed for this context` (same) | same |
| Top-level await | ❌ SyntaxError | `[process killed: facet error: await is only valid in async functions and the top level bodies of modules]` ([top-level-await.out.txt](../probes/dynamic/top-level-await.out.txt)) | `new Function()` wrapper isn't async; TLA needs ESM module |
| `process.cwd()` | ✅ | `cwd before: /home/user` ([process-cwd-chdir.out.txt](../probes/dynamic/process-cwd-chdir.out.txt)) | shim closure variable |
| `process.chdir()` | ✅ | `cwd after chdir: /tmp` (same) | same |
| `globalThis` | ✅ object | ([globals.out.txt](../probes/dynamic/globals.out.txt)) | workerd default |
| `Buffer` global | ✅ function | same | nodejs_compat |
| `process` global | ✅ object | same | shim + workerd |
| `queueMicrotask` | ✅ function | same | workerd |
| `AbortController` | ✅ function | same | workerd |
| `fetch` | ✅ function | same | workerd |
| `crypto` (WebCrypto global) | ✅ object | `crypto typeof: object` | workerd |
| `crypto.subtle` | ✅ object | `crypto.subtle typeof: object` | **the real WebCrypto IS available globally — even though `require('crypto').createHash()` is the FNV-1a fake** |
| `WebAssembly` | ✅ object | same | workerd |

## Headline findings

### F1 — `eval()` and `new Function()` are blocked at request time

> Probe: `Code generation from strings disallowed for this context`
> ([eval-and-Function.out.txt](../probes/dynamic/eval-and-Function.out.txt))

This is workerd's `disallow_eval_during_request_handler` flag, which is on
by default for compat date ≥ 2025-06-01. Nimbus's compat date is
`2026-04-01` (`wrangler.jsonc:5`).

**Practical consequences:**
- User code can't use `eval()` for runtime codegen
- Template engines like `pug`/`ejs` runtime compile fail
- Mock libraries that use `Function('return ' + str)()` fail
- Source-map-support's runtime patcher fails
- `vm.runInNewContext` (if vm shim were added) couldn't use real
  `Function` at request time — would need module-eval-time precompile

The Nimbus design copes by:
- Pre-compiling every `__vfsBundle` `.js` file at module-eval time (`src/facet-manager.ts:187-191`) into `__compiledModules` map
- User scripts run in `new Function(USER_CODE)` invoked from request handler — the `new Function()` itself is OK (it ran at module-eval time), but anything the user code generates at request time can't be evaled

### F2 — `import.meta` is a SyntaxError

> `Cannot use 'import.meta' outside a module`

User scripts run inside `new Function(...)` which is **not** an ES module
context. Any package that ships `import.meta.url` to detect its own path
(Node 20+ ESM idiom) fails before its first line.

### F3 — Top-level await is a SyntaxError

> `await is only valid in async functions and the top level bodies of modules`

Same root cause as F2. User scripts must wrap awaits in
`(async () => { ... })()`.

### F4 — `__dirname` and `__filename` work as expected

The facet wrapper passes these positionally — verified probe shows
`__filename = "/tmp/dyn_mokemb72_dirname-filename.js"` and `__dirname =
"/tmp"`. CJS packages that use `__dirname` for asset paths work.

### F5 — Dynamic require AND dynamic import both work

Both literal-string and variable-spec forms work. This is **better** than
the stricter ESM model — Nimbus's facet is CJS-flavored.

### F6 — `require.resolve` is broken for builtins AND relatives

> `Cannot resolve 'fs'`, `Cannot resolve 'path'`, `Cannot resolve './nope'`

`require.resolve` should return the absolute path of a builtin (e.g.
`'node:fs'` for builtins, or the resolved file path for relatives — even
for non-existent ones it should throw `MODULE_NOT_FOUND` not the Nimbus-
specific "Cannot resolve" message).

The shim's `require.resolve` (search `node-shims.ts` for `resolve` near
the require functions) doesn't look up builtins or extension-probe
relatives. Worth a small W2 fix.

### F7 — WebCrypto `crypto.subtle` IS reachable globally

Verified probe: `crypto.subtle typeof: object`.

This is the workerd-native global Web Crypto. **It's the right escape
hatch** — user code that does `await crypto.subtle.digest('SHA-256',
buf)` gets real cryptographic output, even though
`require('crypto').createHash('sha256').digest('hex')` returns the
FNV-1a fake (Section 01 F1).

This means a W2 fix for `node:crypto` shadowing could simply route the
shim's `createHash` through `crypto.subtle.digest` (already async-safe)
or expose a sync wrapper that uses workerd's actual `node:crypto` via
static `import`. The platform supports it; only the shim is broken.

## Three execution contexts side-by-side

| Feature | Supervisor (`NimbusSession` DO) | Facet (user `node`) | Browser (`/preview/@modules/`) |
|---|---|---|---|
| `__dirname` | undefined (ESM) | ✅ string | undefined (would need esbuild `define`) |
| `import.meta.url` | ✅ workerd-provided | ❌ SyntaxError | ✅ esbuild-emitted |
| `require()` | ✅ workerd's `node:module.createRequire` | ✅ shim `__require` | esbuild post-rewrite (`__require()` polyfill) |
| `eval()` request-time | ❌ blocked | ❌ blocked | ❌ blocked (browser CSP often blocks too) |
| Top-level await | ✅ ESM module | ❌ SyntaxError | ✅ `target:'esnext'` |

## Citations

- Probe driver: [audit/probes/_driver.mjs](../probes/_driver.mjs)
- Per-probe artifacts: [audit/probes/dynamic/](../probes/dynamic/)
- workerd `disallow_eval_during_request_handler`: https://developers.cloudflare.com/workers/configuration/compatibility-flags/#disallow-eval-during-request-handler
- `allow_eval_during_startup`: default for compat date ≥ 2025-06-01 (https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
- Facet user code wrapper: `src/facet-manager.ts:176-191`
- Shim `__require`: `src/node-shims.ts:1047-1067`
