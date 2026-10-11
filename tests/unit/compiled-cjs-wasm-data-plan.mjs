#!/usr/bin/env bun
// An image the known CJS graph names is both a module-map image and data its
// loader reads. The CommonJS import.meta.url polyfill must not hide that
// sibling read from the first-run data plan.
import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';

const { host, rawVfs, kfs } = createAuthority();
let out = '';
adoptSessionSupervisor(host, (text) => { out += text; });
const manager = oneShotManager('compiled-cjs-wasm-data-plan', {
  host, rawVfs, loader: runnerLoader('compiled-cjs-wasm-data'),
});
// A valid image over the map's 4 MiB per-file cap: the data plan, not
// speculative package enrichment, has to hold it. No native compile occurs
// in the program; it reads the loader's bytes just as wasm-node.cjs does.
const padding = 5 * 1024 * 1024;
const payload = padding + 2;
const leb = [];
for (let size = payload; ; ) {
  const byte = size & 127;
  size >>>= 7;
  leb.push(size ? byte | 128 : byte);
  if (!size) break;
}
const image = new Uint8Array(8 + 1 + leb.length + payload);
image.set([0, 97, 115, 109, 1, 0, 0, 0, 0]);
image.set(leb, 9);
image.set([1, 112], 9 + leb.length);
const pkg = 'home/user/app/node_modules/known-css';
kfs.mkdir(pkg, { recursive: true, mode: 0o755 });
kfs.writeFile(`${pkg}/package.json`, JSON.stringify({ name: 'known-css', version: '1.0.0', main: 'loader.cjs' }));
kfs.writeFile(`${pkg}/loader.cjs`, `
var import_meta_url = typeof document === "undefined"
  ? new (require("url".replace("", ""))).URL("file:" + __filename).href
  : document.currentScript && document.currentScript.src || new URL("main.js", document.baseURI).href;
module.exports = require("fs").readFileSync(new URL("image.wasm", import_meta_url)).length;
`);
kfs.writeFile(`${pkg}/image.wasm`, image);
const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
let result;
try {
  result = await manager.exec('console.log(require("known-css"));', {
    filename: '/home/user/app/main.cjs', dirname: '/home/user/app', cwd: '/home/user/app', captureOutput: true,
  });
} finally { Object.assign(globalThis, real); }
assert.equal(result.exitCode, 0, `first-run known CJS image was not staged: ${result.stderr}${out}`);
assert.equal(Number((result.stdout + out).trim().split('\n').at(-1)), image.length);
console.log('compiled-cjs-wasm-data-plan: ok');
