# X.5-S investigation — `__dirname` re-declaration in pre-compile CJS

> Per VERIFY-23417C5.md §4 #1 / X5M3-retro §"Next bucket".
> Worktree: `x5s-dirname` from `origin/main` HEAD `23417c5`.

## TL;DR

vite's `chunks/node.js` (transitive bundle of `open@10.2.0`) ships
ESM source containing:

```js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

Our facet pre-compile pipeline runs that source through esbuild's
ESM→CJS transform (W3.5 Fix B), which preserves the `const __dirname = …`
line (substituting `import.meta` with `const import_meta = {}`), then
wraps the result in:

```js
new Function("exports","require","module","__filename","__dirname", code)
```

JavaScript: parameter `__dirname` and body `const __dirname` collide →
SyntaxError "Identifier '__dirname' has already been declared" → caught
by the pre-compile loop's try/catch and recorded into
`__compileFailures`, surfaced at `__loadModule` request time as
"pre-compile failed at facet startup: …".

## Reproduction (standalone, no wrangler)

`audit/probes/x5s/investigation/repro.mjs` reproduces the parse error
against an esbuild-shaped synthetic body, then validates the fix shape
(drop `__dirname` from the parameter list when the body declares it):

```
$ node audit/probes/x5s/investigation/repro.mjs
{
  "repro":         { "ok": false, "msg": "Identifier '__dirname' has already been declared" },
  "fix_drop_param":{ "ok": true, "body_declares_dirname": true,
                     "body_declares_filename": false,
                     "final_params": ["exports","require","module","__filename"] }
}
```

## Reproduction (real, via local wrangler dev)

Captured against the worktree's own `bun run dev` on `127.0.0.1:8787`,
running the X.5-M3 e2e (`e1-vite-loads.mjs`):

```
VITE-FAIL: Cannot load module 'home/user/app/node_modules/vite/dist/node/chunks/node.js':
  pre-compile failed at facet startup:
  Identifier '__dirname' has already been declared
```

Saved transcript: `audit/probes/x5s/investigation/e2e-RED-baseline.out.txt`
(129 lines, full WS session including npm install vite + smoke node script).

## Localization — first-declarer

esbuild output for the trivial test ESM file:

```
const path = require("path");
const __dirname = import_path.dirname((0, import_url.fileURLToPath)(import_meta.url));
```

(verified via `./node_modules/.bin/esbuild --format=cjs --target=esnext`
on the in-tree esbuild@0.27.3.) The `const __dirname = …` line is
emitted **before** any `__dirname` reference because esbuild does not
know it conflicts with the wrapper's parameter — it treats the source's
top-level `const __dirname` as ordinary user code.

So the **first declarer at parse time is the `new Function` parameter
list**, which JavaScript hoists into the function's lexical scope; the
body's `const __dirname` is the second declarer and triggers the
collision.

## PREFERRED vs FALLBACK

Three options were enumerated in X5M3-retro §"Next bucket":

| Opt | Description | Tradeoff |
|----|-------------|----------|
| (a) | Post-process esbuild output to elide conflicting `const __dirname` | Complex; must not break readers of `__dirname` later in the file |
| (b) | Wrap module body in IIFE before passing to `new Function` | Simple but adds a stack frame to every module |
| (c) | Detect the pattern + elide it specifically | Brittle to esbuild output drift |

**The dispatch's PREFERRED** is structurally simpler than any of (a)/(b)/(c):
**conditionally drop the `__dirname` parameter from `new Function` when
the body already declares it.** This is purely additive at the wrap
site — no body rewriting, no IIFE wrap, no pattern matching beyond a
simple regex on the body string. The body's own `const __dirname = …`
becomes the single declarer; callers still pass 5 positional arguments
because JS silently ignores extras.

The FALLBACK (per dispatch) — strip `const __dirname` from the
pre-compile output via a banner — is the X.5-Z3 territory the dispatch
explicitly opens for use if PREFERRED proves insufficient.

## Choice

**Going with PREFERRED.** Rationale:

1. The `repro.mjs` validation already demonstrates the conditional-drop
   behaves correctly: when the body declares `__dirname`, dropping the
   parameter lets the body's binding take effect; when it does not, the
   parameter is preserved and the existing call shape is unchanged.
2. The fix is mechanical and localized to two pre-compile sites in
   `src/facet-manager.ts` (lines 215, 400) plus the runtime fallback in
   `src/node-shims.ts` (line 2312) — all three share the same
   `new Function("exports","require","module","__filename","__dirname", code)`
   signature; the same regex sniff covers them.
3. No risk of bundling-time output drift (FALLBACK / option-c risk):
   we react to whatever esbuild emits rather than predicting it.
4. Symmetric for `__filename` — esbuild also sometimes emits
   `const __filename = fileURLToPath(import.meta.url)` (vite's open@10
   pattern is the most prominent example). Same conditional-drop
   pattern applies.

## Fix sketch

In `src/facet-manager.ts` (lines 215, 400) and
`src/node-shims.ts` (line 2312):

```js
function __mkCompiledFn(code) {
  const hasFn = /(?:^|\n|;)\s*(?:const|let|var)\s+__filename\s*=/m.test(code);
  const hasDn = /(?:^|\n|;)\s*(?:const|let|var)\s+__dirname\s*=/m.test(code);
  const params = ['exports','require','module'];
  if (!hasFn) params.push('__filename');
  if (!hasDn) params.push('__dirname');
  return new Function(...params, code);
}
```

Callers continue invoking with the full 5-arg form; JS ignores
trailing args when the function declares fewer parameters.

## Predicted post-fix shape

After dropping the `__dirname` param, vite's `chunks/node.js` parses
cleanly. Body executes `const __dirname = import_path.default.dirname((0, import_url.fileURLToPath)(import_meta.url))`.

`import_meta.url` is `undefined` (esbuild's empty-import-meta CJS
substitution; documented in X5M3-retro). `fileURLToPath(undefined)`
would normally throw — `__urlMod.fileURLToPath` (node-shims.ts:869) does
`(typeof u === "string" ? u : u.pathname).replace(...)`, which crashes
on `u === undefined` with "Cannot read properties of undefined".

So vite is likely to surface a NEW deeper failure at runtime
(`fileURLToPath(undefined)`), which would be the next bucket beyond
X.5-S. Per the dispatch: "vite ✅ at real-package install layer
(acceptable to surface NEW deeper failure if multiple class issues —
document)". That third-class failure is documented but out of X.5-S
scope.

## Regression matrix

| Layer | Probe | Expected |
|-------|-------|----------|
| Synthetic CJS | `audit/probes/x5s/investigation/repro.mjs` | repro RED → fix GREEN |
| Functional | `audit/probes/x5s/functional/f1-conditional-param-drop.mjs` | shim source has the conditional-drop helper |
| Functional | `audit/probes/x5s/functional/f2-eval-no-collision.mjs` | eval'd `__mkCompiledFn` against esbuild-shaped input parses without collision |
| Functional | `audit/probes/x5s/functional/f3-clean-body-still-binds-dirname.mjs` | when body has NO `const __dirname`, the param IS still injected so legacy CJS works |
| Regression | `audit/probes/x5s/regression/install-pipeline-coverage-shim.mjs` | re-run X.5-F shim coverage |
| Regression | `audit/probes/x5s/regression/single-resolver-source.mjs` | re-run X.5-F single-resolver guard |
| Regression | `audit/probes/x5s/regression/cross-wave-x5-runalls.mjs` | every prior X.5-* run-all green |
| E2E | `audit/probes/x5s/e2e/e1-vite-loads.mjs` | targeted `__dirname has already been declared` GONE |
