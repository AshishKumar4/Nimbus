#!/usr/bin/env bun
// process.stdin starts only for a consumer, as in Node.
//
// Vite's dev server (and so Astro's, Nuxt's, Vinext's) registers
// `process.stdin.on("end", closeServerAndExit)` and then does not read stdin.
// In Node that listener receives nothing: paused stdin delivers no 'end', and
// a terminal's stdin never ends. The shim started stdin on ANY listener, so
// the 'end' listener itself delivered EOF and every Vite dev server exited 0
// seconds after it started. A consumer ('data', resume) still gets its data
// and its 'end'; a process with an input channel reads the channel.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

function makeProcess({ stdin = '', env = {}, supervisor = null, liveInputPid } = {}) {
  // A resident process learns its channel from its start payload, which the
  // runner binds as __nimbusLiveInputPid ahead of the shims.
  const live = liveInputPid === undefined ? '' : `const __nimbusLiveInputPid = ${liveInputPid};`;
  const factory = new Function(
    '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', 'stdin',
    '"use strict";let stdout = ""; let stderr = "";' + live + generateShimsCode() + '\n;return { process: __processMod };',
  );
  return factory({}, {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], env, '/home/user/main.mjs', '/home/user', stdin).process;
}
const turn = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// ── an 'end' listener alone receives nothing ────────────────────────────
{
  const proc = makeProcess();
  let ended = false;
  proc.stdin.on('end', () => { ended = true; });
  proc.stdin.once('close', () => { ended = true; });
  await turn();
  assert.equal(ended, false, "an 'end' listener on unread stdin must not receive EOF (Vite would exit 0)");
}

// ── a consumer gets the data and then 'end' ─────────────────────────────
{
  const proc = makeProcess({ stdin: 'piped input' });
  const chunks = [];
  let ended = false;
  proc.stdin.on('end', () => { ended = true; });
  proc.stdin.setEncoding('utf8');
  proc.stdin.on('data', (c) => chunks.push(String(c)));
  await turn();
  assert.deepEqual(chunks, ['piped input']);
  assert.equal(ended, true, 'a consumer of finite stdin sees its end');
}

// ── with an input channel, stdin is the channel: open until it ends ──────
{
  const packets = [{ data: new TextEncoder().encode('typed') }];
  let polls = 0;
  const proc = makeProcess({
    env: { NIMBUS_CP_CHILD_PID: '7' },
    supervisor: {
      cpReadStdin: async () => { polls++; await turn(5); return packets.shift() ?? { data: new Uint8Array(0) }; },
      reportExit: async () => {},
      stderr: async () => {},
    },
  });
  const chunks = [];
  let ended = false;
  proc.stdin.on('end', () => { ended = true; });
  await turn();
  assert.equal(polls, 0, "an 'end' listener alone does not start reading the channel");
  proc.stdin.setEncoding('utf8');
  proc.stdin.on('data', (c) => chunks.push(String(c)));
  await turn(200);
  assert.deepEqual(chunks, ['typed'], 'input typed into the channel arrives');
  assert.equal(ended, false, 'an open channel is an open stdin: no EOF while the process runs');
  packets.push({ ended: true });
  await turn(200);
  assert.equal(ended, true, 'the channel ending ends stdin');
}

// ── a resident's channel comes from its start payload, not its env ──────
{
  const asked = [];
  const proc = makeProcess({
    liveInputPid: 9,
    supervisor: {
      cpReadStdin: async (pid) => { asked.push(pid); await turn(5); return asked.length === 1 ? { data: new TextEncoder().encode('keys') } : { ended: true }; },
      reportExit: async () => {},
      stderr: async () => {},
    },
  });
  const chunks = [];
  proc.stdin.setEncoding('utf8');
  proc.stdin.on('data', (c) => chunks.push(String(c)));
  await turn(200);
  assert.deepEqual(chunks, ['keys'], 'a backgrounded resident reads its own input channel');
  assert.equal(asked[0], 9, 'the channel is the pid from the start payload');
}

console.log('node-shims-stdin-end-listener: ok');
