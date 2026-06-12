#!/usr/bin/env bun
// Experimental: bundle opencode CLI for plain Node (no bun compile).
import path from "path"
import fs from "fs"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
// The fail-loud bundle-source transforms live in a side-effect-free sibling
// module so the unit tests can import the exact same patch logic. When this
// reference build-node.ts is copied into the opencode clone to run, copy
// bundle-patches.ts alongside it (same directory).
import { nimbusPatchWebTreeSitter, nimbusPatchOpenTUI, nimbusPatchParserWorker, OPENTUI_FFI_CHUNK_MARKER } from "./bundle-patches"

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

// Each entrypoint is built as a SEPARATE, self-contained bundle (splitting
// off). Bun's code-splitting names the entry+chunk outputs after their
// source-relative paths (deep node_modules/src trees), which breaks both the
// flat `_assets/opencode/<ver>/` staging layout and the `./worker.js` /
// `./parser.worker.js` module specifiers the runtime maps. Standalone builds
// keep one flat file per worker at the cost of duplicating shared code — the
// same tradeoff index.js already makes.
const sharedConfig = {
  conditions: ["node"],
  tsconfig: path.join(dir, "tsconfig.json"),
  plugins: [plugin, bunAlias, nimbusTreeSitterWasmRegistry, nimbusOpenTUIBackendRegistry, nimbusParserWorkerRegistry],
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

const builds: Array<{ label: string; entry: string; worker?: boolean }> = [
  { label: "index.js", entry: path.join(dir, "src/index.ts") },
  { label: "worker.js (tui api server)", entry: tuiServerWorker, worker: true },
  { label: "parser.worker.js (opentui tree-sitter)", entry: parserWorker, worker: true },
]

let total = 0
for (const { label, entry, worker } of builds) {
  const config = worker ? { ...sharedConfig, ...workerScopeConfig } : sharedConfig
  const result = await Bun.build({ ...config, entrypoints: [entry] })
  if (!result.success) {
    console.error(`build failed: ${label}`)
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  total += result.outputs.length
  console.log(`built ${label}: ${result.outputs.length} outputs`)
}
console.log("built", total, "outputs total")
