declare module 'esbuild-wasm/esbuild.wasm' {
  // wrangler bundles a `.wasm` import as a compiled wasm module: workerd
  // compiles it at script startup and hands the importer the
  // WebAssembly.Module (https://developers.cloudflare.com/workers/wrangler/bundling/#including-non-javascript-modules).
  const module: WebAssembly.Module;
  export default module;
}
