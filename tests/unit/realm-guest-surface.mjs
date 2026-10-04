#!/usr/bin/env bun
// What a program run by the library host sees of the world: the same as a
// program run by hosted Nimbus (workerd), so one program behaves the same in
// both. Under Bun, a guest realm (a worker) also had the host engine's
// web-worker globals: `Worker` (a worker of the host engine's own),
// `prompt`/`alert`/`confirm` (they read the host process's own stdin) and
// `postMessage`/`onmessage` (the worker's channel to the host). workerd has
// none of them; nor, after the realm starts, does the guest. `Bun` itself
// cannot be removed from any Bun realm (non-configurable, ShadowRealm
// included), so it is a documented limit, not checked here.
//
// Run by bun, it checks the source under Bun, then runs itself under node
// against the built package (packages/core/dist: rebuild first).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';

const underBun = typeof process.versions.bun === 'string';
const { NimbusWorkspace } = await import(underBun
  ? '../../packages/core/src/workspace/nimbus-workspace.ts'
  : '../../packages/core/dist/workspace/nimbus-workspace.js');

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const run = async (command) => {
  const result = await ws.exec(command, { cwd: '/home/user' });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
};

const HOST_ONLY = ['Worker', 'prompt', 'alert', 'confirm', 'postMessage', 'onmessage'];
await ws.fs.writeFile('/home/user/surface.js', [
  `const names = ${JSON.stringify(HOST_ONLY)};`,
  // Through every way a program names its global object.
  'const globals = [globalThis, Function("return this")(), (0, eval)("this")];',
  'console.log(JSON.stringify(names.map((name) => [name, globals.map((g) => typeof g[name])])));',
].join('\n'));
const r = await run('node surface.js');
assert.equal(r.code, 0, r.err);
for (const [name, types] of JSON.parse(r.out)) {
  assert.deepEqual(types, ['undefined', 'undefined', 'undefined'], `a program sees no ${name}, as in hosted node`);
}

// The process a program sees is Nimbus's, not the host engine's.
const proc = await run(`node -e "console.log(globalThis.process === process, process.pid, typeof process.dlopen)"`);
assert.equal(proc.out, 'true 1 undefined\n', proc.err);

// The engine's own modules are not built-ins here either.
const required = await run(`node -e "try { require('bun:sqlite'); console.log('loaded') } catch (e) { console.log(e.code) }"`);
assert.equal(required.out, 'MODULE_NOT_FOUND\n', required.err);

// What a program does need is all still there.
const ordinary = await run(`node -e "console.log(typeof setImmediate, typeof Buffer, typeof process.nextTick, typeof fetch, typeof structuredClone)"`);
assert.equal(ordinary.out, 'function function function function function\n', ordinary.err);

await ws.close();

if (underBun) {
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - realm-guest-surface (no host engine namespace in a guest; under Bun and Node)');
} else {
  console.log('ok - under node');
}
