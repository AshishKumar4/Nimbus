#!/usr/bin/env bun
// A hosted runtime that ran `node -e` and went quiet leaves its Durable
// Object nothing pending but one alarm, at the moment its retained logs are
// due to go — so the object can hibernate.
//
// A Durable Object cannot hibernate while a setTimeout or a ctx.waitUntil
// promise is pending; an alarm does not hold it. The runtime's log janitor
// used to ask its embedder for a turn every 60 s while any process ran — and
// the workspace's own shell always runs — so once a process had logged, the
// janitor re-armed for as long as the object lived, with nothing due. An
// embedder whose schedule was a timer (Kinu's) never hibernated again; one
// on an alarm booted the whole runtime every 60 s. And a janitor woken in a
// fresh instance swept only memory, which holds none of its predecessor's
// pids, so their persisted logs were never dropped.
//
// Asserted through composeHostedRuntime's public surface, with the embedder
// lifecycle the library docs prescribe (one alarm over a task map):
//   [1] after the run and its log flush, no timer and no waitUntil work is
//       pending, and the only task is `log-janitor` at exit + retention;
//   [2] the janitor at that deadline drops the logs (memory and SQL) and
//       schedules nothing: the running shell is not work;
//   [3] logs survive a hibernation, and a janitor woken in a fresh instance
//       drops the persisted logs it never held in memory, then schedules nothing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';

import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

const RETAIN_AFTER_EXIT_MS = 10 * 60 * 1000;

const root = new URL('../../', import.meta.url).pathname;
const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-hosted-idle-'));
let bundle;
try {
  const entryPath = join(outputDir, 'entry.ts');
  await writeFile(entryPath, [
    `export { composeHostedRuntime } from '${root}packages/worker/src/workspace-host.ts';`,
    `export { NimbusWorkspace } from '${root}packages/core/src/workspace/nimbus-workspace.ts';`,
    `export { SessionProcessSupervisor } from '${root}packages/core/src/runtime/session-process-supervisor.ts';`,
    `export { PortRegistry } from '${root}packages/core/src/runtime/port-registry.ts';`,
    `export { SqliteVFS } from '${root}packages/core/src/vfs/sqlite-vfs.ts';`,
    `export { PID_GEN_STRIDE } from '${root}packages/core/src/runtime/process-table.ts';`,
    `export { composeFabric } from '${root}packages/fabric/src/composition.ts';`,
    '',
  ].join('\n'));
  const build = await Bun.build({
    entrypoints: [entryPath],
    outdir: join(outputDir, 'out'),
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cloudflare-workers-test-stub',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-workers', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export class DurableObject {}; export class WorkerEntrypoint {}; export class RpcTarget {};',
          loader: 'js',
        }));
      },
    }],
  });
  assert.equal(build.success, true, build.logs.map(String).join('\n'));
  bundle = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/entry.js')).path).href);
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

// ── The platform, as far as hibernation reads it ─────────────────────────────

// The clock the retention deadlines are read against; moved forward the way
// the platform delivers an alarm at its time.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

// Every setTimeout/setInterval still pending in this isolate. The test's own
// waits use the originals and are not counted.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const pendingTimers = new Map();
globalThis.setTimeout = (fn, ms, ...args) => {
  const handle = realSetTimeout(() => { pendingTimers.delete(handle); fn(...args); }, ms);
  pendingTimers.set(handle, `setTimeout ${ms}ms`);
  return handle;
};
globalThis.clearTimeout = (handle) => { pendingTimers.delete(handle); realClearTimeout(handle); };
globalThis.setInterval = (fn, ms, ...args) => {
  const handle = realSetInterval(fn, ms, ...args);
  pendingTimers.set(handle, `setInterval ${ms}ms`);
  return handle;
};
globalThis.clearInterval = (handle) => { pendingTimers.delete(handle); realClearInterval(handle); };
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 50));

// What survives hibernation: the SQLite database and the alarm with its task
// map (the library docs' one-alarm lifecycle).
const db = new Database(':memory:');
const tasks = new Map();

const ASSETS = {
  async fetch(request) {
    const path = new URL(request.url).pathname.replace(/^\//, '');
    return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
  },
};
const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}), { resolveConfig: false });
/** The instance a loaded program's SUPERVISOR binding reaches. */
let current = null;
const env = {
  WORKSPACES: { idFromName() {}, idFromString() {}, get() {} },
  LOADER: {
    // A one-shot `node -e "console.log(1)"`. Like the node runner, the program
    // hands its output and its exit to the supervisor, which keeps them as the
    // process's byte log. A live foreground run has no second text capture
    // in its completion response.
    load(config) {
      const { pid } = config.env.SUPERVISOR.props;
      return {
        getEntrypoint: () => ({
          async fetch() {
            await current.runtime.supervisorOp({ op: 'stdout', args: [new TextEncoder().encode('1\n')], pid });
            await current.runtime.supervisorOp({ op: 'reportExit', args: [0, '', [], null, [], []], pid });
            return Response.json({ exitCode: 0, stdout: '', stderr: '' });
          },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      };
    },
    get: world.loader.get.bind(world.loader),
  },
  ASSETS,
};

/** One instance of the object: a fresh isolate's workspace and runtime over the surviving storage. */
async function boot(generation) {
  const harness = createSqliteVfsTestHarness(db);
  const facetCtx = createFacetCtx(world, 'embedder-do');
  const waiting = new Set();
  const track = (task) => {
    const held = Promise.resolve(task).catch(() => {}).finally(() => waiting.delete(held));
    waiting.add(held);
  };
  const ctx = {
    ...facetCtx,
    waitUntil: track,
    storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync },
    exports: { SupervisorRPC: ({ props }) => ({ props }) },
    getWebSockets: () => [],
  };
  const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
  const processes = new bundle.SessionProcessSupervisor();
  processes.setPidBase(generation * bundle.PID_GEN_STRIDE);
  const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation });
  const runtime = await bundle.composeHostedRuntime({
    workspace,
    ctx,
    env,
    ports: new bundle.PortRegistry(),
    lifecycle: {
      waitUntil: track,
      async schedule(task, at) { tasks.set(task, at); },
      async cancel(task) { tasks.delete(task); },
    },
  });
  return current = {
    runtime,
    waiting,
    /** The alarm handler: every due task, cancelled before it runs (it may schedule itself again). */
    async alarm() {
      for (const [task, at] of [...tasks]) {
        if (at > Date.now()) continue;
        tasks.delete(task);
        await runtime.onScheduled(task);
      }
      await settle();
    },
  };
}

const logRows = (pid) => db.query('SELECT COUNT(*) AS n FROM w9_proc_logs WHERE pid = ?').get(pid).n
  + db.query('SELECT COUNT(*) AS n FROM w9_proc_exits WHERE pid = ?').get(pid).n;
const pendingWork = (instance) => ({ timers: [...pendingTimers.values()], waitUntil: instance.waiting.size, tasks: Object.fromEntries(tasks) });

// ── [1] after node -e and the log flush: only the retention alarm ───────────
const first = await boot(1);
const ran = await first.runtime.exec('node -e "console.log(1)"', { shellId: 'agent:idle' });
assert.equal(ran.exitCode, 0, JSON.stringify(ran));
assert.equal(ran.stdout, '1\n');
const [node] = (await first.runtime.listProcesses()).filter((p) => p.command.startsWith('node ') && first.runtime.workspace.processes.getExit(p.pid));
assert.ok(node, `the node run left an exit record: ${JSON.stringify(await first.runtime.listProcesses())}`);
const exitAt = first.runtime.workspace.processes.getExit(node.pid).at;
await settle();
assert.ok(tasks.has('log-flush'), `the run's logs asked for a flush: ${JSON.stringify(Object.fromEntries(tasks))}`);
skew += 1_000; // the flush alarm's time
await first.alarm();
assert.ok(logRows(node.pid) > 0, 'the flush persisted the run\'s logs');
assert.deepEqual(pendingWork(first), { timers: [], waitUntil: 0, tasks: { 'log-janitor': exitAt + RETAIN_AFTER_EXIT_MS } },
  'idle after the run: no timer, no waitUntil, one alarm task at the retention deadline');
console.log('  [1] after node -e and its flush: nothing pending but log-janitor at exit + retention');

// ── [2] the janitor at the deadline drops the logs and schedules nothing ────
skew = exitAt + RETAIN_AFTER_EXIT_MS - realNow();
await first.alarm();
assert.equal(first.runtime.workspace.processes.hasLogs(node.pid), false, 'the logs left memory');
assert.equal(logRows(node.pid), 0, 'and SQL, in the same turn');
assert.ok(first.runtime.workspace.processes.stats.running > 0, 'the workspace shell still runs');
assert.deepEqual(pendingWork(first), { timers: [], waitUntil: 0, tasks: {} }, 'nothing is due, so nothing is scheduled');
console.log('  [2] the janitor at the deadline drops the logs and schedules nothing');

// ── [3] across a hibernation ────────────────────────────────────────────────
// Hibernation: the isolate is gone, without a close(); SQLite and the alarm stay.

const second = await boot(2);
const again = await second.runtime.exec('node -e "console.log(1)"', { shellId: 'agent:idle' });
assert.equal(again.exitCode, 0, JSON.stringify(again));
const [rerun] = (await second.runtime.listProcesses()).filter((p) => p.command.startsWith('node ') && second.runtime.workspace.processes.getExit(p.pid));
const rerunExit = second.runtime.workspace.processes.getExit(rerun.pid).at;
await settle();
skew += 1_000;
await second.alarm();
assert.ok(logRows(rerun.pid) > 0, 'persisted before the object hibernates');
assert.deepEqual(pendingWork(second).tasks, { 'log-janitor': rerunExit + RETAIN_AFTER_EXIT_MS });

// Woken before the deadline, a reader still gets the logs.
const reader = await boot(3);
const retained = await reader.runtime.processLogs(rerun.pid);
assert.equal(retained.text, '1\n', `retained across the hibernation: ${JSON.stringify(retained)}`);
assert.equal(retained.exit?.code, 0);
assert.deepEqual(pendingWork(reader).tasks, { 'log-janitor': rerunExit + RETAIN_AFTER_EXIT_MS }, 'the alarm still stands');
// Hibernated again, untouched this time: the alarm wakes a fresh instance whose memory holds nothing.
const woken = await boot(4);
skew = rerunExit + RETAIN_AFTER_EXIT_MS - realNow();
await woken.alarm();
assert.equal(logRows(rerun.pid), 0, 'the janitor woken in a fresh instance drops the persisted logs');
assert.deepEqual(pendingWork(woken), { timers: [], waitUntil: 0, tasks: {} }, 'and schedules nothing');
console.log('  [3] logs survive a hibernation; the janitor woken after it drops them, then schedules nothing');

await Promise.all([first, second, reader, woken].map((instance) => instance.runtime.close()));
console.log('hosted-runtime-idle-hibernation OK');
