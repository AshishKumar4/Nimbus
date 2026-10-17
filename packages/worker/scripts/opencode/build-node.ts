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
  nimbusFoldModelsCatalogGuard,
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

const dir = path.resolve(process.env.NIMBUS_OPENCODE_ROOT || "/tmp/opencode-research/opencode/packages/opencode")
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

// The parser installs its message handler only off the main thread
// (`if (!isMainThread)`), and in the facet it shares the client's thread, where
// the platform's worker_threads says main. Its own worker_threads says worker
// (stubs/parser-worker-threads.ts).
const nimbusParserWorkerThreads = {
  name: "nimbus-parser-worker-threads",
  setup(build: any) {
    build.onResolve({ filter: /^(node:)?worker_threads$/ }, () => ({ path: path.join(dir, "parser-worker-threads.ts") }))
  },
}

const generated = await import(path.join(dir, "script/generate.ts"))
const nimbusModelsCatalog = {
  name: "nimbus-single-models-catalog",
  setup(build: any) {
    build.onLoad({ filter: /[\\/]core[\\/]src[\\/]models-dev\.ts$/ }, async (args: any) => ({
      contents: nimbusFoldModelsCatalogGuard(await Bun.file(args.path).text(), args.path), loader: "ts",
    }))
  },
}
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

const outdir = path.resolve(process.env.NIMBUS_OPENCODE_DIST || "/tmp/opencode-research/dist-nimbus")
if (outdir === path.parse(outdir).root || dir === outdir || dir.startsWith(outdir + path.sep)) {
  throw new Error("OpenCode output must not be the filesystem root or an ancestor of its source")
}
// Clean the outdir: chunk names are content-hashed, so stale chunks from a
// previous build would accumulate and be packed into chunks.json blindly.
fs.rmSync(outdir, { recursive: true, force: true })

// OpenTUI runs its syntax-highlight tree-sitter parser in `new
// Worker("./parser.worker.js")` (@opentui/core/parser.worker.js). On Nimbus an
// in-isolate Worker polyfill (opencode-facet-runner.ts) imports that staged
// module, so it must be staged as its own self-contained ESM module alongside
// index.js. opencode's own API-server worker is NOT built: a Nimbus TUI
// attaches over HTTP to a dedicated `opencode serve` facet, so nothing spawns
// it, and the polyfill fails loud if anything ever does.
const parserWorkerLocal = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
const parserWorkerRoot = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
const parserWorker = fs.realpathSync(fs.existsSync(parserWorkerLocal) ? parserWorkerLocal : parserWorkerRoot)

// index.js (the CLI/TUI client) is built with code-splitting: its lazy command
// handlers import `chunk-<hash>.js` modules, which the staging script packs
// into chunks.json. Flat output names (`naming` below) keep the
// `_assets/opencode/<ver>/` staging layout and the relative chunk specifiers
// the module map resolves. parser.worker.js stays a standalone build — it is
// @opentui code sharing nothing with opencode, and its scope rebind uses the
// per-entry define config that a shared build cannot express.
const sharedConfig = {
  conditions: ["node"],
  tsconfig: path.join(dir, "tsconfig.json"),
  plugins: [
    plugin,
    bunAlias,
    nimbusTreeSitterWasmRegistry,
    nimbusOpenTUIBackendRegistry,
    nimbusParserWorkerRegistry,
    nimbusModelsCatalog,
  ],
  external: ["node-gyp"],
  format: "esm" as const,
  target: "node" as const,
  minify: true,
  sourcemap: "none" as const,
  splitting: false,
  outdir,
  define: {
    OPENCODE_VERSION: JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version),
    OPENCODE_MODELS_DEV: generated.modelsData,
    OTUI_TREE_SITTER_WORKER_PATH: `'./parser.worker.js'`,
    OPENCODE_CHANNEL: `'stable'`,
    OPENCODE_LIBC: `'glibc'`,
    "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
    // No `import.meta.url` define: the facet runs with new_module_registry
    // (GUEST_COMPAT_FLAGS), whose modules carry a real `import.meta.url`, so
    // the bundle's top-level `createRequire(import.meta.url)` constructs.
  },
}

// Web-Worker global scope shim for the parser bundle. A real Web Worker runs in
// a DedicatedWorkerGlobalScope where `self`, `postMessage`, and `onmessage` are
// the worker's own message channel. On Nimbus the parser runs IN the client's
// facet isolate (a single workerd Worker), so a bare `globalThis.postMessage` /
// `globalThis.onmessage` would collide with the client's. Rebind these scope
// refs at build time to a per-worker context object the Worker polyfill
// (opencode-facet-runner.ts) claims at module-init, so the parser's messaging
// routes to its own channel. `self` falls through to globalThis for every
// non-messaging member via the polyfill's proxy. Inert for index.js (the
// client), which is not built with this config.
// The worker shares the client's isolate, so its globals are the client's:
// its `self` is the context it claimed, and its console its own (the parser
// reroutes console.log/error/warn to the client as WORKER_LOG messages; the
// client's console stays the client's).
const workerScopeConfig = {
  banner: "var __nimbusWorker = globalThis.__nimbusWorkerClaim(); var __nimbusWorkerConsole = Object.create(globalThis.console);",
  define: {
    ...sharedConfig.define,
    self: "__nimbusWorker",
    postMessage: "__nimbusWorker.postMessage",
    onmessage: "__nimbusWorker.onmessage",
    console: "__nimbusWorkerConsole",
  },
}

let total = 0

// Split build: index.js plus the chunk-<hash>.js modules its lazy command
// handlers import. Entry names stay flat so the module map's
// `opencode-bundle.js` specifier and the relative `./chunk-*.js` imports
// resolve.
{
  const result = await Bun.build({
    ...sharedConfig,
    splitting: true,
    naming: { entry: "[name].js", chunk: "chunk-[hash].js", asset: "[name]-[hash].[ext]" },
    entrypoints: [path.join(dir, "src/index.ts")],
  })
  if (!result.success) {
    console.error("build failed: index.js (split)")
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  total += result.outputs.length
  console.log(`built index.js (split): ${result.outputs.length} outputs`)
}

// parser.worker.js: standalone, with the per-entry worker-scope define.
{
  const result = await Bun.build({
    ...sharedConfig,
    ...workerScopeConfig,
    plugins: [...sharedConfig.plugins, nimbusParserWorkerThreads],
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
