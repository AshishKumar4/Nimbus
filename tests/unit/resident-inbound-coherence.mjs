#!/usr/bin/env bun
// Every way the session hands a resident process something to act on is a
// resumption, and must take the ACQUIRE barrier before the program's code
// runs: an HTTP request routed to its port, a chunk on its stdin, a signal,
// output from a child it spawned, the child's exit. Each of those can be the
// second half of a causal chain that starts with a write somewhere else —
// `echo v2 > f; curl :3000`, a child that writes a file and exits — and a
// synchronous read in the handler must see the write that preceded the event.
//
// Each of them is delivered by the supervisor, which answers the barrier on
// the delivery itself (session/rpc.ts _acquireOnDelivery), so the barrier
// must cost no round trip of its own: an attached terminal pays for one on
// every keystroke otherwise.
//
// Each scenario drives the REAL resident body (tests/unit/lib/resident-body.mjs)
// over a real SqliteVFS, and every delivery reaches it through the session's
// own handlers: its input store, its port registry, its child-process RPCs.
// A peer changes the file, then the event arrives, and the handler reads the
// file synchronously.

import assert from 'node:assert/strict';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { _acquireForRoutedRequest } from '../../packages/worker/src/session/rpc.ts';
import {
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
  until,
} from './lib/resident-body.mjs';

const F = 'home/user/app/f.txt';
const enc = new TextEncoder();

const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
const F = "/home/user/app/f.txt";
globalThis.__seen = [];
require("http").createServer((q, s) => s.end(read(F))).listen(3000);
if (process.env.NIMBUS_CP_CHILD_PID) {
  process.stdin.on("data", () => __seen.push("data:" + read(F)));
  process.on("SIGUSR2", () => __seen.push("signal:" + read(F)));
}
globalThis.__spawnWriter = () => new Promise((resolve) => {
  const child = require("child_process").spawn("writer", []);
  child.stdout.on("data", () => __seen.push("stdout:" + read(F)));
  child.on("exit", () => { __seen.push("exit:" + read(F)); resolve(); });
});
`;

/**
 * A session whose f.txt the process holds at 'v1', and the process: attached
 * to the session's input store when `attached`, with `children` as the host's
 * child-process manager, and serving port 3000 through a port registry wired
 * the way the session wires its own.
 */
async function boot({ attached = false, children = null } = {}) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile(F, 'v1');
  const { supervisor, log } = facetSupervisor(authority);
  if (children) authority.host._ensureFacetProcessManager = () => children(authority);
  if (attached) authority.host.processes.openInput(log.pid);
  const { proc } = await launchResident({
    program: PROGRAM,
    env: { SUPERVISOR: supervisor },
    processEnv: attached ? { NIMBUS_CP_CHILD_PID: String(log.pid) } : {},
    cursor: authority.cursor(),
  });
  const ports = new PortRegistry((pid) => _acquireForRoutedRequest(authority.host, pid));
  ports.bindFacetStub(log.pid, proc);
  ports.register(3000, log.pid);
  return { authority, log, proc, ports };
}

/** The supervisor calls `run` caused, by op. */
async function callsDuring(log, run) {
  const before = { ...log.calls };
  const value = await run();
  const made = {};
  for (const [op, count] of Object.entries(log.calls)) {
    if (count !== (before[op] ?? 0)) made[op] = count - (before[op] ?? 0);
  }
  return { value, made };
}

const request = () => new Request('http://facet/', { headers: { 'X-Nimbus-Port': '3000' } });

/**
 * A response's body as text, read without Response.prototype.text: the body
 * under test patches that in this realm (reading a response the network sent
 * is a resumption, and takes the barrier), and this response is the
 * session's, not the program's.
 */
const bodyText = (response) => Bun.readableStreamToText(response.body);

/** Deliver what `send` queues on the process's stdin and wait for its handler. */
async function delivered(log, send) {
  const seen = globalThis.__seen.length;
  const { made } = await callsDuring(log, async () => {
    send();
    await until(() => globalThis.__seen.length === seen + 1, 'the stdin handler');
  });
  return { seen: globalThis.__seen[seen], made };
}

await runScenarios(import.meta.path, {
  async 'an HTTP request after a peer write'() {
    const { authority, log, proc } = await boot();
    authority.kfs.writeFile(F, 'v2');
    // The shared dispatch every resident's server goes through — the node
    // body's __nimbusDispatchHttp and the opencode runner's __ocDispatchHttp.
    // Handed a request with no answer on it, the barrier asks.
    const response = await globalThis.__nimbusServeHttp(request());
    assert.equal(await response.text(), 'v2', 'the handler must run behind a barrier');

    authority.kfs.writeFile(F, 'v3');
    const { value: routed, made } = await callsDuring(log, () => proc.fetch(request()));
    assert.equal(await routed.text(), 'v3');
    assert.equal(made.fsAcquire, 1, 'a request with no answer on it costs exactly one barrier');
  },

  async 'a request the session routes'() {
    const { authority, log, ports } = await boot();
    const route = async () => bodyText(await ports.routeRequest(3000, new Request('http://outer/port/3000/'), '/'));
    const quiet = await callsDuring(log, route);
    assert.equal(quiet.value, 'v1');
    assert.equal(quiet.made.fsAcquire, undefined, 'nothing written since the process caught up: the request is its own answer');

    authority.kfs.writeFile(F, 'v2');
    const after = await callsDuring(log, route);
    assert.equal(after.value, 'v2', '`echo v2 > f; curl` must serve v2');
    assert.equal(after.made.fsAcquire, 1, 'a request after a write asks, once');

    const again = await callsDuring(log, route);
    assert.equal(again.value, 'v2');
    assert.equal(again.made.fsAcquire, undefined, 'and once caught up, the next request is free again');
  },

  async 'keystrokes'() {
    const { authority, log } = await boot({ attached: true });
    const { host } = authority;
    const pid = log.pid;
    for (const key of ['a', 'b', 'c']) {
      const { seen, made } = await delivered(log, () => host.processes.writeInput(pid, key));
      assert.equal(seen, 'data:v1');
      assert.deepEqual(Object.keys(made), ['cpReadStdin'], `a keystroke is one stdin delivery and no other call (made ${JSON.stringify(made)})`);
    }

    authority.kfs.writeFile(F, 'v2');
    const { seen, made } = await delivered(log, () => host.processes.writeInput(pid, 'x'));
    assert.equal(seen, 'data:v2', 'a keystroke after a peer write reads the write');
    assert.equal(made.fsAcquire, undefined, 'and learns of it from the delivery, not from a round trip');
  },

  async 'a signal after a peer write'() {
    const { authority, log } = await boot({ attached: true });
    authority.kfs.writeFile(F, 'v2');
    const { seen, made } = await delivered(log, () => authority.host.processes.signal(log.pid, 'SIGUSR2'));
    assert.equal(seen, 'signal:v2');
    assert.equal(made.fsAcquire, undefined);
  },

  async 'output and exit of a child that wrote the file'() {
    // The session's own child-process RPCs over a child that writes the file
    // before it prints and before it exits.
    const { log } = await boot({
      children: (auth) => ({
        async spawn() {
          auth.kfs.writeFile(F, 'CHILD');
          return { childPid: 42 };
        },
        async readOutput(_pid, fd, since) {
          return fd === 1 && since === 0
            ? { chunks: [{ seq: 1, data: enc.encode('done\n') }], closed: true, maxSeq: 1 }
            : { chunks: [], closed: true, maxSeq: 0 };
        },
        async wait() { return { done: true, exitCode: 0, signal: null }; },
        stdinEnd() {},
      }),
    });
    const { made } = await callsDuring(log, async () => {
      await globalThis.__spawnWriter();
      await until(() => globalThis.__seen.length === 2, 'the output and exit handlers');
    });
    assert.deepEqual(globalThis.__seen.sort(), ['exit:CHILD', 'stdout:CHILD']);
    assert.equal(made.fsAcquire, undefined, 'the output and the exit carried their own answers');
  },
});

console.log('resident-inbound-coherence: ok');
