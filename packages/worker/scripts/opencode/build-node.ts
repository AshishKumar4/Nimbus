#!/usr/bin/env bun
// Experimental: bundle opencode CLI for plain Node (no bun compile).
import path from "path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
// The fail-loud bundle-source transforms live in a side-effect-free sibling
// module so the unit tests can import the exact same patch logic. When this
// reference build-node.ts is copied into the opencode clone to run, copy
// bundle-patches.ts alongside it (same directory).
import { nimbusPatchWebTreeSitter, nimbusPatchOpenTUI, OPENTUI_FFI_CHUNK_MARKER } from "./bundle-patches"

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

const result = await Bun.build({
  conditions: ["node"],
  tsconfig: path.join(dir, "tsconfig.json"),
  plugins: [plugin, bunAlias, nimbusTreeSitterWasmRegistry, nimbusOpenTUIBackendRegistry],
  external: ["node-gyp"],
  format: "esm",
  target: "node",
  minify: true,
  sourcemap: "none",
  splitting: false,
  outdir: "/tmp/opencode-research/dist-nimbus",
  entrypoints: [path.join(dir, "src/index.ts")],
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
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log("built", result.outputs.length, "outputs")
