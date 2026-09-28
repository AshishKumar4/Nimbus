#!/usr/bin/env bun
// Hosted node's synchronous fs and require see an asynchronous mount (one
// with no `sync` face, as a remote Drive, container or device is), as its
// fs.promises does and as they see SQLite: the process's namespace is listed
// from its view of the namespace, mounts included where its launch names
// them, and a write lands in the mount (Kinu's ASK-mounts item 1).
//
// End to end through NimbusWorkspace with the mount made the way an embedder
// makes one, the real FacetManager launch, the generated one-shot runner and
// resident body with the real shims and store, and the session's real
// supervisor ops:
//   - Kinu's probe (mounts-ask/node-probe.js) answers on /m exactly as in the
//     SQLite home, on the first launch and the next;
//   - a script outside the mount reads, stats, lists and requires mounted
//     files by literal paths;
//   - a resident process reads a mounted project file synchronously and its
//     write lands in the mount;
//   - a launch that names nothing on a mount does not walk it, and a named
//     tree past MOUNT_LIST_NAME_LIMIT is not listed past it;
//   - a kept store never vouches for mounted bytes it held (they have no
//     revision to compare), so a relaunch reads what the mount holds now.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { MOUNT_LIST_NAME_LIMIT } from '../../packages/core/src/constants.ts';
import { createSupervisorBridgeStore, SUPERVISOR_OP_ROUTES } from '../../packages/core/src/workspace/supervisor-op.ts';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import * as rpc from '../../packages/worker/src/session/rpc.ts';
import { createFacetCtx, createFacetWorld, createProcessFacetCtx } from './facet-host-harness.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './session-supervisor-ops.mjs';
import { importModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { facetSql } from './lib/resident-body.mjs';

const dec = new TextDecoder();
const enc = new TextEncoder();

/** What reaches the mount: every call by name and path. */
const calls = [];
/** A remote backend's shape: every call awaits a timer turn, and there is no `sync` face. */
const remote = (vfs) => new Proxy(vfs, {
  get(target, key) {
    if (key === 'sync') return undefined;
    const value = target[key];
    if (typeof value !== 'function') return value;
    return async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      calls.push(`${String(key)} ${args[0]}`);
      return value.apply(target, args);
    };
  },
  has(target, key) { return key !== 'sync' && key in target; },
});

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const backing = new MemoryVFS({ uid: 1000, gid: 1000 });
ws.filesystem.vfs.mount('/m', remote(backing));

// The session's supervisor, over the workspace's own namespace.
const host = { sqliteFs: ws.vfs, processes: ws.processes, ensureSqliteFs() {}, getFilesystemAuthority: () => ws.filesystem };
const routed = Object.fromEntries(Object.values(SUPERVISOR_OP_ROUTES).map(({ method }) => {
  const handler = Reflect.get(rpc, method);
  return [method, (...args) => Reflect.apply(handler, undefined, [host, ...args])];
}));
attachSupervisorOps(host, buildSessionSupervisorOps(host, createSupervisorBridgeStore({ vfs: ws.vfs, processes: ws.processes, filesystem: ws.filesystem }), routed));

let out = '';
const supervisorFor = (pid) => new Proxy({}, {
  get(_target, name) {
    if (typeof name !== 'string' || name === 'then') return undefined;
    if (name === 'stdout' || name === 'stderr') return async (bytes) => { out += dec.decode(bytes); };
    if (name === 'reportExit' || name === 'registerPort' || name === 'unregisterPort') return async () => {};
    return (...args) => host.supervisorOp({ op: name, args, pid });
  },
});
adoptCtxExports({ SupervisorRPC: ({ props }) => supervisorFor(props?.pid) });

// The Worker Loader: a one-shot's runner is written out and imported; a
// resident's module map boots in a facet of its own SQLite.
const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-node-async-mount-'));
process.on('exit', () => rmSync(runnerDir, { recursive: true, force: true }));
let runnerN = 0;
let facetN = 0;
const world = createFacetWorld(async (config, info) => {
  const generated = await importModuleSet(config.modules, 'worker.js');
  return new generated.NimbusProcess(createProcessFacetCtx(`${info.facetName}-${++facetN}`), { SUPERVISOR: config.env.SUPERVISOR });
});
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
    get: (...args) => world.loader.get(...args),
  },
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)));
    },
  },
};
const manager = new FacetManager(createFacetCtx(world, 'node-async-mount'), env, ws.processes, new PortRegistry(), processHostFor, {});
manager.setVfs(ws.vfs, ws.filesystem);

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
/** `node <filename> ...argv` as the shell runs it: a one-shot, its output collected. */
async function node(code, { filename, cwd, argv = [] }) {
  out = '';
  let result;
  try {
    result = await manager.exec(code, { filename, dirname: filename.slice(0, filename.lastIndexOf('/')), cwd, argv: [filename, ...argv] });
  } finally { Object.assign(globalThis, real); }
  assert.equal(result.exitCode, 0, `${filename}: ${result.stderr}${out}`);
  return (result.stdout + out).trim();
}

// ── Kinu's probe: /m answers as the SQLite home does ────────────────────────
/** Kinu's mounts-ask/node-probe.js, verbatim. */
const PROBE = `const fs = require('fs'); const path = require('path');
const dir = __dirname;
const t = (label, f) => { try { console.log(label, JSON.stringify(f())); } catch (e) { console.log(label, 'THROW', e.code, String(e.message).slice(0, 160)); } };
t('readFileSync literal', () => fs.readFileSync(process.argv[2] + '/x.txt', 'utf8').trim());
t('readFileSync computed', () => fs.readFileSync(path.join(dir, 'x.txt'), 'utf8').trim());
t('existsSync', () => fs.existsSync(path.join(dir, 'x.txt')));
t('statSync', () => fs.statSync(path.join(dir, 'x.txt')).size);
t('readdirSync', () => fs.readdirSync(dir).sort().join(','));
t('writeFileSync', () => { fs.writeFileSync(path.join(dir, 'w.txt'), 'written'); return fs.readFileSync(path.join(dir, 'w.txt'), 'utf8'); });
t('require literal', () => require(process.argv[2] + '/lib/m0.js'));
t('require computed', () => { let s = 0; for (let i = 0; i < 3; i++) s += require('./lib/m' + i); return s; });
fs.promises.readFile(path.join(dir, 'x.txt'), 'utf8').then((v) => console.log('promises.readFile', JSON.stringify(v.trim())), (e) => console.log('promises.readFile THROW', e.code, e.message));
`;
async function probe(dir) {
  const made = await ws.exec(`mkdir -p ${dir}/lib && cd ${dir} && echo data > x.txt && for i in 0 1 2; do echo "module.exports=$i" > lib/m$i.js; done`);
  assert.equal(made.exitCode, 0, made.stderr);
  await ws.fs.writeFile(`${dir}/r.js`, PROBE);
  const launch = () => node(PROBE, { filename: `${dir}/r.js`, cwd: dir, argv: [dir] });
  return { first: await launch(), writes: calls.filter((call) => /^write\S* \/n\/w\.txt$/.test(call)).length, second: await launch() };
}
const home = await probe('/home/user/n');
assert.equal(home.first, [
  'readFileSync literal "data"', 'readFileSync computed "data"', 'existsSync true', 'statSync 5',
  'readdirSync "lib,r.js,x.txt"', 'writeFileSync "written"', 'require literal 0', 'require computed 3', 'promises.readFile "data"',
].join('\n'), 'the SQLite control');
const mounted = await probe('/m/n');
assert.equal(mounted.first, home.first, 'the first launch on /m answers every line as the home does');
assert.equal(mounted.second, home.second, 'and so does the next, which sees the file the first wrote');
assert.equal(mounted.writes, 1, 'the synchronous write reached the mount once');
assert.equal(dec.decode(await backing.readFile('/n/w.txt')), 'written', 'and it is in the mount');
assert.equal(ws.vfs.as(CRED_KERNEL).exists('m'), false, 'nothing was written to SQLite under the mount point');

// ── Literal paths from a script outside the mount ───────────────────────────
await ws.exec('mkdir -p /m/nl && echo data > /m/nl/x.txt && echo "module.exports = 7" > /m/nl/mod.js');
assert.equal(await node(`const fs = require('fs');
console.log('read', fs.readFileSync('/m/nl/x.txt', 'utf8').trim());
console.log('exists', fs.existsSync('/m/nl/x.txt'));
console.log('readdir', fs.readdirSync('/m/nl').sort().join(','));
console.log('require', require('/m/nl/mod.js'));`, { filename: '/home/user/lit.js', cwd: '/home/user' }),
'read data\nexists true\nreaddir mod.js,x.txt\nrequire 7', 'literal mounted paths in the code are in the launch\'s view');

// ── No false ENOENT: what the launch did not list is not known absent ───────
/** Each check's value, or its error code; `:mount` when it is the mount's refusal naming /m and the async form. */
const CHECK = `const fs = require('fs');
const code = (f) => { try { return f(); } catch (e) {
  return 'ERR:' + e.code + (e.code === 'EAGAIN' && /\\/m is an asynchronous mount; this caller cannot wait for it; fs\\.promises\\.\\w+ reads it/.test(e.message) ? ':mount' : '');
} };
const at = (...parts) => ['', ...parts].join('/');
`;
await ws.exec('mkdir -p /m/app && echo resident-data > /m/app/data.txt');
assert.deepEqual(JSON.parse(await node(`${CHECK}
(async () => console.log(JSON.stringify({
  stat: code(() => fs.statSync(at('m', 'app', 'data.txt')).size),
  statQuiet: code(() => fs.statSync(at('m', 'app', 'nope'), { throwIfNoEntry: false })),
  read: code(() => fs.readFileSync(at('m', 'app', 'data.txt'), 'utf8')),
  list: code(() => fs.readdirSync(at('m'))),
  exists: fs.existsSync(at('m', 'app', 'data.txt')),
  write: code(() => fs.writeFileSync(at('m', 'app', 'new.txt'), 'x')),
  require: code(() => require(at('m', 'nl', 'mod.js'))),
  live: (await fs.promises.readFile(at('m', 'app', 'data.txt'), 'utf8')).trim(),
})))();`, { filename: '/home/user/unlisted.js', cwd: '/home/user' })), {
  stat: 'ERR:EAGAIN:mount', statQuiet: 'ERR:EAGAIN:mount', read: 'ERR:EAGAIN:mount', list: 'ERR:EAGAIN:mount',
  exists: false, write: 'ERR:EAGAIN:mount', require: 'ERR:EAGAIN:mount', live: 'resident-data',
}, 'a mounted path the launch did not name is the mount\'s refusal, never ENOENT, and fs.promises reads it');
assert.deepEqual(JSON.parse(await node(`${CHECK}
console.log(JSON.stringify({
  stat: code(() => fs.statSync(process.argv[2] + '/nope')),
  statQuiet: code(() => fs.statSync(process.argv[2] + '/nope', { throwIfNoEntry: false })) ?? null,
  read: code(() => fs.readFileSync(process.argv[2] + '/nope')),
  require: (() => { try { return require(process.argv[2] + '/nope.js'); } catch (e) { return /^Cannot find module/.test(e.message) ? 'not found' : 'ERR:' + e.code; } })(),
  names: fs.readdirSync(process.argv[2]).sort(),
}));`, { filename: '/home/user/listed.js', cwd: '/home/user', argv: ['/m/n'] })), {
  stat: 'ERR:ENOENT', statQuiet: null, read: 'ERR:ENOENT', require: 'not found',
  names: ['lib', 'r.js', 'w.txt', 'x.txt'],
}, 'a missing name in a directory the launch listed is ENOENT');

// ── A resident process on the mount ─────────────────────────────────────────
await ws.exec('mkdir -p /m/app && echo resident-data > /m/app/data.txt');
{
  out = '';
  const code = `const fs = require('fs');
const text = fs.readFileSync(__dirname + '/data.txt', 'utf8').trim();
fs.writeFileSync(__dirname + '/out.txt', text.toUpperCase());
console.log('RESULT ' + JSON.stringify({ text, size: fs.statSync(__dirname + '/data.txt').size, names: fs.readdirSync(__dirname).sort() }));`;
  await ws.fs.writeFile('/m/app/main.js', code);
  let spawned;
  try { spawned = await manager.spawnNode(code, { command: 'node main.js', filename: '/m/app/main.js', cwd: '/m/app' }); }
  finally { Object.assign(globalThis, real); }
  if (spawned?.done) await spawned.done.catch(() => {});
  for (let i = 0; i < 200 && !out.includes('RESULT'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const line = out.split('\n').find((l) => l.startsWith('RESULT ')) ?? `RESULT ${JSON.stringify({ out })}`;
  assert.deepEqual(JSON.parse(line.slice(7)), { text: 'resident-data', size: 14, names: ['data.txt', 'main.js', 'out.txt'] },
    'a resident reads its mounted project synchronously');
  for (let i = 0; i < 200 && !(await backing.stat('/app/out.txt')); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(dec.decode(await backing.readFile('/app/out.txt')), 'RESIDENT-DATA', 'its write lands in the mount');
}

// ── Bounds: a mount is walked only where a launch names it, and only so far ──
calls.length = 0;
assert.equal(await node('console.log(6 * 7)', { filename: '/home/user/elsewhere.js', cwd: '/home/user' }), '42');
assert.deepEqual(calls.filter((call) => call.startsWith('readdir')), [], 'a launch that names nothing on the mount lists none of it');
{
  await backing.mkdir('/big');
  for (let d = 0; d < 3; d++) {
    await backing.mkdir(`/big/d${d}`);
    for (let f = 0; f < MOUNT_LIST_NAME_LIMIT / 2; f++) await backing.writeFile(`/big/d${d}/f${f}`, enc.encode('x'));
  }
  const { pid } = ws.processes.spawn('node big.js', [], '/m/big');
  ws.filesystem.nameLaunch({ pid, cred: ws.processes.cred(pid) }, () => ['/m/big']);
  const fs = ws.filesystem.bind({ pid, cred: ws.processes.cred(pid) });
  const entries = new Map();
  for (let after = null; ;) {
    const page = await fs.list(after);
    for (const entry of page.entries) if (entry.path.startsWith('m/big/')) entries.set(entry.path, entry);
    if (page.next === null) break;
    after = page.next;
  }
  const names = [...entries.keys()];
  assert.ok(names.length <= MOUNT_LIST_NAME_LIMIT, `a named tree lists at most MOUNT_LIST_NAME_LIMIT names (${names.length})`);
  assert.ok(names.includes('m/big/d0/f0'), 'breadth first, whole directories while they fit');
  assert.ok(!names.some((path) => path.startsWith('m/big/d2/')), 'a directory that does not fit is not listed in part');
  assert.equal(entries.get('m/big/d2')?.unlisted, '/m', 'and the listing says so, naming its mount');
  assert.equal(entries.get('m/big/d0')?.unlisted, undefined, 'a listed directory is not marked');
  await ws.filesystem.releaseProcess(pid);
  assert.deepEqual(JSON.parse(await node(`${CHECK}
console.log(JSON.stringify({
  listed: code(() => fs.statSync(process.argv[2] + '/d0/f0').size),
  listedMissing: code(() => fs.statSync(process.argv[2] + '/d0/nope')),
  past: code(() => fs.statSync(process.argv[2] + '/d2/f0').size),
  pastMissing: code(() => fs.statSync(process.argv[2] + '/d2/nope')),
  pastList: code(() => fs.readdirSync(process.argv[2] + '/d2').length),
}));`, { filename: '/home/user/big.js', cwd: '/home/user', argv: ['/m/big'] })), {
    listed: 1, listedMissing: 'ERR:ENOENT', past: 'ERR:EAGAIN:mount', pastMissing: 'ERR:EAGAIN:mount', pastList: 'ERR:EAGAIN:mount',
  }, 'past MOUNT_LIST_NAME_LIMIT a name is the mount\'s refusal, not ENOENT');
}

// ── A kept store holds mounted bytes it cannot date ─────────────────────────
{
  await ws.exec('mkdir -p /m/kept && echo old > /m/kept/data.txt');
  const { pid } = ws.processes.spawn('node main.js', [], '/m/kept', { longRunning: true });
  ws.filesystem.nameLaunch({ pid, cred: ws.processes.cred(pid) }, () => ['/m/kept']);
  const store = new Function(`${FACET_RESIDENT_STORE_SOURCE}
return { __residentBind, __residentAdoptModuleBundle, __residentSynchronizeFromSupervisor, __residentSetPlan, __residentGet };`)();
  store.__residentBind({ storage: { sql: facetSql() } });
  store.__residentSetPlan(['m/kept/data.txt']);
  store.__residentAdoptModuleBundle({}, { epoch: ws.vfs.epoch, rev: ws.vfs.revision() });
  const supervisor = supervisorFor(pid);
  await store.__residentSynchronizeFromSupervisor(supervisor);
  assert.equal(dec.decode(store.__residentGet('m/kept/data.txt')), 'old\n', 'the launch held the mounted file');
  await backing.writeFile('/kept/data.txt', enc.encode('new\n'));
  // A relaunch on the kept store reconciles it against a fresh listing.
  await store.__residentSynchronizeFromSupervisor(supervisor);
  assert.equal(dec.decode(store.__residentGet('m/kept/data.txt')), 'new\n', 'a relaunch reads what the mount holds now');
  await ws.filesystem.releaseProcess(pid);
}

await ws.close();
console.log('node-sync-fs-async-mount: hosted node\'s synchronous fs and require see an asynchronous mount, bounded where the launch names it');
