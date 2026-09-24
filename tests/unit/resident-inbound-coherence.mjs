#!/usr/bin/env bun
// Every way the session hands a resident process something to act on is a
// resumption, and must take the ACQUIRE barrier before the program's code
// runs: an HTTP request routed to its port, a chunk on its stdin, a signal,
// output from a child it spawned, the child's exit. Each of those can be the
// second half of a causal chain that starts with a write somewhere else —
// `echo v2 > f; curl :3000`, a child that writes a file and exits — and a
// synchronous read in the handler must see the write that preceded the event.
//
// Each scenario drives the REAL resident body (tests/unit/lib/resident-body.mjs)
// over a real SqliteVFS: a peer changes the file, then the event arrives, and
// the handler reads the file synchronously.

import assert from 'node:assert/strict';
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

/** A session whose f.txt the process holds at 'v1', and the process. */
async function boot(overrides = () => ({}), processEnv = {}) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile(F, 'v1');
  const { supervisor, log } = facetSupervisor(authority, overrides(authority));
  const { proc } = await launchResident({
    program: PROGRAM,
    env: { SUPERVISOR: supervisor },
    processEnv,
    cursor: authority.cursor(),
  });
  return { authority, log, proc };
}

const request = () => new Request('http://facet/', { headers: { 'X-Nimbus-Port': '3000' } });

/** The supervisor's stdin queue for an attached process: packets on demand. */
function stdinQueue() {
  const waiting = [];
  const packets = [];
  return {
    push(packet) {
      const next = waiting.shift();
      if (next) next(packet);
      else packets.push(packet);
    },
    cpReadStdin() {
      if (packets.length > 0) return Promise.resolve(packets.shift());
      const { promise, resolve } = Promise.withResolvers();
      waiting.push(resolve);
      return promise;
    },
  };
}

await runScenarios(import.meta.path, {
  async 'an HTTP request after a peer write'() {
    const { authority, log, proc } = await boot();
    authority.kfs.writeFile(F, 'v2');
    // The shared dispatch every resident's server goes through — the node
    // body's __nimbusDispatchHttp and the opencode runner's __ocDispatchHttp.
    const response = await globalThis.__nimbusServeHttp(request());
    assert.equal(await response.text(), 'v2', 'the handler must run behind a barrier');

    authority.kfs.writeFile(F, 'v3');
    const before = log.calls.fsAcquire ?? 0;
    const routed = await proc.fetch(request());
    const barriers = (log.calls.fsAcquire ?? 0) - before;
    assert.equal(await routed.text(), 'v3');
    assert.equal(barriers, 1, 'a routed request costs exactly one barrier');
  },

  async 'stdin after a peer write'() {
    const stdin = stdinQueue();
    const { authority } = await boot(() => ({ cpReadStdin: stdin.cpReadStdin }), { NIMBUS_CP_CHILD_PID: '7' });
    authority.kfs.writeFile(F, 'v2');
    stdin.push({ data: enc.encode('x') });
    await until(() => globalThis.__seen.length === 1, 'the data handler');
    assert.deepEqual(globalThis.__seen, ['data:v2']);
  },

  async 'a signal after a peer write'() {
    const stdin = stdinQueue();
    const { authority } = await boot(() => ({ cpReadStdin: stdin.cpReadStdin }), { NIMBUS_CP_CHILD_PID: '7' });
    authority.kfs.writeFile(F, 'v2');
    stdin.push({ signal: 'SIGUSR2' });
    await until(() => globalThis.__seen.length === 1, 'the signal handler');
    assert.deepEqual(globalThis.__seen, ['signal:v2']);
  },

  async 'output and exit of a child that wrote the file'() {
    await boot((auth) => ({
      // The child writes the file before it prints and before it exits.
      async cpSpawn() {
        auth.kfs.writeFile(F, 'CHILD');
        return { childPid: 42 };
      },
      async cpReadOutput(_pid, fd, since) {
        return fd === 1 && since === 0
          ? { chunks: [{ seq: 1, data: enc.encode('done\n') }], closed: true }
          : { chunks: [], closed: true };
      },
      async cpWait() { return { done: true, exitCode: 0, signal: null }; },
    }));
    await globalThis.__spawnWriter();
    await until(() => globalThis.__seen.length === 2, 'the output and exit handlers');
    assert.deepEqual(globalThis.__seen.sort(), ['exit:CHILD', 'stdout:CHILD']);
  },
});

console.log('resident-inbound-coherence: ok');
