<!--
This document is edited and maintained by Claude and is presented as-is.
-->

# opencode Nimbus build recipe

Nimbus runs the opencode CLI as a single-file ESM bundle inside a workerd
Worker Loader facet (see `src/runtime/opencode-facet-runner.ts`). The bundle is
NOT `npm install opencode-ai` (that ships native shards Nimbus cannot execute);
it is produced from the opencode source with Nimbus-specific build flags and
source patches, then staged by `scripts/bundle-opencode.mjs`.

This directory captures the parts of that recipe that live outside the source
clone, so the staged bundle is reproducible.

## Files

- `build-node.ts` — the `Bun.build` recipe (target node, `conditions:["node"]`,
  `format:"esm"`). Reference copy; runs from inside the opencode clone at
  `packages/opencode/build-node.ts` (it needs the clone's resolve-hook stub
  files: `bun-shim.ts`, `bun-ffi-shim.ts`, `bun-sqlite-shim.ts`, `pty-stub.ts`,
  `opentui-native-stub.ts`, and `script/generate.ts`).

  Nimbus-relevant defines:
  - `import.meta.url` → a synthetic absolute file URL so the bundle's
    top-level `createRequire(import.meta.url)` constructs (in a Worker Loader
    ESM module `import.meta.url` is otherwise `undefined`).

  Nimbus build plugin (`nimbusPatchWebTreeSitter`): request-time
  `WebAssembly.compile(bytes)` is blocked in workerd facets, so
  web-tree-sitter's two byte→compile seams are patched at bundle time to
  consult `globalThis.__nimbusTreeSitterModules` — a runner-populated
  `Map<wasm basename, WebAssembly.Module>` of pre-compiled modules carried in
  via the Worker Loader module map (the sql.js pattern):
  - Emscripten `createWasm` (the tree-sitter core wasm) → `new
    WebAssembly.Instance(registeredModule, imports)`.
  - `Language.load(path)` (grammar wasm) → hands the registered Module to
    `loadWebAssemblyModule`, which natively accepts a `WebAssembly.Module`
    (instantiate + `customSections`, no compile).

  Both seams FAIL LOUD ("tree-sitter wasm not pre-registered: <name>") when
  the registry is active but a wasm is missing — never a silent fallback to
  the blocked compile path. When the registry global is absent (a normal Bun
  run) both seams behave exactly as upstream. The patterns are exact-match
  against web-tree-sitter 0.25.10; the build throws if they drift.

- `nimbus-defer-global-io.patch` — source patches that defer opencode's
  module-top-level side effects out of workerd's "global scope" (where async
  I/O, timers, and random generation are disallowed) into the request handler.
  Apply with `git apply` inside the opencode clone before building:

  | File | Change |
  |---|---|
  | `packages/core/src/global.ts` | XDG dir `fs.mkdir` Promise.all → `export async function ensureDirs()`, gated behind `__NIMBUS_OPENCODE_DEFER`. |
  | `packages/core/src/effect/observability.ts` | top-level `crypto.randomUUID()` → lazy `processID()`. |
  | `packages/opencode/src/index.ts` | top-level `await cli.parse()` → `export async function nimbusMain()` (awaits `Global.ensureDirs()` first); `ensureProcessMetadata("main")` made lazy; self-invoke gated behind `__NIMBUS_OPENCODE_DEFER`. |

  Under Bun (a normal install) `__NIMBUS_OPENCODE_DEFER` is unset, so opencode
  behaves exactly as upstream. The Nimbus runner sets the flag and invokes
  `nimbusMain()` from its `fetch` handler.

- `nimbus-tree-sitter-exports.patch` — re-exports web-tree-sitter's `Parser`
  and `Language` from `packages/opencode/src/index.ts` so the Nimbus runner's
  model-free tree-sitter diagnostic (`opencode __nimbus-tree-sitter-diag
  [command]`, see `src/runtime/opencode-facet-runner.ts`) exercises the SAME
  web-tree-sitter instance the bash tool's parser uses. Passive re-export —
  inert under a normal Bun install. Apply AFTER
  `nimbus-defer-global-io.patch` (its context includes that patch's hunks).

## Rebuild

```
# In the opencode clone:
git apply <this-dir>/nimbus-defer-global-io.patch
git apply <this-dir>/nimbus-tree-sitter-exports.patch
bun run packages/opencode/build-node.ts        # → /tmp/opencode-research/dist-nimbus

# In Nimbus:
node packages/worker/scripts/bundle-opencode.mjs   # restage into public/_assets
bun run --cwd packages/worker build
```
