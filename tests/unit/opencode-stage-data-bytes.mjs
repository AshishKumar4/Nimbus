#!/usr/bin/env bun
// opencode's VFS snapshot holds the session's files as they are, and staging
// it compiles nothing.
//
// opencode is its own program (the staged artifact); the snapshot a launch
// hands it is data, read by its synchronous fs calls. It was gathered by the
// Node launch's module pipeline: an installed ES module staged only to run was
// carried as its CommonJS emit, so opencode read esbuild's output in place of
// the file, and every ES module or TypeScript file of the working tree went
// through the compiler for an emit that was never shipped. Red before: the
// transform service ran, and the installed module's cell was its emit.

import assert from 'node:assert/strict';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED, createAuthority } from './lib/resident-body.mjs';
import { oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { oxcTransforms } from './lib/oxc-engine.mjs';

const ROOT = 'home/user/proj';
const MODULE = "import { join } from 'node:path';\nexport const where = join('/a', 'b');\n";
// CommonJS whose import() a Node launch routes: its emit is not the file.
const LAZY = "module.exports = () => import('./lazy.mjs');\n";
const files = {
  'package.json': JSON.stringify({ name: 'proj', private: true, type: 'module', dependencies: { 'esm-pkg': '1.0.0', 'lazy-pkg': '1.0.0' } }),
  'index.ts': 'const answer: number = 42;\nexport default answer;\n',
  'main.js': "import { where } from 'esm-pkg';\nconsole.log(where);\n",
  'node_modules/esm-pkg/package.json': JSON.stringify({ name: 'esm-pkg', version: '1.0.0', type: 'module', main: './index.js' }),
  'node_modules/esm-pkg/index.js': MODULE,
  'node_modules/lazy-pkg/package.json': JSON.stringify({ name: 'lazy-pkg', version: '1.0.0', main: './index.cjs' }),
  'node_modules/lazy-pkg/index.cjs': LAZY,
  'node_modules/lazy-pkg/lazy.mjs': 'export default 1;\n',
};

const { host, rawVfs, kfs } = createAuthority();
for (const [rel, text] of Object.entries(files)) {
  const path = `${ROOT}/${rel}`;
  kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kfs.writeFile(path, text);
}
const fm = oneShotManager('opencode-stage-data-bytes', { host, rawVfs, loader: runnerLoader('opencode-stage-data-bytes') });
// The session's transform service, every call it is asked counted.
const transforms = [];
const service = new EsbuildService(undefined, oxcTransforms);
fm.setEsbuildService(new Proxy(service, {
  get(target, name) {
    const value = Reflect.get(target, name, target);
    if (typeof value !== 'function') return value;
    return (...args) => { transforms.push(String(name)); return Reflect.apply(value, target, args); };
  },
}));

const { stageSpec } = await fm._stageOpencodeFacet('opencode', { argv: ['run', 'hello'], env: {}, cwd: `/${ROOT}` }, 'oneshot');
const bundle = new Function(`return ${stageSpec.vfsBundle}`)();
const bytes = (cell) => (typeof cell === 'string' ? new TextEncoder().encode(cell) : cell);

assert.equal(bundle[`${ROOT}/index.ts`], files['index.ts'], 'the working tree is staged');
assert.equal(bundle[`${ROOT}/node_modules/esm-pkg/index.js`], MODULE, 'the installed ES module is staged');
assert.equal(bundle[`${ROOT}/node_modules/lazy-pkg/index.cjs`], LAZY,
  `the installed CommonJS module is staged as the file it is (the transform service was asked ${transforms.length} times)`);
for (const [path, cell] of Object.entries(bundle)) {
  assert.ok(Buffer.from(bytes(cell)).equals(Buffer.from(kfs.readFile(path))), `${path} is staged as its bytes, not ${JSON.stringify(cell).slice(0, 200)}`);
}
assert.deepEqual(transforms, [], 'staging opencode\'s snapshot compiled nothing');

// What the stage charges its admission is what it carries.
const data = await buildPrefetchBundle(processFiles(rawVfs).bind({ pid: 9, cred: CRED }), { cwd: `/${ROOT}`, entryCode: '', dataOnly: true });
const carried = Object.values(data.bundle).reduce((sum, cell) => sum + bytes(cell).byteLength, 0);
assert.equal(data.rawBytes, carried, 'the raw bytes charged are the bytes staged');

console.log(`opencode-stage-data-bytes: ${Object.keys(bundle).length} files staged as their bytes, nothing compiled`);
