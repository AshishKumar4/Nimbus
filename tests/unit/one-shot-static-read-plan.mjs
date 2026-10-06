#!/usr/bin/env bun
// A one-shot holds what its closure reads synchronously by a path its code
// spells out, whatever its size, beside its module map.
//
// `vite build` is a one-shot. Vite 8 imports lightningcss (lightningcss-wasm),
// whose wasm-node.mjs reads its 15.8 MB image with
// readFileSync(new URL('lightningcss_node.wasm', import.meta.url)). A resident
// process holds such a read through its data plan's `static` rule; a one-shot
// had no data plan, the module map's bound left no room for the image, and
// every build failed on the read. The one-shot's data plan is now its
// closure's static synchronous reads, which the store fetches at boot.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { writeModuleSet } from './lib/module-map-bundle.mjs';
import { supervisorDouble } from './lib/supervisor-double.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

const { host, rawVfs, kfs } = createAuthority();
const dec = new TextDecoder();

let out = '';
adoptCtxExports({
  SupervisorRPC: ({ props }) => supervisorDouble(async (name, args) => {
    if (name === 'stdout' || name === 'stderr') { out += dec.decode(args[0]); return; }
    if (name === 'reportExit') return;
    return host.supervisorOp({ op: name, args, pid: props?.pid });
  }),
});

// The Worker Loader stands in for workerd: the generated one-shot runner,
// written out and imported, running the real shims and store.
const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-one-shot-static-'));
process.on('exit', () => rmSync(runnerDir, { recursive: true, force: true }));
let runnerN = 0;
const env = {
  LOADER: {
    load(config) {
      const file = writeModuleSet(join(runnerDir, `runner-${runnerN++}`), config.modules, 'runner.js');
      const loaded = import(pathToFileURL(file).href);
      const supervisor = config.env?.SUPERVISOR;
      return {
        getEntrypoint: () => ({
          async fetch(request) { return (await loaded).default.fetch(request, { SUPERVISOR: supervisor }); },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      };
    },
    get() { throw new Error('a one-shot exec never takes the keyed loader path'); },
  },
  ASSETS: stagedAssets,
};

const manager = new FacetManager(
  createFacetCtx(createFacetWorld(() => ({})), 'one-shot-static-read-plan'),
  env, host.processes, new PortRegistry(), processHostFor, {},
);
manager.setVfs(rawVfs, processFiles(rawVfs));

// An image larger than anything a guess stages (the project snapshot's 2 MiB
// per file), read by the package's own code by a path it spells out.
const IMAGE = new Uint8Array(3 * 1024 * 1024);
for (let i = 0; i < IMAGE.length; i += 4096) IMAGE[i] = (i / 4096) & 0xff;
const PKG = 'home/user/app/node_modules/codec';
kfs.mkdir(PKG, { recursive: true, mode: 0o755 });
kfs.writeFile(`${PKG}/package.json`, JSON.stringify({ name: 'codec', version: '1.0.0', main: 'index.js' }));
kfs.writeFile(`${PKG}/index.js`, [
  "const fs = require('fs');",
  "const path = require('path');",
  "const bytes = fs.readFileSync(path.join(__dirname, 'codec_image.bin'));",
  'module.exports = { length: bytes.length, at: bytes[4096 * 7] };',
].join('\n'));
kfs.writeFile(`${PKG}/codec_image.bin`, IMAGE);

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
out = '';
let result;
try {
  result = await manager.exec("console.log(JSON.stringify(require('codec')));", {
    filename: '/home/user/app/build.js', dirname: '/home/user/app', cwd: '/home/user/app', captureOutput: true,
  });
} finally { Object.assign(globalThis, real); }
assert.equal(result.exitCode, 0, `the run failed: ${result.stderr}${out}`);
assert.deepEqual(JSON.parse((result.stdout + out).trim().split('\n').at(-1)), { length: IMAGE.length, at: 7 },
  "a one-shot reads its closure's statically named file, whatever its size, on its first run");

console.log('one-shot-static-read-plan: ok');
