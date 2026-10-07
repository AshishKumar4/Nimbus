#!/usr/bin/env bun
// wasm-image-first-use — a launch's wasm images compile when the program
// first compiles them, not when the process loads.
//
// The runner imported every image the closure carries, so each compiled at
// load: Vite 8's dev server compiled lightningcss's 15.8 MB image on every
// launch, whether or not it transformed any CSS. Under new_module_registry a
// wasm map member compiles on first evaluation, and a registry require() of
// it at request time is allowed (measured on Worker Loader guests: 16 MiB,
// startup 49 ms unimported vs 77 ms imported). So the runner names each
// image's member and the seam requires it when a compile of its bytes
// happens, once.
import assert from 'node:assert/strict';
import { facetWasmImportsSource } from '../../packages/worker/src/facets/manager.ts';
import { wasmImageDigest } from '../../packages/worker/src/facets/wasm-image-digest.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const image = new Uint8Array(64);
image.set(WASM_HEADER);
for (let i = 8; i < image.length; i++) image[i] = i;
const other = new Uint8Array(image); other[40] ^= 1;
const IMPORTS = [
  { vfsPath: '/home/user/app/node_modules/lightningcss/lightningcss_node.wasm', digest: wasmImageDigest(image), moduleName: '__nimbus_wasm_0.wasm' },
  { vfsPath: '/home/user/app/node_modules/other/other.wasm', digest: wasmImageDigest(other), moduleName: '__nimbus_wasm_1.wasm' },
];

// ── the runner names the images; it imports none ──
const source = facetWasmImportsSource(IMPORTS);
assert.doesNotMatch(source, /^\s*import\s+\w+\s+from\s+["']__nimbus_wasm_/m, 'no image is a static import, which compiles it at load');
assert.match(source, /^import \{ createRequire as (\w+) \} from "node:module";$/m, 'the runner takes the registry\'s require');
assert.equal(facetWasmImportsSource([]), '', 'a launch with no image adds nothing');

// Evaluate it as the runner's module scope would: its one import supplied.
const required = [];
const compiled = new Map(IMPORTS.map((entry) => [entry.moduleName, { tag: 'loader-compiled ' + entry.moduleName }]));
const createRequire = (url) => {
  assert.equal(url, 'file:///bundle/worker.js', 'the require resolves beside the runner');
  return (specifier) => { required.push(specifier); return compiled.get(specifier.replace(/^\.\//, '')); };
};
const scope = {};
const body = source.replace(/^import \{ createRequire as (\w+) \} from "node:module";$/m, 'const $1 = __createRequire;')
  .replaceAll('import.meta.url', '__url');
new Function('globalThis', '__createRequire', '__url', body)(scope, createRequire, 'file:///bundle/worker.js');
assert.deepEqual(required, [], 'loading the runner compiles nothing');

// ── the seam compiles an image when its bytes are compiled, once ──
const shims = generateShimsCode();
const seam = shims.slice(shims.indexOf('const __nimbusPrecompiledWasm ='), shims.indexOf('// ═══', shims.indexOf('WA.__nimbusPrecompiledSeam = true')));
const refused = () => { throw new Error('Wasm code generation disallowed for this context'); };
const WA = {
  Module: function Module() { refused(); },
  compile: async () => refused(),
  instantiate: async (source) => {
    if ([...compiled.values()].includes(source)) return { exports: {} };
    refused();
  },
};
WA.Module.prototype = {};
scope.WebAssembly = WA;
new Function('globalThis', '__BufferMod', seam)(scope, { from: (x) => x });
assert.deepEqual(required, [], 'installing the seam compiles nothing');

const first = scope.WebAssembly.Module(new Uint8Array(image));
assert.equal(first, compiled.get('__nimbus_wasm_0.wasm'), 'new WebAssembly.Module(bytes) is the loader\'s module for those bytes');
assert.deepEqual(required, ['./__nimbus_wasm_0.wasm'], 'and only that image was compiled, when it was used');
assert.equal(scope.WebAssembly.Module(new Uint8Array(image)), first, 'a second compile of the same bytes');
assert.equal(await scope.WebAssembly.compile(new Uint8Array(image)), first, 'and WebAssembly.compile of them');
const { module } = await scope.WebAssembly.instantiate(new Uint8Array(image), {});
assert.equal(module, first, 'and WebAssembly.instantiate of them');
assert.deepEqual(required, ['./__nimbus_wasm_0.wasm'], 'reuse the module compiled first');

// A path-tagged read (fs.readFileSync of the image's path) is answered the same way.
const tag = Symbol.for('nimbus.precompiledWasmModule');
const read = new Uint8Array(other);
read[tag] = scope.__nimbusPrecompiledWasm.get('home/user/app/node_modules/other/other.wasm');
assert.equal(typeof read[tag], 'function', 'the path map holds the image\'s compile, not a compiled module');
assert.equal(scope.WebAssembly.Module(read), compiled.get('__nimbus_wasm_1.wasm'), 'a path-tagged read compiles its image on use');
assert.deepEqual(required, ['./__nimbus_wasm_0.wasm', './__nimbus_wasm_1.wasm']);

// Bytes no launch registered are still refused, naming what it carries.
const unknown = new Uint8Array(image); unknown[20] ^= 1;
assert.throws(() => scope.WebAssembly.Module(unknown), /Images this launch does carry: 4/);

console.log('wasm-image-first-use: ok');
