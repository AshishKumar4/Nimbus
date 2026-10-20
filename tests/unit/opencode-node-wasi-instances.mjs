#!/usr/bin/env bun
// The real attached opencode module contains both the staged Node library and
// the bundled WASI host. Evaluate all of it, including the real OpenTUI/yoga
// reactors. Appended adapters boot its Node store and expose filesystem calls;
// the CLI itself is not run (no substitute opencode bundle is installed).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateOpencodeRunnerCode, SQLITE_WASM_MODULE_NAME, YOGA_WASM_MODULE_NAME } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';
import { OPENTUI_WASM_MODULE_NAME } from '../../packages/worker/src/runtime/opentui-facet-backend.ts';
import { OPENCODE_TREE_SITTER_WASMS, OPENCODE_YOGA_WASM, OPENCODE_ARTIFACT_ENTRY } from '../../packages/worker/src/opencode-artifact.generated.ts';
import { OPENTUI_WASM_ENTRY } from '../../packages/worker/src/opentui-wasm-artifact.generated.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { processInstanceSupervisor } from './lib/process-instance-supervisor.mjs';
import { WASI_INSTANCE_PROBE, startResidentWasi } from './lib/wasi-instance-probe.mjs';

const realProcess = globalThis.process;
const dir = mkdtempSync(join(tmpdir(), 'opencode-store-instances-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const nodeCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const wasiCred = { uid: 2000, gid: 2000, groups: [2000], umask: 0o077 };
const nodeSession = createAuthority();
const wasiSession = createAuthority();
nodeSession.kfs.writeFile('home/user/node-only.txt', 'Node bytes', { mode: 0o600 });
nodeSession.kfs.writeFile('home/user/shared.txt', 'Node secret', { mode: 0o600 });
const root = wasiSession.rawVfs.as(CRED_KERNEL);
root.writeFile('home/user/wasi-only.txt', 'WASI bytes', { mode: 0o600 });
root.chown('home/user/wasi-only.txt', 2000, 2000);
root.writeFile('home/user/shared.txt', 'WASI session secret', { mode: 0o600 });
root.chown('home/user/shared.txt', 1000, 1000);
const nodeProcess = processInstanceSupervisor(nodeSession, nodeCred);
const wasiProcess = processInstanceSupervisor(wasiSession, wasiCred);
const generated = generateOpencodeRunnerCode({
  argv: [], terminal: {}, cred: nodeCred, cwd: '/home/user', stdin: '', mode: 'attached',
  sources: nodeFacetSources(generateShimsCode()),
  vfsBundle: JSON.stringify({ 'home/user/node-only.txt': 'Node bytes', 'home/user/shared.txt': 'Node secret' }),
  vfsCursor: JSON.stringify(nodeSession.cursor()), vfsManifest: '{}', vfsMetadata: '{}',
});
// The opencode runner stages no ES modules of its own.
const modules = generatedModuleSet({ esModules: {}, ...generated }, 'runner.mjs');
modules['runner.mjs'] += WASI_INSTANCE_PROBE + `
export async function bootNodeForTest(supervisor) {
  __supervisor = globalThis.__nimbusAnsweringSupervisor(supervisor);
  const failure = await __ocBootStore();
  if (failure) throw new Error(failure);
  return {
    read: (path) => builtins.fs.readFileSync(path, "utf8"),
    exists: (path) => builtins.fs.existsSync(path),
    readable: (stat) => __resident.namespace.readable(stat),
    cursor: () => __resident.coherence.cursor(),
    stats: () => __resident.cells.stats(),
    observeRead: __resident.observeRead,
  };
}
`;
function externalModule(specifier, source) {
  const name = 'test-' + specifier.replace(/[^a-zA-Z0-9.-]/g, '-') + '.mjs';
  modules['runner.mjs'] = modules['runner.mjs'].replaceAll(`from "${specifier}"`, `from "${name}"`);
  modules[name] = source;
}
externalModule('cloudflare:workers', 'export class WorkerEntrypoint {}\nexport class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n');
// SQLite and tree-sitter are imported but never instantiated by this test.
externalModule(SQLITE_WASM_MODULE_NAME, 'export default {};');
for (const wasm of Object.values(OPENCODE_TREE_SITTER_WASMS)) externalModule(wasm, 'export default {};');
// These two ARE instantiated while the real attached module evaluates.
// Give the loader genuine compiled Modules, as the production module map does.
function wasmModule(asset) {
  const url = new URL('../../packages/worker/public/' + asset, import.meta.url);
  return `import { readFileSync } from "node:fs";\nexport default new WebAssembly.Module(readFileSync(new URL(${JSON.stringify(url.href)})));`;
}
externalModule(OPENTUI_WASM_MODULE_NAME, wasmModule(OPENTUI_WASM_ENTRY));
externalModule(YOGA_WASM_MODULE_NAME, wasmModule(OPENCODE_ARTIFACT_ENTRY.replace(/[^/]+$/, OPENCODE_YOGA_WASM)));
const file = writeModuleSet(dir, modules, 'runner.mjs');
const P = await import(file);
const decoder = new TextDecoder();

try {
  const node = await P.bootNodeForTest(nodeProcess.supervisor);
  assert.equal(node.read('/home/user/shared.txt'), 'Node secret');
  const nodeCursor = node.cursor();
  assert.deepEqual(nodeCursor, nodeSession.cursor());
  const nodeStats = node.stats();
  const guest = await startResidentWasi(P, wasiProcess.supervisor, wasiCred);
  assert.equal(guest.namespace.ready(), true, 'the bundled WASI host really started its resident store');
  assert.deepEqual(wasiProcess.acquireRequests[0], { epoch: null, rev: 0 });
  assert.equal(await guest.namespace.barrier(), true);
  assert.deepEqual(wasiProcess.acquireRequests.at(-1), wasiSession.cursor());
  assert.notEqual(wasiSession.cursor().epoch, nodeCursor.epoch);
  assert.deepEqual(node.cursor(), nodeCursor, 'WASI boot and acquire did not replace the Node cursor');

  assert.equal(decoder.decode(await guest.fs.readFile('home/user/wasi-only.txt')), 'WASI bytes');
  assert.equal(guest.namespace.entry('home/user/node-only.txt'), null);
  await assert.rejects(async () => guest.fs.readFile('home/user/shared.txt'), { code: 'EACCES' });
  assert.equal(guest.namespace.cred.uid, 2000);
  assert.equal(node.read('/home/user/shared.txt'), 'Node secret', 'Node retained its own readable bytes and credential');
  assert.equal(node.exists('/home/user/wasi-only.txt'), false);
  assert.equal(node.readable({ mode: 0o600, uid: 1000, gid: 1000 }), true);
  assert.equal(node.readable({ mode: 0o600, uid: 2000, gid: 2000 }), false);
  assert.deepEqual(node.stats(), nodeStats, 'WASI fills and reads do not alter Node store statistics');

  const wasiStats = P.__wasiFsStats();
  assert.ok(wasiStats.local > 0, 'the WASI read profiler recorded real resident reads');
  for (let i = 0; i < 3; i++) assert.equal(node.read('/home/user/node-only.txt'), 'Node bytes');
  assert.deepEqual(P.__wasiFsStats(), wasiStats, 'Node reads cannot increment the WASI read profiler');
  // This runner does not configure a Node observeRead profile. Starting WASI
  // must not install its profiler there; observer-to-observer isolation is
  // exercised separately by resident-library-instances.
  assert.equal(node.observeRead, null);
  assert.equal(await P.__wasiSettleWrites(), null);
} finally {
  await wasiProcess.close();
  await nodeProcess.close();
}
realProcess.stdout.write('opencode-node-wasi-instances: PASS\n');
realProcess.exit(0);
