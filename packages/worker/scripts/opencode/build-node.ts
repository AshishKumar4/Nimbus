#!/usr/bin/env bun
// Experimental: bundle opencode CLI for plain Node (no bun compile).
import path from "path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const dir = "/tmp/opencode-research/opencode/packages/opencode"
process.chdir(dir)

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
  plugins: [plugin, bunAlias],
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
