// @serial
// @tier slow — drives a local workerd; CI median 14 s wall, 13 s CPU, 1.3 GiB peak (6 runs, 2026-10-06)
// A user Worker under Nimbus's `wrangler dev` calls a classic Durable Object
// binding as on Cloudflare, checked as a differential: the same Workers
// (tests/behavioral/wrangler/new/_do-rpc-worker.mjs) run on plain workerd,
// with a real Durable Object namespace, and under Nimbus on the real workerd
// (lib/workerd-probe.mjs: apps/probe, its session Durable Object, the LOADER
// that makes the inner Worker), and both must answer exactly what the shared
// file records, but for the one difference it names (NIMBUS_DIFFERS: typeof
// a stub). Covered: calls with arguments and answers, a thrown error,
// pipelining, storage, the object's env; members read and paths through them
// (getters); the namespace, ids and stubs as objects; RpcTargets, stubs
// (an object's own included) and functions passed and returned, streams and
// responses returned; dup, dispose, `using` and the target told it was
// disposed; a stub in a Worker Loader env, and a namespace refused there;
// default exports whose fetch is on the prototype or not enumerable, and an
// entrypoint class; and a binding whose class is not exported failing the
// build.
//
// Before: env.P was a WorkerEntrypoint, so idFromName answered an RpcPromise
// that get() could not take ("Could not serialize object of type
// "RpcPromise"").
//
// Runs the worker built in the tree: rebuild the generated artifacts before
// testing a change (dist-integrity).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startLocalProbe } from './lib/workerd-probe.mjs';
import {
  NIMBUS_DIFFERS, SHAPED_WORKERS, WORKER, WRANGLER_CONFIG, expectedAnswers, expectedShapedAnswer,
} from '../behavioral/wrangler/new/_do-rpc-worker.mjs';

/**
 * Runs `source` on plain workerd with WRANGLER_CONFIG's bindings (a real
 * SQLite Durable Object namespace P, GREETING, a Worker Loader) and answers
 * the JSON of `requests` GETs, in order.
 */
async function onPlainWorkerd(source, requests) {
  const binary = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'))('workerd').default;
  const dir = mkdtempSync(join(tmpdir(), 'nimbus-do-rpc-'));
  mkdirSync(join(dir, 'store'));
  const free = net.createServer();
  await new Promise((resolve) => free.listen(0, '127.0.0.1', resolve));
  const port = free.address().port;
  await new Promise((resolve) => free.close(resolve));
  writeFileSync(join(dir, 'main.js'), source);
  writeFileSync(join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "main.js", esModule = embed "main.js")],
      compatibilityDate = "${WRANGLER_CONFIG.compatibility_date}",
      bindings = [
        (name = "P", durableObjectNamespace = "P"),
        (name = "GREETING", text = "${WRANGLER_CONFIG.vars.GREETING}"),
        (name = "LOADER", workerLoader = ()),
      ],
      durableObjectNamespaces = [(className = "P", uniqueKey = "p", enableSql = true)],
      durableObjectStorage = (localDisk = "store"),
    )),
    (name = "store", disk = (path = "${join(dir, 'store')}", writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);`);
  const child = spawn(binary, ['serve', 'config.capnp', '--experimental'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  try {
    const answers = [];
    const until = Date.now() + 30_000;
    while (answers.length < requests) {
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${port}/`);
      } catch (error) {
        // Not listening yet.
        if (child.exitCode !== null || Date.now() > until) throw new Error(`plain workerd: ${error}\n${logs}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      assert.equal(response.status, 200, logs);
      answers.push(await response.json());
    }
    return answers;
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Cloudflare's answers: the shared file records them.
const [plainFirst, plainSecond] = await onPlainWorkerd(WORKER, 2);
assert.deepEqual(plainFirst, expectedAnswers(0), 'plain workerd answers what the shared file records');
assert.deepEqual(plainSecond, expectedAnswers(2), 'and again, with the storage the first request left');
for (const [shape, source] of Object.entries(SHAPED_WORKERS)) {
  assert.deepEqual((await onPlainWorkerd(source, 1))[0], expectedShapedAnswer(shape), `plain workerd runs the ${shape} default export`);
}

console.log('wrangler-dev-do-rpc-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
process.env.BASE = probe.base;
process.env.NIMBUS_PROBE_TOKEN = probe.token;
const { mintSession, deleteSession, Terminal, requestHeaders, stripAnsi } = await import('../behavioral/_driver.mjs');
const sid = await mintSession();
const terminal = new Terminal(sid);
try {
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  // The project's directories are the user's, made through the shell; its
  // files are written through the session's file route, not typed through
  // the terminal, where a long Worker takes longer to echo than to run.
  await terminal.run('mkdir -p /home/user/do-rpc/src', 10_000);
  const write = async (path, content) => {
    const response = await fetch(`${probe.base}/s/${sid}/api/write-file`, {
      method: 'POST',
      headers: requestHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ path, content }),
    });
    assert.equal(response.status, 200, `write ${path}: ${await response.text()}`);
  };
  const answer = async () => {
    const response = await fetch(`${probe.base}/s/${sid}/worker/`, { headers: requestHeaders() });
    const body = await response.text();
    assert.equal(response.status, 200, body.slice(0, 600));
    return JSON.parse(body);
  };
  /** Starts `wrangler dev` on `source`, answers `requests` GETs, then stops it. */
  const underNimbus = async (source, requests) => {
    await write('/home/user/do-rpc/src/index.js', source);
    terminal.reset();
    terminal.cmd('wrangler dev');
    await terminal.waitFor((b) => /Worker built|\x1b\[31m/.test(b), 120_000, 'wrangler dev build');
    assert.match(stripAnsi(terminal.buf), /Worker built/, stripAnsi(terminal.buf).slice(-1500));
    const answers = [];
    while (answers.length < requests) answers.push(await answer());
    terminal.send('\x03');
    await terminal.waitForPrompt(30_000);
    return answers;
  };

  await write('/home/user/do-rpc/wrangler.jsonc', JSON.stringify(WRANGLER_CONFIG));
  await terminal.run('cd /home/user/do-rpc', 10_000);
  const [first, second] = await underNimbus(WORKER, 2);
  assert.deepEqual(first, { ...expectedAnswers(0), ...NIMBUS_DIFFERS }, JSON.stringify(first, null, 2));
  assert.deepEqual(second, { ...expectedAnswers(2), ...NIMBUS_DIFFERS }, 'the object and its storage outlive the request');
  for (const [shape, source] of Object.entries(SHAPED_WORKERS)) {
    assert.deepEqual((await underNimbus(source, 1))[0], expectedShapedAnswer(shape), `Nimbus runs the ${shape} default export`);
  }

  // A binding whose class the Worker does not export fails the build, as a
  // deploy does, rather than the object's first call.
  await write('/home/user/do-rpc/wrangler.jsonc', JSON.stringify({
    ...WRANGLER_CONFIG,
    durable_objects: { bindings: [{ name: 'P', class_name: 'Missing' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Missing'] }],
  }));
  terminal.reset();
  terminal.cmd('wrangler dev');
  await terminal.waitFor((b) => /Worker built|Failed to start/.test(stripAnsi(b)), 120_000, 'wrangler dev build');
  assert.match(stripAnsi(terminal.buf), /durable_objects binding 'P' => class 'Missing' is not exported by the Worker/, stripAnsi(terminal.buf).slice(-1500));
  assert.doesNotMatch(stripAnsi(terminal.buf), /Worker built/);
} finally {
  await terminal.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
  await probe.stop();
}
console.log('wrangler-dev-do-rpc-workerd: Durable Object RPC under wrangler dev answers as plain workerd does');
