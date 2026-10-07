#!/usr/bin/env bun
//
// A resident's exit is told after its write log is drained (facets/manager.ts:
// journalFor, _endBySignal; workerd-facet-host.ts: spawnResident's release).
//
// A resident logs every change in its facet's SQLite before its program is
// told it succeeded (process-fs-journal.ts). Killed with changes the session
// has not answered, its facet is released and the log drained into the
// session; only then is its exit told, so what reads the files next (the next
// prompt, its parent's wait) sees every change the program was told landed.
// And the session's book of journaling residents (process-journals.ts) is
// written when the facet opens and emptied by the drain. Red before: the
// signal's default action told the exit at once, before any drain.

import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { processFsClient, sqlJournal } from '../../packages/core/src/_shared/process-fs-client.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { processFiles } from './lib/process-bridge.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

const enc = new TextEncoder();
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user/app/out', { recursive: true, mode: 0o755 });
for (const dir of ['home/user', 'home/user/app', 'home/user/app/out']) kernel.chown(dir, CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);

// Each facet name's SQLite, as the platform keeps it past the facet's isolate.
const facetStores = new Map();
const facetSql = (name) => {
  if (!facetStores.has(name)) facetStores.set(name, createSqliteVfsTestHarness().sql);
  return facetStores.get(name);
};
const READER = Symbol('NimbusFsJournalReader');

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}));
// A name opened with the journal reader class reads that name's store.
const facets = {
  ...world.facets,
  get(name, start) {
    const program = world.facets.get(name, start);
    const reader = async () => {
      const { class: cls } = await start();
      assert.equal(cls, READER, `facet '${name}' was read with another class`);
      return sqlJournal(facetSql(name));
    };
    return {
      startProcess: (args) => program.startProcess(args),
      handleHttpRequest: (request) => program.handleHttpRequest(request),
      held: () => program.held(),
      numberings: async () => (await reader()).numberings(),
      number: async (numbering) => (await reader()).number(numbering),
      readAfter: async (after, maxBytes) => (await reader()).readAfter(after, maxBytes),
      dropThrough: async (jid) => (await reader()).dropThrough(jid),
    };
  },
  delete(name) { world.facets.delete(name); facetStores.delete(name); },
};
const env = {
  LOADER: {
    get: world.loader.get,
    load: () => ({ getDurableObjectClass: (name) => (name === 'NimbusFsJournalReader' ? READER : undefined) }),
  },
  ASSETS: stagedAssets,
};
const ctx = createFacetCtx({ ...world, facets }, 'journal-exit-order');
ctx.storage.sql = createSqliteVfsTestHarness().sql;

const processes = new SessionProcessSupervisor();
processes.setPidBase(PID_GEN_STRIDE);
const filesAtExit = new Map();
const out = () => kernel.readdir('home/user/app/out').length;
const manager = new FacetManager(ctx, env, processes, new PortRegistry(), processHostFor, {
  requestLaunchTurn: () => { setTimeout(() => { void manager.pumpResidentLaunches(); }, 0); },
  notify: () => {},
  // The moment its exit is told: what is in the session then.
  onExternalExit: (pid) => { filesAtExit.set(pid, out()); },
  resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(vfs, recipe),
});
manager.setVfs(vfs, processFiles(vfs));

const settle = async (predicate, tries = 400) => {
  for (let i = 0; i < tries && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};
const booked = () => [...ctx.storage.sql.exec('SELECT facet, pid FROM nimbus_process_journals')].map((row) => ({ facet: String(row.facet), pid: Number(row.pid) }));

const invoker = processes.spawn('node server.js', ['node server.js'], '/home/user/app');
const server = await manager.spawnNode("require('http').createServer(() => {}).listen(8080);", {
  filename: '/home/user/app/server.js', cwd: '/home/user/app', command: 'node server.js',
  argv: ['/home/user/app/server.js'], invokerPid: invoker.pid,
});
await settle(() => booked().some((row) => row.pid === server.pid));
const row = booked().find((entry) => entry.pid === server.pid);
assert.ok(row, `the session did not book the resident's log: ${JSON.stringify(booked())}`);

// The program writes 300 files, each one logged and told it succeeded; the
// session answers none of them before the process is killed.
const never = new Promise(() => {});
const client = processFsClient({
  session: { openWriter: () => never, writeBatchStream: () => never },
  journal: sqlJournal(facetSql(row.facet)),
  retry: { backoffMs: [1], stallMs: 60_000, answerDeadlineMs: 60_000 },
});
for (let i = 0; i < 300; i++) {
  client.submit({ type: 'call', call: { call: 'writeFile', path: `home/user/app/out/f${i}`, mode: 0o644, data: enc.encode(`${i}`) } }, { acknowledged: true });
}
assert.equal(out(), 0);

processes.signal(server.pid, 'SIGKILL');
await settle(() => processes.get(server.pid)?.state !== 'running' && filesAtExit.has(server.pid));
assert.equal(processes.get(server.pid)?.exitCode, 137);
assert.equal(filesAtExit.get(server.pid), 300, `its exit was told with ${filesAtExit.get(server.pid)} of the 300 files it was told landed`);
assert.equal(out(), 300);
assert.equal(new TextDecoder().decode(kernel.readFile('home/user/app/out/f299')), '299');
await settle(() => booked().length === 0);
assert.deepEqual(booked(), [], 'the drained log stayed booked');
assert.equal(facetStores.has(row.facet), false, 'the drained store was kept');

console.log('  [1] killed: its exit is told once its log is drained, and its book row and store go');

// ── A booted resident dies on its own (out of memory): drained, then its exit ──
// Its class holds held() open while its isolate lives; the rejection is the
// process lost. Red before: nothing heard a booted resident's death, so it
// stayed "running" and its log was never drained.
kernel.mkdir('home/user/app/out3', { recursive: true, mode: 0o755 });
kernel.chown('home/user/app/out3', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const oom = await manager.spawnNode("require('http').createServer(() => {}).listen(8082);", {
  filename: '/home/user/app/oom.js', cwd: '/home/user/app', command: 'node oom.js',
  argv: ['/home/user/app/oom.js'], invokerPid: invoker.pid,
});
await settle(() => booked().some((entry) => entry.pid === oom.pid));
const oomRow = booked().find((entry) => entry.pid === oom.pid);
const oomClient = processFsClient({
  session: { openWriter: () => never, writeBatchStream: () => never },
  journal: sqlJournal(facetSql(oomRow.facet)),
  retry: { backoffMs: [1], stallMs: 60_000, answerDeadlineMs: 60_000 },
});
for (let i = 0; i < 200; i++) {
  oomClient.submit({ type: 'call', call: { call: 'writeFile', path: `home/user/app/out3/h${i}`, mode: 0o644, data: enc.encode(`${i}`) } }, { acknowledged: true });
}
const out3 = () => kernel.readdir('home/user/app/out3').length;
const out3AtExit = new Map();
const realExit = processes.exit.bind(processes);
processes.exit = (pid, code) => { if (pid === oom.pid && !out3AtExit.has(pid)) out3AtExit.set(pid, out3()); return realExit(pid, code); };
world.die(oomRow.facet);
await settle(() => processes.get(oom.pid)?.state !== 'running');
processes.exit = realExit;
assert.equal(processes.get(oom.pid)?.state, 'exited', 'a resident that died stayed running');
assert.equal(processes.get(oom.pid)?.exitCode, 1);
assert.equal(out3AtExit.get(oom.pid), 200, `its exit was told with ${out3AtExit.get(oom.pid)} of the 200 files it was told landed`);
await settle(() => !booked().some((entry) => entry.pid === oom.pid));
assert.equal(booked().some((entry) => entry.pid === oom.pid), false);
console.log('  [2] died on its own after its boot: drained, then its exit told (1)');

// ── An instance reset with a resident's log undrained: drained at the next start ──
// The old instance never released its facet (it was reset); the new one
// drains the log from the store the book names before anything runs, and no
// process it starts meanwhile is handed that name.
kernel.mkdir('home/user/app/out2', { recursive: true, mode: 0o755 });
kernel.chown('home/user/app/out2', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const lost = await manager.spawnNode("require('http').createServer(() => {}).listen(8081);", {
  filename: '/home/user/app/lost.js', cwd: '/home/user/app', command: 'node lost.js',
  argv: ['/home/user/app/lost.js'], invokerPid: invoker.pid,
});
await settle(() => booked().some((entry) => entry.pid === lost.pid));
const lostRow = booked().find((entry) => entry.pid === lost.pid);
const lostClient = processFsClient({
  session: { openWriter: () => never, writeBatchStream: () => never },
  journal: sqlJournal(facetSql(lostRow.facet)),
  retry: { backoffMs: [1], stallMs: 60_000, answerDeadlineMs: 60_000 },
});
for (let i = 0; i < 100; i++) {
  lostClient.submit({ type: 'call', call: { call: 'writeFile', path: `home/user/app/out2/g${i}`, mode: 0o644, data: enc.encode(`${i}`) } }, { acknowledged: true });
}
const { runColdStart } = await import('../../packages/fabric/src/generation.ts');
const ctx2 = createFacetCtx({ ...world, facets }, 'journal-exit-order', ctx.storage.rows);
ctx2.storage.sql = ctx.storage.sql;
const processes2 = new SessionProcessSupervisor();
processes2.setPidBase(2 * PID_GEN_STRIDE);
const manager2 = new FacetManager(ctx2, env, processes2, new PortRegistry(), processHostFor, {
  requestLaunchTurn: () => { setTimeout(() => { void manager2.pumpResidentLaunches(); }, 0); },
  notify: () => {},
  resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(vfs, recipe),
});
manager2.setVfs(vfs, processFiles(vfs));
assert.equal(kernel.readdir('home/user/app/out2').length, 0);
await runColdStart(ctx2);
assert.equal(kernel.readdir('home/user/app/out2').length, 100, 'the next start did not drain the log a reset left');
assert.equal(booked().some((entry) => entry.pid === lost.pid), false, 'the drained log stayed booked');
assert.equal(facetStores.has(lostRow.facet), false, 'the drained store was kept');
console.log('  [3] reset with a log undrained: the next start drains it, books it off and drops its store');

console.log('resident-journal-exit-order: ok');
process.exit(0);
