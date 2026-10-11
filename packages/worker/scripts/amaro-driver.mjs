// amaro's dist/index.js compiles an inline base64 wasm when it loads, which a
// Worker cannot do; the facet hands it the module its loader compiled instead.
// Both functions refuse a file not of that shape, so an amaro update fails the
// build rather than the facet.

const INLINE = /var bytes = (\w+)\.from\("([A-Za-z0-9+/=]+)", "base64"\);\s*var wasmModule = new WebAssembly\.Module\(bytes\);/;

export function amaroInlineWasm(driver) {
  const found = INLINE.exec(driver);
  if (found === null) throw new Error('[amaro-driver] dist/index.js no longer compiles an inline base64 wasm the way this expects');
  return Buffer.from(found[2], 'base64');
}

const REQUIRES = [
  ['var { TextDecoder, TextEncoder } = require("util");', 'var { TextDecoder, TextEncoder } = globalThis;'],
  ['var { Buffer: Buffer2 } = require("node:buffer");', ''],
];

export function amaroFacetDriver(driver) {
  if (!INLINE.test(driver)) throw new Error('[amaro-driver] dist/index.js no longer compiles an inline base64 wasm the way this expects');
  let patched = driver.replace(INLINE, 'var wasmModule = globalThis.__nimbusAmaroWasm;');
  for (const [from, to] of REQUIRES) {
    if (patched.split(from).length !== 2) throw new Error(`[amaro-driver] dist/index.js no longer reads ${from}`);
    patched = patched.replace(from, to);
  }
  if (/\brequire\(/.test(patched)) throw new Error('[amaro-driver] dist/index.js requires a module this does not provide');
  return patched;
}
