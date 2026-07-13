#!/usr/bin/env bun
// Experimental: bundle opencode CLI for plain Node (no bun compile).
import path from "path"
import fs from "fs"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
// The fail-loud bundle-source transforms live in a side-effect-free sibling
// module so the unit tests can import the exact same patch logic. When this
// reference build-node.ts is copied into the opencode clone to run, copy
// bundle-patches.ts AND the stubs/*.ts resolve-hook modules alongside it
// (same directory) — see README.md "Rebuild".
import {
  nimbusPatchWebTreeSitter,
  nimbusPatchOpenTUI,
  nimbusPatchParserWorker,
  nimbusPatchRpcWorkerScope,
  nimbusPatchTuiWorkerEntry,
  OPENTUI_FFI_CHUNK_MARKER,
} from "./bundle-patches"

// bun >= 1.3.14 REQUIRED: earlier bundlers emit broken cross-chunk live
// bindings under code-splitting ("X is not a function" at runtime, e.g.
// SessionPrompt.getModel) — silent artifact corruption, so fail loud here.
const MIN_BUN = [1, 3, 14] as const
{
  const parts = Bun.version.split(".").map((n) => Number.parseInt(n, 10))
  const ok =
    parts[0] > MIN_BUN[0] ||
    (parts[0] === MIN_BUN[0] &&
      (parts[1] > MIN_BUN[1] || (parts[1] === MIN_BUN[1] && parts[2] >= MIN_BUN[2])))
  if (!ok) {
    throw new Error(
      `build-node.ts requires bun >= ${MIN_BUN.join(".")} (splitting emits broken ` +
        `cross-chunk bindings on older bundlers); running ${Bun.version}`,
    )
  }
}

const dir = "/tmp/opencode-research/opencode/packages/opencode"
process.chdir(dir)

const nimbusTreeSitterWasmRegistry = {
  name: "nimbus-web-tree-sitter-wasm-registry",
  setup(build: any) {
    build.onLoad({ filter: /web-tree-sitter[\\/]tree-sitter\.js$/ }, async (args: any) => {
      const source = await Bun.file(args.path).text()
      return { contents: nimbusPatchWebTreeSitter(source, args.path), loader: "js" }
    })
  },
}

// @opentui/core ships pre-built ESM chunks (index-<hash>.js); the FFI/backend/
// buffer code lives in the one chunk carrying the FFI marker. Patch only that
// chunk (the hash suffix is version-dependent, so match by content marker, not
// filename) and fail loud per anchor.
const nimbusOpenTUIBackendRegistry = {
  name: "nimbus-opentui-ffi-backend-registry",
  setup(build: any) {
    build.onLoad({ filter: /@opentui[\\/]core[\\/]index(-[a-z0-9]+)?\.js$/ }, async (args: any) => {
      const source = await Bun.file(args.path).text()
      if (!source.includes(OPENTUI_FFI_CHUNK_MARKER)) {
        return { contents: source, loader: "js" }
      }
      return { contents: nimbusPatchOpenTUI(source, args.path), loader: "js" }
    })
  },
}

// @opentui/core's parser.worker.js drives its message channel through a local
// `var self = globalThis` prelude that the build-time `define` can't reach;
// patch the initializer to claim the per-worker context (fail-loud).
const nimbusParserWorkerRegistry = {
  name: "nimbus-parser-worker-self-scope",
  setup(build: any) {
    build.onLoad({ filter: /@opentui[\\/]core[\\/]parser\.worker\.js$/ }, async (args: any) => {
      const source = await Bun.file(args.path).text()
      return { contents: nimbusPatchParserWorker(source, args.path), loader: "js" }
    })
  },
}

// The API-server worker's bare Web-Worker scope refs live in src/util/rpc.ts,
// which the SPLIT build shares between index.js and worker.js — so the scope
// rebind must be an explicit runtime parameter, not a bundle-wide `define`.
// See nimbusPatchRpcWorkerScope / nimbusPatchTuiWorkerEntry (fail-loud).
const nimbusWorkerScopeRegistry = {
  name: "nimbus-tui-worker-scope",
  setup(build: any) {
    build.onLoad({ filter: /src[\\/]util[\\/]rpc\.ts$/ }, async (args: any) => {
      const source = await Bun.file(args.path).text()
      return { contents: nimbusPatchRpcWorkerScope(source, args.path), loader: "ts" }
    })
    build.onLoad({ filter: /src[\\/]cli[\\/]cmd[\\/]tui[\\/]worker\.ts$/ }, async (args: any) => {
      const source = await Bun.file(args.path).text()
      return { contents: nimbusPatchTuiWorkerEntry(source, args.path), loader: "ts" }
    })
  },
}

const generated = await import(path.join(dir, "script/generate.ts"))
const plugin = createSolidTransformPlugin()
const bunAlias = {
  name: "bun-alias",
  setup(build: any) {
    build.onResolve({ filter: /^bun$/ }, () => ({ path: path.join(dir, "bun-shim.ts") }))
    build.onResolve({ filter: /^bun:ffi$/ }, () => ({ path: path.join(dir, "bun-ffi-shim.ts") }))
    build.onResolve({ filter: /^bun:sqlite$/ }, () => ({ path: path.join(dir, "bun-sqlite-shim.ts") }))
    build.onResolve({ filter: /^(@lydell\/node-pty|bun-pty)$/ }, () => ({ path: path.join(dir, "pty-stub.ts") }))
    build.onResolve({ filter: /^@opentui\/core-(darwin|linux|win32)-/ }, () => ({ path: path.join(dir, "opentui-native-stub.ts") }))
    build.onResolve({ filter: /^jsonc-parser$/ }, (args: any) => {
      const r = Bun.resolveSync("jsonc-parser", args.importer)
      return { path: r.replace(/lib\/umd\/main\.js$/, "lib/esm/main.js") }
    })
  },
}

const outdir = "/tmp/opencode-research/dist-nimbus"
// Clean the outdir: chunk names are content-hashed, so stale chunks from a
// previous build would accumulate and be packed into chunks.json blindly.
fs.rmSync(outdir, { recursive: true, force: true })

// The opencode TUI is a client/server split: the bare `opencode` TUI process
// (the client + renderer) spawns its API server as `new Worker("./worker.js")`
// and talks to it over birpc (cli/cmd/tui/worker.ts → worker.js). OpenTUI's
// syntax-highlight tree-sitter parser likewise runs in `new
// Worker("./parser.worker.js")` (@opentui/core/parser.worker.js). On Nimbus an
// in-isolate Worker polyfill (node-shims.ts) imports these staged modules, so
// each must be staged as its own self-contained ESM module alongside index.js.
const parserWorkerLocal = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
const parserWorkerRoot = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
const parserWorker = fs.realpathSync(fs.existsSync(parserWorkerLocal) ? parserWorkerLocal : parserWorkerRoot)
const tuiServerWorker = path.join(dir, "src/cli/cmd/tui/worker.ts")

// index.js (the CLI/TUI client) and worker.js (the TUI API server) are built
// in ONE call with code-splitting: they are two entrypoints over the SAME
// opencode server code, and the standalone builds duplicated ~12 MB of it.
// Inside the single Nimbus facet isolate both bundles load together, and the
// duplicated copy pushed the isolate over the Worker memory limit — the
// intermittent opencode-tui-render first-frame OOM kill. Shared chunks
// evaluate once for both entries. Flat output names (`naming` below) keep the
// `_assets/opencode/<ver>/` staging layout and the `./worker.js` specifier the
// runtime maps. parser.worker.js stays a standalone build — it is @opentui
// code sharing nothing with opencode, and its scope rebind uses the per-entry
// define config that a shared build cannot express.
const sharedConfig = {
  conditions: ["node"],
  tsconfig: path.join(dir, "tsconfig.json"),
  plugins: [
    plugin,
    bunAlias,
    nimbusTreeSitterWasmRegistry,
    nimbusOpenTUIBackendRegistry,
    nimbusParserWorkerRegistry,
    nimbusWorkerScopeRegistry,
  ],
  external: ["node-gyp"],
  format: "esm" as const,
  target: "node" as const,
  minify: true,
  sourcemap: "none" as const,
  splitting: false,
  outdir,
  define: {
    OPENCODE_VERSION: `'1.16.2'`,
    OPENCODE_MODELS_DEV: generated.modelsData,
    OTUI_TREE_SITTER_WORKER_PATH: `'./parser.worker.js'`,
    OPENCODE_WORKER_PATH: `'./worker.js'`,
    OPENCODE_CHANNEL: `'stable'`,
    OPENCODE_LIBC: `'glibc'`,
    "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
    // Nimbus: the bundle rides into the workerd Worker Loader module map as an
    // ESM module, where `import.meta.url` is undefined — so the top-level
    // `createRequire(import.meta.url)` throws. Bake a synthetic absolute file
    // URL so createRequire constructs (the require it produces resolves node:
    // builtins through nodejs_compat).
    "import.meta.url": JSON.stringify("file:///opencode/opencode-bundle.js"),
  },
}

// Web-Worker global scope shim for the two worker bundles. A real Web Worker
// runs in a DedicatedWorkerGlobalScope where `self`, `postMessage`, and
// `onmessage` are the worker's own message channel. On Nimbus both workers run
// IN the same facet isolate as the client (a single workerd Worker), so a bare
// `globalThis.postMessage` / `globalThis.onmessage` would collide between the
// two workers and with the client. Rebind these scope refs at build time to a
// per-worker context object the Worker polyfill (node-shims.ts) claims at
// module-init — so each worker's messaging routes to its own MessageChannel.
// `self` falls through to globalThis for every non-messaging member via the
// polyfill's proxy. Inert for index.js (the client), which is not built with
// this config and uses `worker.postMessage` / `worker.onmessage` on the
// instance, not bare scope refs.
const workerScopeConfig = {
  banner: "var __nimbusWorker = globalThis.__nimbusWorkerClaim();",
  define: {
    ...sharedConfig.define,
    self: "__nimbusWorker",
    postMessage: "__nimbusWorker.postMessage",
    onmessage: "__nimbusWorker.onmessage",
  },
}

let total = 0

// Split build: index.js + worker.js share chunk-<hash>.js modules. Entry
// names stay flat so the module map's `opencode-bundle.js` / `worker.js`
// specifiers and their relative `./chunk-*.js` imports resolve.
{
  const result = await Bun.build({
    ...sharedConfig,
    splitting: true,
    naming: { entry: "[name].js", chunk: "chunk-[hash].js", asset: "[name]-[hash].[ext]" },
    entrypoints: [path.join(dir, "src/index.ts"), tuiServerWorker],
  })
  if (!result.success) {
    console.error("build failed: index.js + worker.js (split)")
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  total += result.outputs.length
  console.log(`built index.js + worker.js (split): ${result.outputs.length} outputs`)
}

// parser.worker.js: standalone, with the per-entry worker-scope define.
{
  const result = await Bun.build({
    ...sharedConfig,
    ...workerScopeConfig,
    entrypoints: [parserWorker],
  })
  if (!result.success) {
    console.error("build failed: parser.worker.js (opentui tree-sitter)")
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  total += result.outputs.length
  console.log(`built parser.worker.js: ${result.outputs.length} outputs`)
}
console.log("built", total, "outputs total")

// Extract the yoga-layout wasm that @opentui/core inlines as a base64 data URI.
// OpenTUI lays out every TUI frame with yoga; its Emscripten loader does
// request-time WebAssembly.instantiate(bytes), which workerd blocks in a facet.
// The bundle patch (bundle-patches.ts seam 8) routes the loader to a
// pre-compiled WebAssembly.Module the runner parks on globalThis.__nimbusYogaModule;
// that Module rides in via the Worker Loader module map, so stage the raw bytes
// here alongside the workers (deterministically from the same source the bundle
// embeds — no drift). Fail loud if the inlined wasm cannot be found.
const opentuiCore = Bun.resolveSync("@opentui/core", dir)
const opentuiChunk = (() => {
  // The FFI/yoga chunk is a sibling index-<hash>.js of the resolved entry.
  const coreDir = path.dirname(opentuiCore)
  for (const f of fs.readdirSync(coreDir)) {
    if (/^index(-[a-z0-9]+)?\.js$/.test(f)) {
      const src = fs.readFileSync(path.join(coreDir, f), "utf8")
      if (src.includes(OPENTUI_FFI_CHUNK_MARKER)) return src
    }
  }
  throw new Error("opentui yoga extract: no @opentui/core chunk carrying the FFI/yoga marker")
})()
const yogaMatch = opentuiChunk.match(/data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/)
if (!yogaMatch) {
  throw new Error("opentui yoga extract: no base64 wasm data URI in the @opentui/core chunk")
}
const yogaBytes = Buffer.from(yogaMatch[1], "base64")
if (yogaBytes.length < 4 || yogaBytes.readUInt32BE(0) !== 0x0061736d) {
  throw new Error("opentui yoga extract: decoded data URI is not a wasm module (\\0asm magic missing)")
}
fs.writeFileSync(path.join(outdir, "yoga.wasm"), yogaBytes)
console.log(`extracted yoga.wasm: ${yogaBytes.length} bytes`)
