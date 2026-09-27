#!/usr/bin/env bun
// A one-shot `node script.js` sees the filesystem through the namespace, as a
// resident process does (CUTOVER §2.8, #13). It boots the same store,
// namespace and data-plan code, over its own heap (runOnce hosts no SQLite),
// against the session's real supervisor ops. So:
// - existsSync, statSync and readdirSync answer for any name its credential
//   can see, not only the names the launch staged, and a file it did not
//   stage reads asynchronously;
// - a peer's write between two runs (another process, the shell) is what
//   the next run sees;
// - a name under a directory the credential cannot search does not exist for
//   it.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { VFS_BUNDLE_MAX_BYTES } from '../../packages/core/src/constants.ts';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { writeModuleSet } from './lib/module-map-bundle.mjs';

const authority = createAuthority();
const { host, rawVfs, kfs } = authority;
const dec = new TextDecoder();

// SUPERVISOR as the session serves it: every op for the process's own pid
// through the session's supervisor-op handler. Output is collected per run.
let out = '';
adoptCtxExports({
  SupervisorRPC: ({ props }) => new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name === 'stdout' || name === 'stderr') return async (bytes) => { out += dec.decode(bytes); };
      if (name === 'reportExit') return async () => {};
      if (name === Symbol.dispose) return () => {};
      return (...args) => host.supervisorOp({ op: name, args, pid: props?.pid });
    },
  }),
});

// The Worker Loader stands in for workerd: the generated one-shot runner,
// written out and imported, running the real shims and store.
const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-one-shot-ns-'));
process.on('exit', () => rmSync(runnerDir, { recursive: true, force: true }));
let runnerN = 0;
let injectedStoreBudget = null;
const env = {
  LOADER: {
    load(config) {
      if (injectedStoreBudget !== null) {
        config = { ...config, modules: { ...config.modules } };
        config.modules['runner.js'] = config.modules['runner.js'].replace(/__residentBindInMemory\(\d+\)/, `__residentBindInMemory(${injectedStoreBudget})`);
      }
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
  createFacetCtx(createFacetWorld(() => ({})), 'one-shot-namespace'),
  env, host.processes, new PortRegistry(), processHostFor, {},
);
manager.setVfs(rawVfs, processFiles(rawVfs));

kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
kfs.mkdir('home/user/elsewhere', { recursive: true, mode: 0o755 });
kfs.writeFile('home/user/elsewhere/x.txt', 'one');
// A directory the session user may not search, holding a name.
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('home/user/closed', { recursive: true, mode: 0o700 });
root.writeFile('home/user/closed/secret.txt', 'hidden');

// Nothing here names the files the program asks about, so no launch stages
// them: what it learns about them comes from the namespace, and their bytes
// from an asynchronous read.
const PROGRAM = `
const fs = require('fs');
const where = ['', 'home', 'user', 'else' + 'where'].join('/');
(async () => {
  const report = {
    exists: fs.existsSync(where + '/x.txt'),
    size: fs.existsSync(where + '/x.txt') ? fs.statSync(where + '/x.txt').size : null,
    names: fs.readdirSync(where).sort(),
    bytes: await fs.promises.readFile(where + '/x.txt', 'utf8'),
    closed: fs.existsSync(['', 'home', 'user', 'closed', 'secret.txt'].join('/')),
  };
  console.log(JSON.stringify(report));
})();
`;
const OPTS = { filename: '/home/user/app/script.js', cwd: '/home/user/app' };

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
async function run() {
  out = '';
  const result = await manager.exec(PROGRAM, OPTS);
  globalThis.console = real.console;
  globalThis.process = real.process;
  globalThis.Buffer = real.Buffer;
  assert.equal(result.exitCode, 0, `the run failed: ${result.stderr}${out}`);
  const line = (out + result.stdout).trim().split('\n').at(-1);
  return JSON.parse(line);
}

const first = await run();
assert.deepEqual(first, { exists: true, size: 3, names: ['x.txt'], bytes: 'one', closed: false },
  'a one-shot sees every name its credential can see, and none it cannot');

// A peer's writes between two runs.
kfs.writeFile('home/user/elsewhere/x.txt', 'two!!');
kfs.writeFile('home/user/elsewhere/y.txt', 'y');
const second = await run();
assert.deepEqual(second, { exists: true, size: 5, names: ['x.txt', 'y.txt'], bytes: 'two!!', closed: false },
  'the next one-shot sees what a peer wrote between the runs');

// Runtime metadata growth seals the synchronous view, while an authoritative
// async read can still complete. There is no successful partial readdir.
kfs.mkdir('home/user/grow', { recursive: true });
kfs.chown('home/user/grow', 1000, 1000);
injectedStoreBudget = 16 * 1024;
out = '';
let growth;
try {
  growth = await manager.exec(`
    const fs = require('fs');
    (async () => {
      let refusal;
      for (let i = 0; i < 200; i++) {
        try { fs.mkdirSync('/home/user/grow/dir-' + i); }
        catch (error) { refusal = { code: error.code, message: error.message }; break; }
      }
      let sync;
      try { fs.readdirSync('/home/user/grow'); sync = 'partial-success'; }
      catch (error) { sync = error.code; }
      const live = await fs.promises.readFile('/home/user/elsewhere/x.txt', 'utf8');
      console.log(JSON.stringify({ refusal, sync, live }));
    })();`, { filename: '/home/user/app/grow.js', dirname: '/home/user/app', cwd: '/home/user/app', captureOutput: true });
} finally { Object.assign(globalThis, real); }
assert.equal(growth.exitCode, 0, growth.stderr + out);
const growthReport = JSON.parse((growth.stdout + out).trim().split('\n').at(-1));
assert.match(growthReport.refusal.message, /namespace.*budget|budget.*namespace/i);
assert.equal(growthReport.sync, 'EAGAIN');
assert.equal(growthReport.live, 'two!!', 'async read comes from the authority despite a sealed namespace cache');

// Drive actual one-shot boot with a deliberately small fixed heap allowance.
// Metadata alone exceeds it; user code must never see a partial namespace.
kfs.mkdir('home/user/many-names', { recursive: true });
for (let i = 0; i < 200; i++) kfs.writeFile(`home/user/many-names/file-${i}`, 'x');
injectedStoreBudget = 32 * 1024;
out = '';
let refused;
try {
  refused = await manager.exec('console.log("USER_CODE_MUST_NOT_START");', { filename: '/home/user/app/budget-check.js', cwd: '/home/user/app' });
} finally {
  globalThis.console = real.console;
  globalThis.process = real.process;
  globalThis.Buffer = real.Buffer;
}
assert.equal(refused.exitCode, 1, 'namespace over budget refuses launch');
assert.match(refused.stderr + out, /namespace.*budget|budget.*namespace/i);
assert.doesNotMatch(refused.stdout + out, /USER_CODE_MUST_NOT_START/);
injectedStoreBudget = null;
const afterRefusal = await run();
assert.deepEqual(afterRefusal, second, 'normal allowance restores a complete coherent namespace');

// A small source can do a large metadata walk before finding an oversized
// dependency. The refusal itself must cross turns, not strand its caller.
{
  let grants = 0;
  const walkOpts = { ...OPTS, dirname: '/home/user/app' };
  let beforeGrant;
  let grantFailure;
  const paced = new FacetManager(
    createFacetCtx(createFacetWorld(() => ({})), 'paced-static-refusal'),
    { ...env, NIMBUS_LAUNCH_CHUNK_BYTES: '4096' }, host.processes, new PortRegistry(), processHostFor,
    { requestLaunchTurn: () => {
      grants++;
      if (grantFailure) return Promise.reject(grantFailure);
      setTimeout(() => { beforeGrant?.(); void paced.pumpResidentLaunches(); }, 0);
    } },
  );
  paced.setVfs(rawVfs, processFiles(rawVfs));
  kfs.writeFile('home/user/app/oversized.json', new Uint8Array(VFS_BUNDLE_MAX_BYTES + 1));
  const prelude = Array.from({ length: 8 }, (_, n) => `try { require('absent-${n}'); } catch {}`).join('\n');
  const program = prelude + '\nrequire("./oversized.json");';
  assert.ok(program.length < 4096);
  out = '';
  let refusal;
  try { refusal = await paced.exec(program, walkOpts); }
  finally { Object.assign(globalThis, real); }
  assert.ok(grants >= 3, 'metadata work yields several real turns BEFORE returning the closure refusal');
  assert.equal(refusal.exitCode, 1);
  assert.match(refusal.stderr, /18\.0 MiB/);
  assert.match(refusal.stderr, /oversized\.json/);
  out = '';
  let alive;
  try { alive = await paced.exec('console.log(6 * 7)', walkOpts); }
  finally { Object.assign(globalThis, real); }
  assert.equal(alive.exitCode, 0, alive.stderr + out);
  assert.equal((alive.stdout + out).trim(), '42', 'the same session executes real user code after refusing the closure');
  kfs.unlink('home/user/app/oversized.json');

  kfs.writeFile('home/user/app/later.json', '{"answer":1}');
  beforeGrant = () => { beforeGrant = undefined; kfs.writeFile('home/user/app/later.json', '{"answer":42}'); };
  out = '';
  let changed;
  try { changed = await paced.exec(prelude + '\nconsole.log(require("./later.json").answer)', walkOpts); }
  finally { Object.assign(globalThis, real); }
  assert.equal(changed.exitCode, 0, changed.stderr + out);
  assert.equal((changed.stdout + out).trim(), '42', 'a dependency changed before its resumed read is current');

  beforeGrant = () => { beforeGrant = undefined; kfs.writeFile('home/user/app/later.json', new Uint8Array(VFS_BUNDLE_MAX_BYTES + 1)); };
  const grown = await paced.exec(prelude + '\nrequire("./later.json")', walkOpts);
  assert.equal(grown.exitCode, 1);
  assert.match(grown.stderr, /later\.json/);
  assert.match(grown.stderr, /18\.0 MiB/, 'the size gate uses the file after the intervening turn');
  kfs.unlink('home/user/app/later.json');

  root.mkdir('home/user/app/guarded', { mode: 0o755 });
  root.writeFile('home/user/app/guarded/secret.json', '"private"', { mode: 0o644 });
  beforeGrant = () => { beforeGrant = undefined; root.chmod('home/user/app/guarded', 0o700); };
  await assert.rejects(paced.exec(prelude + '\nrequire("./guarded/secret.json")', walkOpts), /EACCES|permission denied/i,
    'a resumed walk keeps its principal and observes revoked search permission');
  root.unlink('home/user/app/guarded/secret.json');
  root.rmdir('home/user/app/guarded');

  kfs.writeFile('home/user/app/recovery.json', '{"answer":56}');
  const controlledProgram = prelude + '\nconsole.log(require("./recovery.json").answer)';
  const revisionAtFailure = rawVfs.revision();
  grantFailure = new Error('the alarm turn could not be scheduled');
  await assert.rejects(paced.exec(controlledProgram, walkOpts), error => error === grantFailure);
  grantFailure = undefined;
  beforeGrant = () => {
    beforeGrant = undefined;
    const entry = paced.processes.getRunning().at(-1);
    assert.ok(entry);
    paced.processes.exit(entry.pid, 137);
  };
  await assert.rejects(paced.exec(controlledProgram, walkOpts), /cancelled while it was suspended/);
  assert.equal(rawVfs.revision(), revisionAtFailure, 'the recovery cannot evade a poisoned cache by changing filesystem revision');
  out = '';
  const beforeRecovery = grants;
  try { alive = await paced.exec(controlledProgram, walkOpts); }
  finally { Object.assign(globalThis, real); }
  assert.equal(alive.exitCode, 0, alive.stderr + out);
  assert.equal((alive.stdout + out).trim(), '56', 'failed or cancelled static walks release the session for the next command');
  assert.ok(grants > beforeRecovery, 'the same source/revision/principal rebuilds after failure instead of reusing a partial cache entry');
  kfs.unlink('home/user/app/recovery.json');
}

console.log('one-shot-node-namespace: a one-shot answers stat, exists and readdir from the namespace, and sees a peer\'s writes between runs');
