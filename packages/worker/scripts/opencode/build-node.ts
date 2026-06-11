#!/usr/bin/env bun
// Experimental: bundle opencode CLI for plain Node (no bun compile).
import path from "path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const dir = "/tmp/opencode-research/opencode/packages/opencode"
process.chdir(dir)

// Nimbus: web-tree-sitter loads its core wasm (Emscripten createWasm) and
// grammar wasm (Language.load → loadWebAssemblyModule) by compiling bytes —
// request-time WebAssembly.compile is blocked in workerd facets. Pre-compiled
// WebAssembly.Modules ride in via the Worker Loader module map instead; the
// Nimbus runner parks them on `globalThis.__nimbusTreeSitterModules`
// (Map<wasm basename, WebAssembly.Module>). This transform patches the two
// byte→compile seams to consult that registry, keyed by the basename of the
// requested wasm path, and to FAIL LOUD when the registry is active but the
// requested wasm was not pre-registered. When the registry global is absent
// (a normal Bun run) both seams behave exactly as upstream.
// loadWebAssemblyModule and getDylinkMetadata natively accept a
// WebAssembly.Module (instantiate + customSections — no compile), so the
// grammar seam only swaps the resolved "bytes" for the registered Module.
function nimbusPatchWebTreeSitter(source: string, file: string): string {
  const replaceOnce = (src: string, find: string, repl: string): string => {
    const first = src.indexOf(find)
    if (first < 0 || src.indexOf(find, first + find.length) >= 0) {
      throw new Error(
        `nimbus web-tree-sitter patch: expected exactly one match for ` +
          `${JSON.stringify(find.slice(0, 80))}… in ${file} — web-tree-sitter ` +
          `changed; re-derive the wasm-registry seams`,
      )
    }
    return src.replace(find, repl)
  }

  // Seam 1 — grammar wasm: Language.load(path) node branch. Resolve the
  // pre-compiled Module from the registry instead of fs-reading bytes.
  source = replaceOnce(
    source,
    `      if (globalThis.process?.versions.node) {
        const fs2 = await import("fs/promises");
        bytes = fs2.readFile(input);
      } else {`,
    `      if (globalThis.__nimbusTreeSitterModules) {
        const __nimbusTsName = String(input).split(/[\\\\/]/).pop();
        const __nimbusTsModule = globalThis.__nimbusTreeSitterModules.get(__nimbusTsName);
        if (!__nimbusTsModule) {
          throw new Error("tree-sitter wasm not pre-registered: " + __nimbusTsName);
        }
        bytes = Promise.resolve(__nimbusTsModule);
      } else if (globalThis.process?.versions.node) {
        const fs2 = await import("fs/promises");
        bytes = fs2.readFile(input);
      } else {`,
  )

  // Seam 2 — core wasm: Emscripten createWasm. Instantiate the registered
  // pre-compiled Module (sync Instance of a precompiled Module is allowed in
  // workerd) instead of compiling bytes.
  source = replaceOnce(
    source,
    `      var info2 = getWasmImports();
      if (Module["instantiateWasm"]) {`,
    `      var info2 = getWasmImports();
      if (globalThis.__nimbusTreeSitterModules) {
        try {
          wasmBinaryFile ??= findWasmBinary();
          var __nimbusTsName = String(wasmBinaryFile).split(/[\\\\/]/).pop();
          var __nimbusTsModule = globalThis.__nimbusTreeSitterModules.get(__nimbusTsName);
          if (!__nimbusTsModule) {
            throw new Error("tree-sitter wasm not pre-registered: " + __nimbusTsName);
          }
          return receiveInstance(new WebAssembly.Instance(__nimbusTsModule, info2), __nimbusTsModule);
        } catch (__nimbusTsErr) {
          readyPromiseReject(__nimbusTsErr);
          throw __nimbusTsErr;
        }
      }
      if (Module["instantiateWasm"]) {`,
  )

  return source
}

const nimbusTreeSitterWasmRegistry = {
  name: "nimbus-web-tree-sitter-wasm-registry",
  setup(build: any) {
    build.onLoad({ filter: /web-tree-sitter[\\/]tree-sitter\.js$/ }, async (args: any) => {
      const source = await Bun.file(args.path).text()
      return { contents: nimbusPatchWebTreeSitter(source, args.path), loader: "js" }
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
  plugins: [plugin, bunAlias, nimbusTreeSitterWasmRegistry],
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
