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
  `packages/opencode/build-node.ts` (copy `bundle-patches.ts` and the
  `stubs/*.ts` resolve-hook stubs alongside it; `script/generate.ts` is
  opencode's own).

- `stubs/` — the five resolve-hook stub modules the build aliases in:
  `bun-shim.ts` (Bun globals available on node), `bun-ffi-shim.ts` /
  `bun-sqlite-shim.ts` (fail-loud: workerd has no native FFI; node:sqlite is
  the supported driver), `pty-stub.ts` (no PTY subsystem), and
  `opentui-native-stub.ts` (the wasm backend replaces the Zig dylib).

  The build produces `index.js` (the CLI/TUI client) and `worker.js` (the TUI
  API server, `cli/cmd/tui/worker.ts`) in ONE code-splitting build — they are
  two entrypoints over the same opencode server code, and building them
  standalone duplicated ~12 MB of it; inside the single Nimbus facet isolate
  both bundles load together and the duplicate copy pushed the isolate over
  the Worker memory limit (the intermittent opencode-tui-render first-frame
  OOM). The shared `chunk-<hash>.js` modules evaluate once for both entries;
  `scripts/bundle-opencode.mjs` aggregates them into one `chunks.json` pack
  asset that the supervisor expands into facet module-map entries per spawn.
  `parser.worker.js` (OpenTUI's tree-sitter parser) stays a standalone build.

  opencode's interactive TUI is a client/server split — the bare `opencode`
  client spawns its server as `new Worker("./worker.js")` and OpenTUI its
  parser as `new Worker("./parser.worker.js")` — which Nimbus runs in one facet
  isolate via the in-isolate Worker polyfill (`opencode-facet-runner.ts`).
  Because the split build shares the messaging code between client and server,
  the worker-scope rebind is an explicit runtime parameter, not a build-level
  `define`: the worker entry claims its per-worker context
  (`globalThis.__nimbusWorkerClaim`) at module-body start and threads it
  through the shared `Rpc.listen`/`Rpc.emit` seams
  (`nimbusPatchTuiWorkerEntry` / `nimbusPatchRpcWorkerScope`, fail-loud), with
  a `globalThis` fallback that preserves upstream Worker behavior under Bun.
  `parser.worker.js` keeps the banner + `define` rebind (plus its fail-loud
  self-scope patch). The recipe also extracts `yoga.wasm` (OpenTUI's
  frame-layout engine, inlined as base64 in `@opentui/core`) so it can ride in
  pre-compiled — request-time `WebAssembly.instantiate(bytes)` is blocked in
  facets.

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

  `bundle-patches.ts` (`nimbusPatchOpenTUI`) carries the `@opentui/core` seams
  for the TUI render path, the same pre-compiled-module way: the FFI backend
  (the wasm32-wasi reactor), the renderer's stdout/clock defaults, and the
  yoga-layout loader — its request-time `WebAssembly.instantiate(bytes)` is
  rerouted to the `globalThis.__nimbusYogaModule` the runner parks. All seams
  are exact-match fail-loud and inert under a normal Bun run.

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
# Fresh clone + deps (bun's isolated linker breaks Bun.build resolution of
# transitive CJS deps; postinstall scripts try to compile native grammars):
git clone --depth 1 --branch v<version> https://github.com/sst/opencode \
  /tmp/opencode-research/opencode
cd /tmp/opencode-research/opencode
bun install --ignore-scripts --linker=hoisted

# Apply the Nimbus source patches + copy the build recipe in:
git apply <this-dir>/nimbus-defer-global-io.patch
git apply <this-dir>/nimbus-tree-sitter-exports.patch
cp <this-dir>/build-node.ts <this-dir>/bundle-patches.ts \
   <this-dir>/stubs/*.ts packages/opencode/

# Build (→ /tmp/opencode-research/dist-nimbus). Requires bun >= 1.3.14:
# earlier bun versions emit broken cross-chunk live bindings under
# code-splitting ("X is not a function" at runtime, e.g. SessionPrompt.getModel).
cd packages/opencode && bun build-node.ts

# In Nimbus:
node packages/worker/scripts/bundle-opencode.mjs   # restage into public/_assets
bun run --cwd packages/worker build
```
