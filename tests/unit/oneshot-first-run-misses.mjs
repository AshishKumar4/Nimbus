#!/usr/bin/env bun
// A one-shot's first run either has the bytes it reads synchronously or fails
// loudly, and whatever it missed reaches the next launch even when the run
// never ends on its own.
//
// Measured on a fresh create-react-router project (vite 8.3.4, rolldown
// 1.2.13): the relaunched CLI's config load reads every package's
// package.json synchronously to decide what to externalize. On a first run
// those manifests were not staged, the reads answered EAGAIN, vite took that
// as "not found" and bundled @react-router/dev, @tailwindcss/vite, babel and
// the rest into the config, and rolldown's memory reached 163.9 MiB in about
// a second: "Worker exceeded memory limit". The killed run reported none of
// its misses, so the second and third runs died the same way.
//
// Three behaviours, each driven through a real FacetManager and the real
// generated one-shot runner:
//
//   1. A refused read the program swallowed is still a failure, however the
//      program goes on: a later existsSync, or a later readFileSync that the
//      fault-in made succeed, does not undo what it already built on the
//      refusal.
//   2. A run the platform kills has already told the session what it missed:
//      its failure names those reads, and the next launch stages them.
//   3. Every installed package's manifest is readable synchronously on the
//      first run, nested installs and nested package.json files included, and
//      the copy a launch is handed is never older than the file.
//   4. A copy is never readable where the file is not: a manifest whose read
//      a chmod or a chown revoked is refused, though its bytes are unchanged.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { NpmCache } from '../../packages/worker/src/npm/cache.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { writeModuleSet } from './lib/module-map-bundle.mjs';
import { opSender, supervisorDouble } from './lib/supervisor-double.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

const authority = createAuthority();
const { host, kfs } = authority;
const dec = new TextDecoder();

// What the guest asked the session to read, by run: fsReadBatch's paths.
let batchReads = [];
// A killed process makes no more calls: every call it makes after its kill
// waits forever, as a call from an isolate that no longer exists never lands.
const dead = new Set();
adoptCtxExports({
  SupervisorRPC: ({ props }) => {
    const pid = props?.pid;
    const send = opSender((envelope) => host.supervisorOp({ ...envelope, pid }));
    return supervisorDouble(async (name, args) => {
      if (dead.has(pid)) return new Promise(() => {});
      if (name === 'stdout' || name === 'stderr' || name === 'reportExit') return;
      if (name === 'fsReadBatch') for (const request of args[0]) batchReads.push(String(request.path).replace(/^\/+/, ''));
      return send(name, args);
    });
  },
});

// The Worker Loader stands in for workerd: the generated runner is written out
// and imported. `globalThis.__nimbusTestKill()` is the platform ending the
// isolate under the program (its memory limit): the run rejects as workerd's
// does, and the process makes no further call.
const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-oneshot-first-run-'));
process.on('exit', () => rmSync(runnerDir, { recursive: true, force: true }));
let runnerN = 0;
const env = {
  LOADER: {
    load(config) {
      const file = writeModuleSet(join(runnerDir, `runner-${runnerN++}`), config.modules, 'runner.js');
      const loaded = import(pathToFileURL(file).href);
      return {
        getEntrypoint: () => ({
          async run(request, supervisor) {
            const pid = (await request.clone().json()).pid;
            const killed = new Promise((_, reject) => {
              globalThis.__nimbusTestKill = () => {
                dead.add(pid);
                reject(new Error('Worker exceeded memory limit.'));
              };
            });
            return Promise.race([(async () => (await loaded).default.fetch(request, { SUPERVISOR: supervisor }))(), killed]);
          },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      };
    },
    get() { throw new Error('a one-shot exec never takes the keyed loader path'); },
  },
  ASSETS: stagedAssets,
};

// The session database npm's installs record their lockfiles in.
const facetCtx = createFacetCtx(createFacetWorld(() => ({})), 'oneshot-first-run');
facetCtx.storage.sql = createSqliteVfsTestHarness().sql;
const npm = new NpmCache(facetCtx.storage.sql);
const manager = new FacetManager(facetCtx, env, host.processes, new PortRegistry(), processHostFor, {});
manager.setVfs(authority.rawVfs, processFiles(authority.rawVfs));
host.facetManager = manager;

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
async function run(program, cwd) {
  batchReads = [];
  // Each facet is its own isolate in production; here every run shares one
  // globalThis, so the ledgers one run leaves are not the next run's.
  delete globalThis.__nimbusVfsResidencyMisses;
  delete globalThis.__nimbusModuleMisses;
  try {
    return await manager.exec(program, { filename: `${cwd}/entry.js`, dirname: cwd, cwd, captureOutput: true });
  } finally {
    globalThis.console = real.console;
    globalThis.process = real.process;
    globalThis.Buffer = real.Buffer;
  }
}
const write = (path, text) => {
  kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kfs.writeFile(path, text);
};

// Data outside every rule a one-shot launch stages: only a miss can name it.
// The programs compute their paths, so no static reading of them finds one.
write('opt/data/conf.json', '{"answer":42}');
write('opt/data/big.bin', 'D'.repeat(4096));
kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });

const failures = [];
async function check(name, body) {
  try { await body(); console.log(`  ok   ${name}`); }
  catch (error) { failures.push(name); console.log(`  FAIL ${name}\n${String(error?.stack ?? error).split('\n').map((l) => `       ${l}`).join('\n')}`); }
}

// ── 1. A swallowed refusal is not undone by a later answer ──────────────────
await check('a refused read the program swallowed fails the run, though later calls on the path succeed', async () => {
  const PROGRAM = `
const fs = require('fs');
const target = ['', 'opt', 'data', 'conf' + '.json'].join('/');
let first = 'FALLBACK';
try { first = fs.readFileSync(target, 'utf8'); } catch {}
setTimeout(() => {
  const there = fs.existsSync(target);
  let second;
  try { second = fs.readFileSync(target, 'utf8'); } catch (error) { second = error.code; }
  console.log(JSON.stringify({ first, there, second }));
}, 50);
`;
  const result = await run(PROGRAM, '/home/user/app');
  const printed = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(printed.first, 'FALLBACK', `the premise: the first read was refused and swallowed: ${JSON.stringify(result)}`);
  assert.equal(printed.there, true, 'the premise: the path exists');
  assert.equal(printed.second, '{"answer":42}', 'the premise: the fault-in made a later read succeed');
  assert.notEqual(result.exitCode, 0, `the program built on a refused read and must not report success: ${JSON.stringify(result)}`);
  assert.ok(result.stderr.includes('/opt/data/conf.json'), `the failure names the file: ${JSON.stringify(result.stderr)}`);
});

// ── 2. A killed run has already reported what it missed ─────────────────────
await check('a run the platform kills names its refused reads, and the next launch stages them', async () => {
  const PROGRAM = `
const fs = require('fs');
const target = ['', 'opt', 'data', 'big' + '.bin'].join('/');
let body = null;
try { body = fs.readFileSync(target, 'utf8'); } catch {}
if (body === null) setTimeout(() => globalThis.__nimbusTestKill(), 50);
else console.log('bytes=' + body.length);
`;
  const killed = await run(PROGRAM, '/home/user/app');
  assert.notEqual(killed.exitCode, 0, `the premise: the run was killed: ${JSON.stringify(killed)}`);
  assert.ok(killed.stderr.includes('Worker exceeded memory limit'), `the premise: the platform's own error: ${JSON.stringify(killed.stderr)}`);
  assert.ok(
    killed.stderr.includes('/opt/data/big.bin'),
    `the killed run's failure names the read it was refused: ${JSON.stringify(killed.stderr)}`,
  );
  const second = await run(PROGRAM, '/home/user/app');
  assert.equal(second.stdout.trim(), 'bytes=4096', `the next launch stages what the killed run missed: ${JSON.stringify(second)}`);
  assert.equal(second.exitCode, 0, `and runs clean: ${JSON.stringify(second)}`);
});

// ── 3. Every installed package's manifest, on the first run ─────────────────
const PROJECT = 'home/user/proj';
const manifests = {
  [`${PROJECT}/package.json`]: { name: 'proj' },
  [`${PROJECT}/node_modules/alpha/package.json`]: { name: 'alpha', main: 'index.js' },
  [`${PROJECT}/node_modules/alpha/esm/package.json`]: { type: 'module' },
  [`${PROJECT}/node_modules/alpha/node_modules/gamma/package.json`]: { name: 'gamma' },
  [`${PROJECT}/node_modules/@scope/beta/package.json`]: { name: '@scope/beta' },
};
for (const [path, manifest] of Object.entries(manifests)) write(path, JSON.stringify(manifest));
write(`${PROJECT}/node_modules/alpha/index.js`, 'module.exports = 1;\n');
// What `npm install` records of what it put there.
const installed = (names) => npm.writeLockfile(`/${PROJECT}`, new Map(names.map((name) => [
  `node_modules/${name}`,
  { name, resolvedVer: '1.0.0', integrity: `sha512-${name}`, depsJson: '{}', hoistedPath: `/${PROJECT}/node_modules/${name}` },
])));
installed(['alpha', '@scope/beta', 'alpha/node_modules/gamma']);
// Reads the manifests the way a resolver does: names the program computes.
const MANIFEST_PROGRAM = `
const fs = require('fs');
const path = require('path');
const names = process.env.NAMES.split(',');
const out = {};
for (const name of names) out[name] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'node_modules', name, 'package.json'), 'utf8')).name ?? 'nested';
console.log(JSON.stringify(out));
`;
const runManifests = async (names, program = MANIFEST_PROGRAM) => {
  batchReads = [];
  delete globalThis.__nimbusVfsResidencyMisses;
  try {
    return await manager.exec(program, { filename: `/${PROJECT}/entry.js`, dirname: `/${PROJECT}`, cwd: `/${PROJECT}`, captureOutput: true, env: { NAMES: names.join(',') } });
  } finally {
    globalThis.console = real.console;
    globalThis.process = real.process;
    globalThis.Buffer = real.Buffer;
  }
};
const manifestReads = () => batchReads.filter((p) => p.endsWith('/package.json')).sort();

await check('every installed package.json reads synchronously on the first run', async () => {
  const first = await runManifests(['alpha', '@scope/beta', 'alpha/node_modules/gamma', 'alpha/esm']);
  assert.equal(first.exitCode, 0, `the first run reads every manifest: ${JSON.stringify(first)}`);
  assert.deepEqual(JSON.parse(first.stdout.trim()), { alpha: 'alpha', '@scope/beta': '@scope/beta', 'alpha/node_modules/gamma': 'gamma', 'alpha/esm': 'nested' });
  assert.deepEqual(manifestReads(), [], 'the manifests come with the launch, not one read each');
});

await check('a manifest changed or added outside an install is read as it is now, and only it is read again', async () => {
  write(`${PROJECT}/node_modules/alpha/package.json`, JSON.stringify({ name: 'alpha-v2', main: 'index.js' }));
  write(`${PROJECT}/node_modules/late/package.json`, JSON.stringify({ name: 'late' }));
  const second = await runManifests(['alpha', '@scope/beta', 'late']);
  assert.equal(second.exitCode, 0, `the second run reads every manifest: ${JSON.stringify(second)}`);
  assert.deepEqual(JSON.parse(second.stdout.trim()), { alpha: 'alpha-v2', '@scope/beta': '@scope/beta', late: 'late' }, 'never an older copy');
  assert.deepEqual(
    manifestReads(), [`${PROJECT}/node_modules/alpha/package.json`, `${PROJECT}/node_modules/late/package.json`],
    'the unchanged manifests come from what the first launch read; the changed and the new one are read',
  );
});

await check('an install rereads the manifests once', async () => {
  installed(['alpha', '@scope/beta', 'alpha/node_modules/gamma', 'late']);
  const third = await runManifests(['alpha', '@scope/beta', 'late']);
  assert.equal(third.exitCode, 0, `the third run reads every manifest: ${JSON.stringify(third)}`);
  assert.deepEqual(JSON.parse(third.stdout.trim()), { alpha: 'alpha-v2', '@scope/beta': '@scope/beta', late: 'late' });
  assert.deepEqual(manifestReads(), [], 'every manifest comes with the launch again');
});

// ── 4. A manifest whose read was revoked is refused, copies or not ──────────
// The copies are kept against the install revision and held where the
// listing shows the same content key; a chmod or a chown changes neither.
// Equal bytes say nothing about who may read them.
const REVOKED_PROGRAM = `
const fs = require('fs');
const path = require('path');
const out = {};
for (const name of process.env.NAMES.split(',')) {
  const file = path.join(process.cwd(), 'node_modules', name, 'package.json');
  try { out[name] = JSON.parse(fs.readFileSync(file, 'utf8')).name; } catch (error) { out[name] = error.code; }
  try { fs.closeSync(fs.openSync(file, 'r')); } catch (error) { out[name + ' open'] = error.code; }
}
console.log(JSON.stringify(out));
`;
// Each case gives the read back when it ends: a manifest still revoked is
// (rightly) asked of the session by every later launch.
const revoked = async (name, revoke, restore) => {
  const path = `${PROJECT}/node_modules/${name}/package.json`;
  revoke(path);
  try { await revokedRun(name); } finally { restore(path); }
};
const revokedRun = async (name) => {
  const result = await runManifests(['alpha', name], REVOKED_PROGRAM);
  assert.equal(result.exitCode, 0, `the program handles the refusal itself: ${JSON.stringify(result)}`);
  assert.deepEqual(
    JSON.parse(result.stdout.trim()), { alpha: 'alpha-v2', [name]: 'EACCES', [`${name} open`]: 'EACCES' },
    'readFileSync and openSync are refused, as the session refuses the read',
  );
  assert.deepEqual(
    manifestReads(), [`${PROJECT}/node_modules/${name}/package.json`],
    'the copies are warm (alpha comes with the launch), and the revoked manifest is not held from them: the session is asked, and refuses it',
  );
};

await check('a manifest whose read a chmod revoked is refused, though the copies hold it', () =>
  revoked('@scope/beta', (path) => kfs.chmod(path, 0o000), (path) => kfs.chmod(path, 0o644)));

await check('a manifest whose read a chown revoked is refused, though the copies hold it', () =>
  revoked('alpha/node_modules/gamma', (path) => {
    kfs.chmod(path, 0o600);
    authority.rawVfs.as(CRED_KERNEL).chown(path, 0, 0);
  }, (path) => {
    authority.rawVfs.as(CRED_KERNEL).chown(path, 1000, 1000);
    kfs.chmod(path, 0o644);
  }));

await check('a manifest whose read is given back comes from the copies again', async () => {
  const result = await runManifests(['alpha', '@scope/beta', 'alpha/node_modules/gamma']);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.stdout.trim()), { alpha: 'alpha-v2', '@scope/beta': '@scope/beta', 'alpha/node_modules/gamma': 'gamma' });
  assert.deepEqual(manifestReads(), [], 'every manifest comes with the launch');
});

if (failures.length > 0) {
  console.log(`oneshot-first-run-misses: ${failures.length} failed`);
  process.exit(1);
}
console.log('oneshot-first-run-misses: all tests passed');
process.exit(0);
