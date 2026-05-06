# X.5-Z3 Phase A — investigation summary

## TL;DR — goalposts moved between 700420f and 1e388a8

The **Z3 ESM-pre-compile bucket described in VERIFY-700420F.md §4 #2 is
empty at current main (1e388a8)**. The verbatim `Cannot load module
'.../​@csstools/css-tokenizer/dist/index.mjs': pre-compile failed at
facet startup: Unexpected token 'export'` error **no longer reproduces**.

The X.5-Z5-build wave (which shipped looksLikeEsm regex relaxation in
`src/facet-manager.ts:772/774` — see X5Z5-build-retro §2.2) had a
side-effect of also flipping jsdom's css-tokenizer ESM transform path,
even though X5Z5 was scoped to tailwindcss-vite. The
`@csstools/css-tokenizer` package's `dist/index.mjs` ends with
`...}export{u as HashType,...}` (no leading whitespace before `export`,
preceded by `}`). The pre-X5Z5 regex `/^\s*export\s/` would have missed
this minified shape; the post-X5Z5 regex
`/(^|[\n;}])\s*export[\s{*]/` (line 780) correctly matches.

i1 + i2 confirm:
- i1 reproduce: jsdom now fails at a **different layer** —
  `ENOENT: no such file or directory, open
  '/home/user/app/node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css'`
  thrown from jsdom's
  `lib/jsdom/living/css/helpers/computed-style.js:16-19`:
  ```js
  const defaultStyleSheet = fs.readFileSync(
    path.resolve(__dirname, "../../../browser/default-stylesheet.css"),
    { encoding: "utf-8" }
  );
  ```
- i2 inspection (probe artefact at `i2-vfs-inspection.out.txt`):
  - `ls node_modules/@csstools/css-tokenizer/dist/` shows
    `index.d.ts  index.mjs` ✅
  - `require('@csstools/css-tokenizer')` succeeds with
    `keys:["HashType","NumberType","ParseError","ParseErrorMessage","ParseErrorWithToken"]`
    — Z3 transform is healthy.
  - `ls node_modules/jsdom/lib/jsdom/browser/` shows
    `default-stylesheet.css  not-implemented.js  parser  resources  Window.js`
    — file IS on VFS-disk.
  - `readdirSync('/.../browser')` from inside facet returns the file
    name (from `__MODULE_VFS_MANIFEST`).
  - `readFileSync('/.../default-stylesheet.css')` from inside facet
    throws ENOENT — the file is **not in `__MODULE_VFS_BUNDLE`**.

## Root cause (NEW bucket — call it "Z4-asset-prefetch")

The facet runtime is air-gapped from the VFS: at startup,
`buildPrefetchBundle` (`src/facet-manager.ts:885`) bundles every file
the require-graph reaches, plus pkg.json+main entries via
`greedyAddMainEntries` (W2.6a). The fs shim's `readFileSync`
(`src/node-shims.ts:202-215`) only consults `__vfsBundle` and
`__vfsWrites` — there is **no fall-back** to live VFS reads.

Asset files (.css, .html, .txt, etc.) loaded at runtime via
`fs.readFileSync(path.resolve(__dirname, "../foo.css"))` fall outside
the bundle:
- The require-walker (`src/require-resolver.ts:484`) only recurses
  into `.js/.mjs/.cjs`.
- The greedy pass (`src/facet-manager.ts:606+`) only adds
  `package.json + main entry` per pkg dir.

`readdirSync` works because it consults the uncapped manifest;
`readFileSync` doesn't because the manifest holds names only.

## Fix sketch (NEW Z4 bucket — bound to facet-manager.ts only)

In `buildPrefetchBundle`, between greedy pass and ESM transform pass,
add an **asset-prefetch pass** that:
1. Scans every bundle .js/.mjs/.cjs source for static
   `fs.readFileSync(...)` (and `readFileSync(...)`) call patterns that
   reference relative paths via `path.resolve(__dirname, "<literal>")`
   or string-literal absolute paths.
2. Resolves the literal path against the source file's containing dir
   (the `__dirname` substitute).
3. Pulls the resolved file from VFS into the bundle (subject to the
   existing byte-cap).

Conservative scope: only handle the `path.resolve(__dirname, "...")`
shape (jsdom uses it; tailwind-mode/preflight/grayMatter etc. also use
it). Skip dynamic/template-literal forms — they're a distinct,
unbounded class.

**File scope**: `src/facet-manager.ts` only. Out of charter for
node-shims.ts, require-resolver.ts, npm-resolver.ts, npm-installer.ts.

## Why Z3 looked active in the VERIFY-700420F snapshot

The verify-700420f probe was captured on 700420f (pre-X5Z5-build).
The X5Z5-build-retro shipped on a571079, with X5R closing right
afterwards (66b6897 → 1e388a8 main). The jsdom ⛔ error verbatim
captured by VERIFY-700420F was *correct at 700420f*; the same package
*at the latest main* surfaces a new error class.

This is **the same goalposts-moved pattern** documented in
X5R-retro §"goalposts moved between 700420f and a571079" for fastify
(which X.5-R also discovered was already-flipped because of an X.5-Z5
side-effect).

## Predicted ✅ delta (revised)

Plan TARGET still: jsdom ✅ at real-package install layer (per
prompt's done-criterion). Mechanism revised: asset-prefetch pass for
.css (and likely .html/.txt as bycatch). Predicted +1 ✅ unchanged.

Cross-package: tailwindcss-vite is the other Z3-bucket member per
VERIFY-700420F §3, but it's blocked at lightningcss native binding
(per X5Z5-build-retro §2.2) — no asset-prefetch will help it. So
Z4 only delivers +1 (jsdom).
