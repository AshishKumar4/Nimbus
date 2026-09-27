#!/usr/bin/env bun
// A module cell written with ESM `import` syntax that assigns
// `module.exports` is lowered to CommonJS by esbuild's `format: 'cjs'`
// pass, and `require()` gets the object the source assigned. That is the
// lowering every ESM-shaped cell takes (transformEsmInBundle), including
// one that `export ... from` a sibling and one too large for esbuild.
//
// The metadata pass for ESM cells ran esbuild's ESM printer first. For a
// cell like this one that printer wraps the CommonJS body in `__commonJS`
// and exports it as `default`, so `require('mypkg')` answered
// `{ default: { hello } }` and `.hello` was undefined, printed with exit 0
// (require-resolution/multiline-import on staging, 2026-09-27).
//
// Drives a one-shot `node consume.js` through the real launch path: the
// module-map walk, the ESM→CJS transform, the facet's metadata rewrite and
// the shims' loader.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { writeModuleSet } from './lib/module-map-bundle.mjs';

const ROOT = '/home/user/cellx';
const files = {
  'node_modules/mypkg/package.json': JSON.stringify({ name: 'mypkg', type: 'module', main: './lib/index.js' }),
  'node_modules/mypkg/lib/x.js': "module.exports = { hello: 'LINE_COMMENT_OK' };\n",
  // The probe's shape: a multi-line import with a comment after the brace.
  'node_modules/mypkg/lib/index.js': "import { // c\n  hello,\n} from './x.js';\nmodule.exports = { hello };\n",
  // The same shape reading import.meta, so the metadata rewrite has work.
  'node_modules/metapkg/package.json': JSON.stringify({ name: 'metapkg', type: 'module', main: './index.js' }),
  'node_modules/metapkg/x.js': "module.exports = { hello: 'META_OK' };\n",
  'node_modules/metapkg/index.js': "import { hello } from './x.js';\nmodule.exports = { hello, url: import.meta.url };\n",
};
const SCRIPT = `
const m = require('mypkg');
const meta = require('metapkg');
console.log(JSON.stringify({ keys: Object.keys(m), hello: m.hello, metaKeys: Object.keys(meta).sort(), metaHello: meta.hello, url: meta.url }));
`;

const authority = createAuthority();
const { host, rawVfs, kfs } = authority;
const dec = new TextDecoder();
let out = '';
adoptCtxExports({
  SupervisorRPC: ({ props }) => new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name === 'stdout' || name === 'stderr') return async (bytes) => { out += dec.decode(bytes); };
      if (name === 'reportExit') return async () => {};
      return (...args) => host.supervisorOp({ op: name, args, pid: props?.pid });
    },
  }),
});
const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-esm-cell-module-exports-'));
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
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)));
    },
  },
};
const manager = new FacetManager(
  createFacetCtx(createFacetWorld(() => ({})), 'esm-cell-module-exports'),
  env, host.processes, new PortRegistry(), processHostFor, {},
);
manager.setVfs(rawVfs, processFiles(rawVfs));
// Native esbuild stands in for the wasm build the facet runs; the service's
// in-isolate path runs the same transform-then-rewrite.
const esbuild = new EsbuildService();
esbuild.ensureInit = async () => {};
esbuild._esbuild = await import('esbuild');
manager.setEsbuildService(esbuild);

for (const [rel, text] of Object.entries(files)) {
  const path = `${ROOT.slice(1)}/${rel}`;
  kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kfs.writeFile(path, text);
}
kfs.writeFile(`${ROOT.slice(1)}/consume.js`, SCRIPT);

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
const result = await manager.exec(SCRIPT, { filename: `${ROOT}/consume.js`, dirname: ROOT, cwd: ROOT, captureOutput: true });
globalThis.console = real.console;
globalThis.process = real.process;
globalThis.Buffer = real.Buffer;
assert.equal(result.exitCode, 0, `the run failed: ${result.stderr}${out}`);
const printed = (out + result.stdout).trim().split('\n').at(-1);
assert.ok(printed.startsWith('{'), `the program printed no report: ${result.stderr}${out}`);
assert.deepEqual(JSON.parse(printed), {
  keys: ['hello'],
  hello: 'LINE_COMMENT_OK',
  metaKeys: ['hello', 'url'],
  metaHello: 'META_OK',
  url: `file://${ROOT}/node_modules/metapkg/index.js`,
});

console.log('esm-cell-module-exports: an ESM-syntax cell\'s module.exports is what require() returns, with and without import.meta');
