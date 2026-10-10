#!/usr/bin/env bun
// import() can discover a JS package only after a tool writes its config.
// The package's synchronous sibling-Wasm read must be prefetched as well,
// even though neither the module nor its data was in the launch-time plan.
import assert from 'node:assert/strict';
import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';
import { StorageLedger } from '../../packages/core/src/runtime/storage-ledger.ts';
import { createAuthority, facetSql, facetSupervisor, launchResident, runScenarios, until } from './lib/resident-body.mjs';

await runScenarios(import.meta.filename, {
  async lateCommonJsUrlPolyfillReadsItsImage() {
    const root = 'home/user/app';
    const authority = createAuthority();
    authority.kfs.mkdir(`${root}/node_modules/late`, { recursive: true, mode: 0o755 });
    authority.kfs.writeFile(`${root}/node_modules/late/loader.cjs`, `
var import_meta_url = typeof document === "undefined"
  ? new (require("url".replace("", ""))).URL("file:" + __filename).href
  : document.currentScript && document.currentScript.src || new URL("main.js", document.baseURI).href;
exports.size = require("fs").readFileSync(new URL("image.wasm", import_meta_url)).length;
`);
    authority.kfs.writeFile(`${root}/node_modules/late/image.wasm`, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const code = [];
    const { supervisor, log } = facetSupervisor(authority, { reportRuntimeCode: async (entries) => { code.push(...entries); } });
    const program = `
require("fs").writeFileSync("./late-config.cjs", "module.exports = require('./node_modules/late/loader.cjs');");
import("./late-config.cjs").then((config) => {
  console.log("loaded " + config.default.size);
  require("http").createServer((req, res) => res.end("loaded " + config.default.size)).listen(5173);
}, (error) => console.error(error));
`;
    const { proc } = await launchResident({
      authority,
      cursor: authority.cursor(),
      env: { SUPERVISOR: supervisor },
      bundle: {},
      dataPlan: [],
      program: rewriteDynamicImports(program, `file:///${root}/main.js`),
    });
    await until(() => log.ports.has(5173) || log.exit !== null, 'the listener after the late package', 5000);
    assert.equal(log.exit, null, JSON.stringify({ stdout: log.stdout, stderr: log.stderr, exit: log.exit }));
    const response = await proc.fetch(new Request('http://facet/', { headers: { 'X-Nimbus-Port': '5173' } }));
    assert.equal(await response.text(), 'loaded 8');
    assert.equal(log.stdout, 'loaded 8\n');
    assert.equal(log.stderr, '');
  },

  // An image the process's store has no room for (lightningcss-wasm's 15.8 MB
  // lightningcss_node.wasm, under Tailwind under react-router's vite config)
  // is not read ahead, and the import() goes on: the read-ahead serves the
  // module's own read, which, made, is refused naming the file, as it would
  // have been without the import(). The read-ahead never fails the import().
  async lateImageTheStoreCannotHoldIsTheModulesOwnRead() {
    const root = 'home/user/app';
    const authority = createAuthority({ storageKernelReserve: 0 });
    authority.kfs.mkdir(`${root}/node_modules/late`, { recursive: true, mode: 0o755 });
    authority.kfs.writeFile(`${root}/node_modules/late/index.cjs`, `
exports.ready = "ready";
exports.load = () => require("fs").readFileSync(require("path").join(__dirname, "big.wasm")).length;
`);
    authority.kfs.writeFile(`${root}/node_modules/late/lazy.cjs`, 'module.exports = new URL("big.wasm", "file:" + __filename);\n');
    authority.kfs.writeFile(`${root}/node_modules/late/big.wasm`, new Uint8Array(4 * 1024 * 1024));
    // The session has no room past what it holds: no grant can be made.
    const raw = authority.rawVfs;
    raw.ledger = new StorageLedger(raw.sql, { limit: raw.databaseBytes() + 512 * 1024, kernelReserve: 0 });
    const FACET = 'proc-slot-0';
    raw.ledger.fill(FACET, 256 * 1024);
    const { supervisor, log } = facetSupervisor(authority, { reportRuntimeCode: async () => {} });
    const program = `
require("fs").writeFileSync("./late-config.cjs", "require('./node_modules/late/lazy.cjs'); module.exports = require('./node_modules/late/index.cjs');");
import("./late-config.cjs").then((config) => {
  console.log(config.default.ready);
  try { config.default.load(); } catch (error) { console.log(error.code); }
  require("http").createServer((req, res) => res.end("up")).listen(5173);
}, (error) => console.error(String(error)));
`;
    await launchResident({
      authority,
      sql: facetSql(),
      cursor: authority.cursor(),
      env: { SUPERVISOR: supervisor },
      bundle: {},
      dataPlan: [],
      startArgs: { storage: { facet: FACET, grant: 256 * 1024 } },
      program: rewriteDynamicImports(program, `file:///${root}/main.js`),
    });
    await until(() => log.ports.has(5173) || log.stderr !== '' || log.exit !== null, 'the listener after the late package', 10_000);
    assert.equal(log.stderr, '', 'the import() is not failed by its read-ahead');
    assert.equal(log.stdout, 'ready\nEAGAIN\n', "the module's own read is refused, naming the file");
  },
});
console.log('resident-late-wasm-prefetch: ok');
