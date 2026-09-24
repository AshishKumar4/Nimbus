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
 * invalidation log, served through the session's real supervisor-op handlers
 * and `_rpcFsList` / `_rpcFsReadBatch`. A peer is anything that writes it from
 * outside the facet — `authority.kfs.writeFile` — which is exactly what a
 * shell command or another process is to the supervisor.
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
import {
  _rpcFsAppend,
  _rpcFsAppendAck,
  _rpcFsList,
  _rpcFsReadBatch,
  _rpcFsWriteRange,
} from '../../../packages/worker/src/session/rpc.ts';
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

// Captured before any launch: the body replaces globalThis.process and console.
const realProcess = globalThis.process;
const realStdout = realProcess.stdout.write.bind(realProcess.stdout);
const realStderr = realProcess.stderr.write.bind(realProcess.stderr);

export const CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const WRITER_ID = '22222222-2222-4222-8222-222222222222';
const dec = new TextDecoder();

/**
 * The session filesystem, as the supervisor holds it. `kfs` writes as the
 * session user — what a shell command or another process writes as — and a
 * facet's pid-less calls resolve to the same identity (CRED_SESSION_USER).
 */
export function createAuthority() {
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = rawVfs.as(CRED_KERNEL);
  root.mkdir('home/user', { recursive: true, mode: 0o755 });
  root.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const kfs = rawVfs.as(CRED_SESSION_USER);
  const host = attachSupervisorOps({
    sqliteFs: rawVfs,
    processes: new SessionProcessSupervisor(),
    ensureSqliteFs() {},
  });
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
 * counted, filesystem ops go to the real handlers, and `overrides` replaces
 * any one of them (an `undefined` override removes the method).
 */
export function facetSupervisor(authority, overrides = {}) {
  const { host } = authority;
  const log = { stdout: '', stderr: '', calls: {}, exit: null, ports: new Set() };
  const own = {
    stdout: async (bytes) => { log.stdout += dec.decode(bytes); },
    stderr: async (bytes) => { log.stderr += dec.decode(bytes); },
    reportExit: async (code, reason) => { log.exit = { code, reason }; },
    registerPort: async (port) => { log.ports.add(port); },
    unregisterPort: async (port) => { log.ports.delete(port); },
    setUmask: async (mask) => mask,
    fsList: (after, limit) => _rpcFsList(host, after ?? null, limit ?? null),
    fsReadBatch: (requests) => _rpcFsReadBatch(host, requests),
    fsWriteRange: (path, offset, bytes) => _rpcFsWriteRange(host, path, offset, bytes),
    fsAppend: (path, moduleId, operationId, bytes) =>
      _rpcFsAppend(host, path, WRITER_ID, moduleId, operationId, bytes),
    fsAppendAck: (moduleId, operationId) => _rpcFsAppendAck(host, WRITER_ID, moduleId, operationId),
    ...overrides,
  };
  const supervisor = new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (Object.hasOwn(own, name) && own[name] === undefined) return undefined;
      return (...args) => {
        log.calls[name] = (log.calls[name] ?? 0) + 1;
        return Object.hasOwn(own, name) ? own[name](...args) : host.supervisorOp({ op: name, args });
      };
    },
  });
  return { supervisor, log };
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
 */
export async function launchResident({
  program,
  env,
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
    { cred: CRED, cwd, filename: `${cwd}/main.js`, dirname: cwd },
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
 * Run each scenario in its own child process, or — inside that child — run
 * the one it was started for. `file` is the calling test's own path.
 */
export async function runScenarios(file, scenarios) {
  const selected = realProcess.env.NIMBUS_RESIDENT_BODY_SCENARIO;
  if (selected) {
    try {
      await scenarios[selected]();
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
    });
    const stdout = child.stdout.toString();
    const stderr = child.stderr.toString();
    if (child.exitCode === 0 && stdout.includes(`SCENARIO-OK ${name}`)) {
      realStdout(`  ok  ${name}\n`);
    } else {
      realStdout(`  FAIL ${name}\n${stdout}${stderr}\n`);
      failures.push(name);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} scenario(s) failed: ${failures.join(', ')}`);
  }
}
