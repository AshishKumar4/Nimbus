#!/usr/bin/env bun
// A resident node process holds, from its first instruction, the contents
// its launch's data plan names (facets/data-plan.ts) — not the whole
// filesystem — and names everything else exactly.
//
// End to end through the real FacetManager launch, the real generated facet
// body and shims, a real SqliteVFS and the real supervisor RPC entry points:
//   - a 25 MiB file in the project tree (project rule; chunked fill, past the
//     module map's cap) and a project directory of 300 files (the fill's path
//     bound) read synchronously;
//   - a package module that reads its own `templates/entry.js` as text through
//     `readFileSync(path.join(__dirname, ...))` — a code file no rule holds,
//     found only by static analysis of the closure (static-fs-refs.ts);
//   - a file outside every rule is not held: its synchronous read is the
//     honest EAGAIN naming it, while stat and readdir still answer exactly;
//   - a file outside every rule, past the module map's byte cap, that the
//     program reads with `readFileSync` by its exact literal path is held
//     whole: static analysis names it as a synchronous read, which no size can
//     make optional (sync-fs/first-sync-read-untouched on real infrastructure).
//
// The control arm disables the fill (the namespace is still listed): the
// planned reads the module map does not carry must then fail, so they cannot
// be coming from it.

import assert from 'node:assert/strict';

// The facet body replaces console and process in this realm when it boots.
const say = process.stdout.write.bind(process.stdout);
import { readFileSync } from 'node:fs';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { VFS_BUNDLE_MAX_BYTES } from '../../packages/core/src/constants.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { createFacetWorld, createFacetCtx, createProcessFacetCtx } from './facet-host-harness.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './session-supervisor-ops.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { _rpcFsList, _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import { processFiles } from './lib/process-bridge.mjs';
import { NpmCache } from '../../packages/worker/src/npm/cache.ts';
import { importModuleSet } from './lib/module-map-bundle.mjs';

const PROJECT = '/home/user/proj';
/** A project file past the bundle's byte cap and the single-value ceiling: chunked. */
const BIG = PROJECT + '/big.txt';
const BIG_BODY = 'N'.repeat(25 * 1024 * 1024);
/** Outside every rule: not the project, not a package, not $HOME's dot entries. */
const OUTSIDE = '/opt/appdata/locale/deep/never-required.json';
const OUTSIDE_BODY = JSON.stringify({ never: 'required' });
/**
 * Outside every rule, read synchronously by this exact literal path, and past
 * the module map's byte cap, so the module map cannot be what holds it.
 */
const EXACT = '/opt/appdata/exact/named.dat';
const EXACT_BODY = 'E'.repeat(VFS_BUNDLE_MAX_BYTES + 5);

const harness = createSqliteVfsTestHarness();
const sessionVfs = new SqliteVFS(harness.sql, harness.ctx);

const kfs = sessionVfs.as(CRED_KERNEL);
kfs.mkdir('opt/appdata/exact', { recursive: true, mode: 0o755 });
kfs.writeFile(EXACT.slice(1), EXACT_BODY, { mode: 0o644 });
kfs.mkdir('home/user/proj/many', { recursive: true, mode: 0o755 });
kfs.writeFile(BIG.slice(1), BIG_BODY, { mode: 0o644 });
kfs.mkdir('opt/appdata/locale/deep', { recursive: true, mode: 0o755 });
kfs.writeFile(OUTSIDE.slice(1), OUTSIDE_BODY, { mode: 0o644 });

/**
 * More files than FS_READ_BATCH_PATH_LIMIT (128), so the fill's PATH bound
 * binds before its byte bound; a violation is rejected by the real zod schema.
 */
const SMALL_FILE_COUNT = 300;
for (let i = 0; i < SMALL_FILE_COUNT; i++) {
  kfs.writeFile(`home/user/proj/many/f${i}.txt`, `small-${i}`, { mode: 0o644 });
}

/** A package that reads a code file of its own as text, by a foldable path. */
kfs.mkdir('home/user/proj/node_modules/tablepkg/templates', { recursive: true, mode: 0o755 });
kfs.writeFile('home/user/proj/node_modules/tablepkg/package.json', JSON.stringify({ name: 'tablepkg', main: 'index.js' }));
kfs.writeFile(
  'home/user/proj/node_modules/tablepkg/index.js',
  "const fs = require('fs'); const path = require('path');\n"
    + "module.exports = () => fs.readFileSync(path.join(__dirname, 'templates', 'entry.js'), 'utf8');\n",
);
kfs.writeFile('home/user/proj/node_modules/tablepkg/templates/entry.js', 'export const TEMPLATE = 1;\n');
/** Read as text by a path computed at run time: no rule and no static reference holds it. */
kfs.mkdir('home/user/proj/node_modules/tablepkg/private', { recursive: true, mode: 0o755 });
kfs.writeFile('home/user/proj/node_modules/tablepkg/private/late.js', 'late-bytes');
const LATE = 'home/user/proj/node_modules/tablepkg/private/late.js';

/**
 * The supervisor the facet talks to.
 *
 * `fsList` and `fsReadBatch` are the REAL RPC entry points, not stand-ins.
 * That is deliberate and it is what this test learned the hard way: a
 * hand-written stub answered `{ content }` for unlimited paths with no
 * offset or length, while `_rpcFsReadBatch` answers `{ bytes }` for at most
 * FS_READ_BATCH_PATH_LIMIT ranges totalling FS_READ_BATCH_REQUEST_BYTES, with
 * both fields required and zod rejecting the whole call otherwise. A filler
 * that passed against the stub could not issue a single valid call against the
 * supervisor. Binding the proof to the real functions makes that class of
 * drift impossible rather than merely noticed.
 */
let fsReadBatchCalls = 0;
let fsListCalls = 0;
let allowFill = true;
const stdoutChunks = [];

const rpcHost = attachSupervisorOps({
  sqliteFs: sessionVfs,
  processes: new SessionProcessSupervisor(),
  ensureSqliteFs() {},
});

function makeSupervisor(props) {
  return {
    props,
    /**
     * Enumerate the filesystem. The store cannot get this from the module map
     * — measured: a facet is shipped metadata for the bundle plus ancestor
     * directories, not a file list — so it is a supervisor call.
     */
    async fsList(after, limit) {
      fsListCalls++;
      // The control arm still lists: no launch runs user code before its
      // namespace answers. Only the content fill is disabled.
      return _rpcFsList(rpcHost, after ?? null, limit ?? null);
    },
    async fsReadBatch(requests) {
      fsReadBatchCalls++;
      if (!allowFill) throw new Error('probe: fill disabled for the control arm');
      return _rpcFsReadBatch(rpcHost, requests);
    },
    async readFile(path) {
      return sessionVfs.as(CRED_KERNEL).readFile(String(path).replace(/^\/+/, ''), 'utf8');
    },
    async writeFile() {},
    async registerPort() {},
    async unregisterPort() {},
    // Process output crosses this RPC as bytes; the test reads it as text.
    async stdout(s) { stdoutChunks.push(new TextDecoder().decode(s)); },
    async stderr(s) { stdoutChunks.push(new TextDecoder().decode(s)); },
    async reportExit() {},
  };
}

adoptCtxExports({ SupervisorRPC: ({ props }) => makeSupervisor(props) });

let facetSeq = 0;
const world = createFacetWorld(async (config, info) => {
  const generated = await importModuleSet(config.modules, 'worker.js');
  return new generated.NimbusProcess(
    createProcessFacetCtx(`${info.facetName}-${++facetSeq}`),
    { SUPERVISOR: config.env.SUPERVISOR },
  );
});

/** A shared read profile (R2, in memory): what one session misses, the next holds. */
const profiles = new Map();
const profileBucket = {
  async get(key) { return profiles.has(key) ? { text: async () => profiles.get(key) } : null; },
  async put(key, value) { profiles.set(key, value); },
  async list({ prefix }) {
    return { objects: [...profiles.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
  },
};
/** A session's npm lockfile: the integrity tablepkg was installed from. */
// A session writes to profiles as the principal the router put in its Durable
// Object name (`<tenant>:<subject>:<sid>`), never as the session.
function sessionCtx(name, principal) {
  const ctx = createFacetCtx(world, name);
  ctx.id = { toString: () => name, name: `${principal}:${name}` };
  const npm = createSqliteVfsTestHarness();
  ctx.storage.sql = npm.sql;
  new NpmCache(npm.sql).writeLockfile('/home/user/proj', new Map([['tablepkg', {
    name: 'tablepkg', resolvedVer: '1.0.0', integrity: 'sha512-dGFibGVwa2c=', depsJson: '{}',
    hoistedPath: '/home/user/proj/node_modules/tablepkg',
  }]]));
  return ctx;
}

const env = {
  NPM_TARBALL_CACHE: profileBucket,
  LOADER: world.loader,
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(
        readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
        { status: 200 },
      );
    },
  },
};

let sessionCtxNow;
function session(name, principal = 'acme:alice') {
  sessionCtxNow = sessionCtx(name, principal);
  const m = new FacetManager(sessionCtxNow, env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {});
  m.setVfs(sessionVfs, processFiles(sessionVfs));
  delete globalThis.__portRegistry;
  return m;
}
let manager = session('first-sync-read-session');

/** A real node program: every read below is its first contact with the file. */
const program = (readOutside) => `
const fs = require('fs');
// Computed at run time, so nothing before launch can name it.
const outside = ${JSON.stringify(OUTSIDE.split('/'))}.join('/');
const out = [];
const t = (label, f) => {
  try { out.push(label + '=' + f()); }
  catch (e) {
    out.push(label + '=ERR:' + (e && e.code) + (e && e.code === 'EAGAIN' && String(e.message).includes(outside) ? ':named' : ''));
  }
};
t('big', () => { const b = fs.readFileSync(${JSON.stringify(BIG)}, 'utf8'); return b.length + ':' + b.slice(0, 4); });
t('small', () => fs.readFileSync(${JSON.stringify(PROJECT + '/many/f287.txt')}, 'utf8'));
t('static', () => require('tablepkg')().trim());
(async () => {
  t('late', () => fs.readFileSync(['', 'home', 'user', 'proj', 'node_modules', 'tablepkg', 'private', 'late.js'].join('/'), 'utf8'));
if (${readOutside}) {
    t('outside', () => fs.readFileSync(outside, 'utf8'));
    t('exact', () => { const b = fs.readFileSync(${JSON.stringify(EXACT)}, 'utf8'); return b.length + ':' + b.slice(0, 4); });
    t('outsideStat', () => fs.statSync(outside).size);
    t('outsideList', () => fs.readdirSync(outside.slice(0, outside.lastIndexOf('/'))).join(','));
    // The remedy the miss names: the async form reads the live filesystem.
    const live = await fs.promises.readFile(outside, 'utf8');
    out.push('outsideAsync=' + live.length);
  }
  console.log('RESULT ' + JSON.stringify(Object.fromEntries(out.map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))));
})();
`;

/**
 * Spawn it as a RESIDENT process. That is the substrate the store lives on: a
 * resident process is a DO facet and has its own SQLite, while the one-shot
 * `exec` path runs in a stateless loaded worker that has none.
 */
let spawnSeq = 0;
async function run(readOutside) {
  stdoutChunks.length = 0;
  // The program is a file in the session, as `node reader.js` runs one.
  const code = program(readOutside);
  const filename = `${PROJECT}/reader${++spawnSeq}.js`;
  kfs.writeFile(filename.slice(1), code, { mode: 0o644 });
  // A launch that never settles must fail here, not let the event loop drain.
  let timer;
  const spawned = await Promise.race([
    manager.spawnNode(code, {
      command: `node reader${spawnSeq}.js`,
      filename,
      cwd: PROJECT,
    }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the launch never settled')), 60_000); }),
  ]).finally(() => clearTimeout(timer));
  if (spawned?.done) { try { await spawned.done; } catch { /* the program's own exit */ } }
  for (let i = 0; i < 40 && !stdoutChunks.join('').includes('RESULT'); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const line = stdoutChunks.join('').split('\n').find((l) => l.startsWith('RESULT ')) ?? 'RESULT {}';
  return { ...JSON.parse(line.slice('RESULT '.length)), pid: spawned.pid };
}

// ── Arm 1 (control): with the fill disabled, every planned read must FAIL ────
allowFill = false;
// It does not touch the outside file: a miss is repaired into the store, and
// the next launch's store would hold it.
const control = await run(false);
assert.match(control.big ?? '', /^ERR:/, `control: the big project file came from somewhere else: ${JSON.stringify(control)}`);
assert.match(control.static ?? '', /^ERR:/, `control: the statically named file came from somewhere else: ${JSON.stringify(control)}`);

// ── Arm 2: with the plan filled ─────────────────────────────────────────────
allowFill = true;
const filled = await run(true);
assert.equal(filled.big, `${BIG_BODY.length}:NNNN`, `a planned project file is held whole: ${JSON.stringify(filled)}`);
assert.equal(filled.small, 'small-287', `the fill packs under the path bound: ${JSON.stringify(filled)}`);
assert.equal(filled.static, 'export const TEMPLATE = 1;', `static analysis holds a code file read as text: ${JSON.stringify(filled)}`);
assert.equal(filled.outside, 'ERR:EAGAIN:named', `an unplanned file is the honest miss, by name: ${JSON.stringify(filled)}`);
assert.equal(filled.exact, `${EXACT_BODY.length}:EEEE`, `an exact synchronous read past the package-data size is held whole: ${JSON.stringify(filled)}`);
assert.equal(filled.outsideStat, String(OUTSIDE_BODY.length), 'the namespace still stats it exactly');
assert.equal(filled.outsideList, 'never-required.json', 'and lists it');
assert.equal(filled.outsideAsync, String(OUTSIDE_BODY.length), 'and the async read the miss names returns it');
assert.ok(fsListCalls > 0, 'the store asked the authority what exists');
assert.ok(fsReadBatchCalls > 0, 'the store was filled over the supervisor');

// ── Arm 3: a miss is learned for the package, across sessions ───────────────
// The run above missed late.js. What its exit files is only what this session
// served the process after the miss (the supervisor's own evidence), under
// the package's installed integrity, and it is shared once a second session
// has observed it too; then a third session launching the same tarball holds
// the file from boot.
assert.equal(filled.late, 'ERR:EAGAIN', `a runtime-computed package read is a first miss: ${JSON.stringify(filled)}`);
const served = new Set([LATE]);
const entriesOf = () => JSON.parse([...profiles.values()][0]).entries;
// A program's word alone files nothing.
manager.noteProcessReportedExit(filled.pid, 1, [LATE], { served: new Set(), profileUnread: [] });
await Promise.all(sessionCtxNow.waited);
assert.equal(profiles.size, 0, 'a miss the supervisor never served is not evidence');
manager.noteProcessReportedExit(filled.pid, 1, [LATE], { served, profileUnread: [] });
await Promise.all(sessionCtxNow.waited);
assert.equal(profiles.size, 1, 'the served miss was filed under the package');
assert.ok(![...profiles.values()][0].includes('home/user'), 'package-relative');
assert.equal(entriesOf()['private/late.js'].seen.length, 1);
const nextSession = (name, principal) => {
  // Another session over the same files: its pids start again at 1.
  for (let pid = 1; pid <= spawnSeq; pid++) sessionVfs.revokeAppendWriters(pid);
  manager = session(name, principal);
};
// Another session of the same principal is no second observer: session ids
// are free to mint. Nor is an anonymous one, which never writes.
for (const [name, principal] of [['alice-again', 'acme:alice'], ['anonymous', 'anon:anon'], ['legacy', 'legacy:public:_']]) {
  nextSession(name, principal);
  const again = await run(false);
  manager.noteProcessReportedExit(again.pid, 1, [LATE], { served, profileUnread: [] });
  await Promise.all(sessionCtxNow.waited);
  assert.equal(entriesOf()['private/late.js'].seen.length, 1, `${name}: not a second observer`);
}
nextSession('second-session', 'globex:bob');
const second = await run(false);
assert.equal(second.late, 'ERR:EAGAIN', `one session's observation is not shared: ${JSON.stringify(second)}`);
manager.noteProcessReportedExit(second.pid, 1, [LATE], { served, profileUnread: [] });
await Promise.all(sessionCtxNow.waited);
assert.equal(entriesOf()['private/late.js'].seen.length, 2, 'a second session observed it');
nextSession('third-session', 'initech:carol');
const learned = await run(false);
assert.equal(learned.late, 'late-bytes', `a third session holds the learned file: ${JSON.stringify(learned)}`);
// It read it, and the supervisor never had to fault it in: the entry is confirmed.
manager.noteProcessReportedExit(learned.pid, 0, [], { served: new Set(), profileUnread: [] });
await Promise.all(sessionCtxNow.waited);
assert.equal(entriesOf()['private/late.js'].score, 2, 'held and never faulted in raises its score');

say('resident-data-plan: ok\n');
say(`  control: ${JSON.stringify(control)}\n`);
say(`  filled : ${JSON.stringify(filled)}\n`);
