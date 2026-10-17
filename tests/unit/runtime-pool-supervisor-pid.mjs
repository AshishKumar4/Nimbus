#!/usr/bin/env bun
// Runtime pools carry the invoking process's credential and a fresh run.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { createSupervisorBridgeStore } from '../../packages/core/src/workspace/supervisor-op.ts';
import { openSupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { facetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
import { adoptCtxExports, composeFabric } from '../../packages/fabric/src/composition.ts';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './lib/session-supervisor-ops.mjs';
import { manifestFile } from './lib/runtime-session.mjs';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  },
}));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
const { runPythonRepl, warmPythonRepl } = await import('../../packages/worker/src/runtime/python-repl.ts');
const { runRubyRepl } = await import('../../packages/worker/src/runtime/ruby-repl.ts');
const { loaderFacetHost } = await import('../../packages/worker/src/runtime/facet-loader-host.ts');
const { WebSocketTerminal } = await import('../../packages/worker/src/facets/ws-terminal.ts');

composeFabric({ supervisorEntrypoint: 'SupervisorRPC' });
let current;
adoptCtxExports({
  SupervisorRPC({ props }) {
    const rpc = new SupervisorRPC({ props }, current.env);
    // The host activates the minted run, just as FacetManager does at launch.
    if (props.writerId) current.deliveries.startReadRun(props.pid, props.writerId, {
      maxEntries: 64, maxBytes: 1048576, recording: () => true,
      disqualify: (why) => assert.fail(why),
    });
    current.minted.push(rpc);
    return rpc;
  },
});

async function settles(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('runtime pool scenario did not settle')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

function world() {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  const processes = new SessionProcessSupervisor();
  const ctx = { id: { toString: () => 'runtime-credential-session' }, waitUntil() {} };
  const deliveries = openSupervisorDeliveries(ctx);
  const filesystem = new ProcessFiles(vfs);
  const host = {
    sqliteFs: vfs, processes, supervisorDeliveries: deliveries, ensureSqliteFs() {},
    _rpcStdout: (pid, bytes) => processes.appendOutputBytes(pid, 'stdout', bytes),
  };
  const ops = buildSessionSupervisorOps(host, createSupervisorBridgeStore({ vfs, processes, filesystem }));
  attachSupervisorOps(host, ops);
  root.mkdir('/home', { mode: 0o755 });
  const users = [1101, 2202].map((uid) => {
    const home = `/home/u${uid}`;
    root.mkdir(home, { recursive: true, mode: 0o700 });
    root.chown(home, uid, uid);
    const cred = { uid, gid: uid, groups: [uid], umask: 0o077 };
    const { pid } = processes.spawn('runtime', ['runtime'], home, { cred });
    return { home, cred, pid };
  });
  const assets = {
    'py/share/cpython/python.wasm': 'interpreter image',
    'py/lib/python313.zip': 'stdlib image',
    'rb/share/ruby/ruby+stdlib.wasm': 'ruby image',
  };
  for (const [path, bytes] of Object.entries(assets)) {
    root.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    root.writeFile(path, bytes);
  }
  const cached = new Map();
  const w = { harness, root, ctx, deliveries, users, minted: [], calls: 0, scenario: null };
  // Only the platform transport/interpreter is stood in for: the real pool
  // builds WorkerCode, caches it, and hands its actual SUPERVISOR to the guest.
  const loader = {
    get(id, build) {
      if (!cached.has(id)) cached.set(id, Promise.resolve(build()));
      const code = cached.get(id);
      const invoke = async (bindings) => {
        const config = await code;
        const supervisor = bindings?.SUPERVISOR ?? config.env?.SUPERVISOR;
        w.calls++;
        await w.scenario(supervisor);
        return { stdout: '', stderr: '', exitCode: 0 };
      };
      return { getEntrypoint: () => ({
        execute: (_arg, bindings) => invoke(bindings),
        fetch: async () => Response.json(await invoke()),
      }) };
    },
  };
  w.env = {
    LOADER: loader,
    NIMBUS_SESSION: {
      idFromString: (id) => ({ toString: () => id }),
      get: () => ({ supervisorOp: (sent) => host.supervisorOp(structuredClone(sent)) }),
    },
  };
  w.deps = {
    facetMgr: { loaderHost: () => ({ env: w.env, ctx, network: ISOLATE_NETWORK }) },
    authority: filesystem,
  };
  w.python = {
    installRoot: 'py',
    manifest: { version: '3.13.14-3', files: [manifestFile('share/cpython/python.wasm', assets['py/share/cpython/python.wasm'])] },
  };
  w.ruby = {
    installRoot: 'rb',
    manifest: { version: '3.3.4', files: [manifestFile('share/ruby/ruby+stdlib.wasm', assets['rb/share/ruby/ruby+stdlib.wasm'])] },
  };
  w.close = async () => { await ops.dispose(); harness.db.close(); };
  return w;
}

const task = facetTaskSource('async function credentialScenario() {}');

async function prompt(w, kind, user) {
  const ready = Promise.withResolvers();
  let output = '';
  const terminal = new WebSocketTerminal(null, (chunk) => {
    output += chunk;
    if (output.includes(kind === 'python' ? '>>> ' : 'irb> ')) ready.resolve();
  });
  const deps = { ...w.deps, ...w[kind], ...user, terminal, cwd: user.home, binName: 'ruby', start: { cwd: user.home, binName: 'python3' } };
  const running = kind === 'python' ? runPythonRepl(deps) : runRubyRepl(deps);
  try {
    await settles(Promise.race([ready.promise, running.then(() => assert.fail(output))]));
    // Ruby creates its pool on the first submitted line; Python boots before
    // publishing its prompt. A queued Ctrl-D closes only after that line.
    terminal.sendData('1\r\x04');
    assert.equal(await settles(running), 0, output);
  } finally {
    await terminal.disposeRepl();
    await running;
    terminal.close();
  }
}

for (const kind of ['python', 'ruby', 'loader', 'loader-per-call']) {
  const w = world();
  current = w;
  try {
    if (kind === 'python') {
      w.scenario = async (supervisor) => assert.equal(supervisor, undefined, 'warm-up exposed a SUPERVISOR');
      await warmPythonRepl({ ...w.deps, ...w.python, home: w.users[0].home });
      assert.equal(w.calls, 1, 'warm-up never reached its loaded worker');
    }
    const previous = new Map();
    for (const round of [1, 2]) for (const [index, user] of w.users.entries()) {
      const other = w.users[1 - index];
      const path = `${user.home}/${kind}-${round}`;
      const forbidden = `${other.home}/${kind}-foreign-${round}`;
      const before = w.calls;
      const exercised = Promise.withResolvers();
      const old = previous.get(user.pid);
      let active;
      w.scenario = async (supervisor) => {
        try {
          assert.ok(supervisor, 'the runtime worker has no supervisor');
          await supervisor.stdout(new Uint8Array([65]));
          await supervisor.writeFile(path, `${user.cred.uid}`);
          assert.equal(await supervisor.readFile(path), `${user.cred.uid}`);
          await assert.rejects(supervisor.writeFile(forbidden, 'foreign'), (error) => error.code === 'EACCES');
          assert.equal(w.root.exists(forbidden), false);
          assert.equal(w.root.stat(path).uid, user.cred.uid);
          if (old) {
            await assert.rejects(old.readFile(path), (error) => error.code === 'ESTALE', 'the previous run still reads through its old pool');
          }
          active = supervisor;
          exercised.resolve();
        } catch (error) { exercised.reject(error); throw error; }
      };
      // Keep assertion failures visible even when an adapter reports them on
      // the terminal instead of rejecting its run.
      exercised.promise.catch(() => {});
      if (kind.startsWith('loader')) {
        const facet = loaderFacetHost(w.env, w.ctx, ISOLATE_NETWORK).open({
          tag: 'credential-scenario', concurrency: 1, syscalls: { vfs: {}, pid: user.pid },
          ...(kind === 'loader-per-call' ? { warm: 'credential-scenario' } : {}),
        });
        try { await facet.submit(task, {}); } finally { facet.dispose(); }
      } else await prompt(w, kind, user);
      await settles(exercised.promise);
      previous.set(user.pid, active);
      assert.ok(w.calls > before, `${kind} never reached a loaded worker`);
      assert.equal(new TextDecoder().decode(w.root.readFile(path)), `${user.cred.uid}`);
    }
    assert.equal(previous.size, 2);
    console.log(`ok ${kind}: two credentials, cross-directory EACCES, fresh runs`);
  } finally { await w.close(); }
}
