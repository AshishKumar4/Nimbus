/**
 * The REAL resident node body, evaluated against a real SqliteVFS authority.
 *
 * `generateLongRunningNodeCode` is what a resident launch ships: the store at
 * module scope, the boot reconcile, the write ledger, the shims and the HTTP
 * dispatch, in the order the manager assembles them. A test that re-assembles
 * those pieces by hand tests its own assembly, so this evaluates the generated
 * module itself, with only `cloudflare:workers` stood in for.
 *
 * The authority is not a double either: a real `SqliteVFS` with a real
 * invalidation log, served through the session's real supervisor-op handler,
 * with the session's routed surface built the way hosted/runtime.ts builds it.
 * A peer is anything that writes it from outside the facet —
 * `authority.kfs.writeFile` — which is exactly what a shell command or another
 * process is to the supervisor.
 *
 * ONE LAUNCH PER PROCESS. The body installs process-wide state it never takes
 * down — the resumption barriers on globalThis.setTimeout, globalThis.console,
 * process and Buffer — so a second launch in the same realm would run behind
 * the first one's barrier. `runScenarios` gives every scenario its own child.
 */
import { plugin } from 'bun';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { generateLongRunningNodeCode } from '../../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../../packages/core/src/runtime/session-process-supervisor.ts';
import { SUPERVISOR_OP_ROUTES } from '../../../packages/core/src/workspace/supervisor-op.ts';
import * as rpc from '../../../packages/worker/src/session/rpc.ts';
import { buildSessionSupervisorOps } from '../../../packages/worker/src/session/supervisor-op.ts';
import { createSqliteVfsTestHarness } from '../sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from '../session-supervisor-ops.mjs';

plugin({
  name: 'resident-body-cloudflare-workers',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      loader: 'object',
      exports: {
        DurableObject: class DurableObject {
          constructor(ctx, env) { this.ctx = ctx; this.env = env; }
        },
      },
    }));
  },
});

// Captured before any launch: the body replaces globalThis.process and console,
// and wraps setTimeout in the resumption barrier.
const realProcess = globalThis.process;
const realStdout = realProcess.stdout.write.bind(realProcess.stdout);
const realStderr = realProcess.stderr.write.bind(realProcess.stderr);
const rawSetTimeout = globalThis.setTimeout;

/** Wait on the platform's own timer, which takes no barrier of its own. */
export function sleep(ms) {
  const { promise, resolve } = Promise.withResolvers();
  rawSetTimeout(resolve, ms);
  return promise;
}

/** Poll `ready` on the raw timer until it holds, or fail after `ms`. */
export async function until(ready, what, ms = 2_000) {
  for (const deadline = Date.now() + ms; !ready();) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

export const CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const WRITER_ID = '22222222-2222-4222-8222-222222222222';
const dec = new TextDecoder();

/**
 * The session filesystem, as the supervisor holds it. `kfs` writes as the
 * session user — what a shell command or another process writes as — and the
 * facet's process (facetSupervisor) runs as the same identity.
 *
 * An op the handler does not answer natively is routed to a `_rpc*` method of
 * the session. Those are its rpc.ts implementations called with this host as
 * the session, one per route, exactly as hosted/runtime.ts assembles them, so
 * the double serves every route the session serves, whichever side of the
 * native/routed line an op is on.
 */
export function createAuthority() {
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = rawVfs.as(CRED_KERNEL);
  root.mkdir('home/user', { recursive: true, mode: 0o755 });
  root.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const kfs = rawVfs.as(CRED_SESSION_USER);
  const host = { sqliteFs: rawVfs, processes: new SessionProcessSupervisor(), ensureSqliteFs() {} };
  const routed = Object.fromEntries(Object.values(SUPERVISOR_OP_ROUTES).map(({ method }) => {
    const handler = Reflect.get(rpc, method);
    if (typeof handler !== 'function') throw new Error(`no rpc.ts implementation of the routed ${method}`);
    return [method, (...args) => Reflect.apply(handler, undefined, [host, ...args])];
  }));
  attachSupervisorOps(host, buildSessionSupervisorOps(host, undefined, routed));
  return {
    rawVfs,
    kfs,
    host,
    cursor: () => ({ epoch: rawVfs.epoch, rev: rawVfs.revision() }),
    read: (path) => dec.decode(kfs.readFile(path)),
  };
}

/**
 * `env.SUPERVISOR` as a process facet sees it: every call the body makes is
 * counted and sent to the session's handler as SupervisorRPC sends it — for a
 * process of the session's own, carrying its pid — and `overrides` replaces
 * any one of them (an `undefined` override removes the method). Process
 * output, exit and ports are captured here instead.
 */
export function facetSupervisor(authority, overrides = {}) {
  const { host, rawVfs } = authority;
  // The process the facet is: an entry in the session's table, and the append
  // writer incarnation the manager activates for it when it spawns one.
  const { pid } = host.processes.spawn('node', ['main.js'], '/home/user/app', { longRunning: true, cred: CRED });
  rawVfs.activateAppendWriter(pid, WRITER_ID);
  const log = { pid, stdout: '', stderr: '', calls: {}, exit: null, ports: new Set() };
  const own = {
    stdout: async (bytes) => { log.stdout += dec.decode(bytes); },
    stderr: async (bytes) => { log.stderr += dec.decode(bytes); },
    reportExit: async (code, reason) => { log.exit = { code, reason }; },
    registerPort: async (port) => { log.ports.add(port); },
    unregisterPort: async (port) => { log.ports.delete(port); },
    setUmask: async (mask) => mask,
    ...overrides,
  };
  // The append pair also carries the writer incarnation, as SupervisorRPC's
  // envelopes for exactly those two ops do.
  const envelope = (name, args) => (name === 'fsAppend' || name === 'fsAppendAck'
    ? { op: name, args, pid, writerId: WRITER_ID }
    : { op: name, args, pid });
  const forward = (name, args) => host.supervisorOp(envelope(name, args));
  const supervisor = new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (Object.hasOwn(own, name) && own[name] === undefined) return undefined;
      return (...args) => {
        log.calls[name] = (log.calls[name] ?? 0) + 1;
        return Object.hasOwn(own, name) ? own[name](...args) : forward(name, args);
      };
    },
  });
  // `forward` is the session's own answer to an op, for an override that
  // decides per call whether to fail or pass through.
  return { supervisor, log, forward };
}

/** workerd's `ctx.storage.sql` over a real SQLite: exec(query, ...params) → rows. */
export function facetSql(db = new Database(':memory:')) {
  return {
    db,
    exec(query, ...params) {
      if (/^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE)/i.test(query)) {
        db.query(query).run(...params);
        return [];
      }
      return db.query(query).all(...params);
    },
    get databaseSize() { return 0; },
  };
}

/**
 * Generate the resident body for `program`, evaluate it, and start it the way
 * the fabric does: `new NimbusProcess(ctx, env).startProcess({ vfsCursor })`.
 * `env` is the facet's bindings (SUPERVISOR); `processEnv` the program's own.
 */
export async function launchResident({
  program,
  env,
  processEnv = {},
  sql = facetSql(),
  cwd = '/home/user/app',
  bundle = {},
  manifest = {},
  metadata = {},
  cursor,
}) {
  const vfsState = {
    bundle,
    manifest,
    metadata,
    cursor,
    reachableCount: Object.keys(bundle).length,
    truncated: false,
  };
  const generated = await generateLongRunningNodeCode(
    program,
    vfsState,
    { cred: CRED, cwd, filename: `${cwd}/main.js`, dirname: cwd, env: processEnv },
    false,
    generateShimsCode(),
  );
  const dir = mkdtempSync(join(tmpdir(), 'resident-body-'));
  writeFileSync(join(dir, 'worker.mjs'), generated.code);
  for (const [name, source] of Object.entries(generated.modules)) writeFileSync(join(dir, name), source);
  const mod = await import(pathToFileURL(join(dir, 'worker.mjs')).href);
  const ctx = { storage: { sql }, waitUntil() {}, id: { toString: () => 'resident-body-test' } };
  const proc = new mod.NimbusProcess(ctx, env);
  await proc.startProcess(cursor ? { vfsCursor: cursor } : {});
  return { proc, sql };
}

/** The program's live coherence counters (the shims publish them on globalThis). */
export function coherenceStats() {
  return { ...globalThis.__nimbusVfsCoherence };
}

/**
 * A scenario takes well under a second. One that runs this long is waiting
 * on something that will not come — a resumption whose barrier rejected
 * never runs its callback — and is reported as failed rather than left to
 * hang the suite.
 */
const SCENARIO_TIMEOUT_MS = 60_000;

/**
 * Run each scenario in its own child process, or — inside that child — run
 * the one it was started for. `file` is the calling test's own path.
 *
 * A barrier that gets no answer is repaired against the listing, so it can
 * still produce the bytes a scenario expects. A scenario about the delta path
 * would then pass without having exercised it, which is how a harness that
 * could not serve fsAcquire read as stale bytes rather than as the missing
 * route it was. Unless `barrierFailures` says the file fails barriers on
 * purpose, a scenario in which any barrier failed fails, naming the reason.
 */
export async function runScenarios(file, scenarios, { barrierFailures = false } = {}) {
  const selected = realProcess.env.NIMBUS_RESIDENT_BODY_SCENARIO;
  if (selected) {
    try {
      await scenarios[selected]();
      const stats = globalThis.__nimbusVfsCoherence;
      if (!barrierFailures && stats && stats.barrierFailures > 0) {
        throw new Error(
          `${stats.barrierFailures} barrier(s) got no answer (last: ${stats.lastBarrierFailure}); `
          + 'the scenario ran on the failure path, not the delta',
        );
      }
      realStdout(`SCENARIO-OK ${selected}\n`);
      realProcess.exit(0);
    } catch (error) {
      realStderr(`SCENARIO-FAILED ${selected}\n${(error && error.stack) || error}\n`);
      realProcess.exit(1);
    }
    return;
  }
  const failures = [];
  for (const name of Object.keys(scenarios)) {
    const child = Bun.spawnSync({
      cmd: [realProcess.execPath, file],
      env: { ...realProcess.env, NIMBUS_RESIDENT_BODY_SCENARIO: name },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: SCENARIO_TIMEOUT_MS,
    });
    const stdout = child.stdout.toString();
    const stderr = child.stderr.toString();
    if (child.exitCode === 0 && stdout.includes(`SCENARIO-OK ${name}`)) {
      realStdout(`  ok  ${name}\n`);
    } else {
      const killed = child.exitCode === null ? `killed (${child.signalCode}) after ${SCENARIO_TIMEOUT_MS} ms\n` : '';
      realStdout(`  FAIL ${name}\n${killed}${stdout}${stderr}\n`);
      failures.push(name);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} scenario(s) failed: ${failures.join(', ')}`);
  }
}
