#!/usr/bin/env bun
// The SDK resolves a relative exec `cwd` against the sandbox root before the
// wire ever sees it.
//
// The session shell only understands absolute POSIX paths, but the SDK
// forwarded `cwd` verbatim: `box.exec('pwd', { cwd: 'rel' })` printed `rel`
// and `npm install` under it failed every write with ENOENT. The fix lives
// at the SDK boundary — this test drives `Nimbus.connect` with a stub fetch
// and inspects the `cwd` each RPC body carries.

import assert from 'node:assert/strict';
import { Nimbus } from '../../packages/sdk/src/sandbox.ts';
import { EXEC_STREAM_CONTENT_TYPE, createExecStream, encodeExecStream } from '../../packages/core/src/runtime/exec-stream.ts';

const EXEC_EXIT = {
  command: 'pwd',
  exitCode: 0,
  success: true,
  duration: 0,
  timestamp: 0,
};

const START_RESULT = {
  command: 'pwd', pid: 7, startedAt: 0,
  process: {
    pid: 7, command: 'pwd', argv: ['pwd'], cwd: '/home/user/rel',
    state: 'running', exitCode: null, startTime: 0, endTime: null,
    longRunning: true, attachedTty: false,
  },
  ports: [],
};

// A remote-target sandbox whose HTTP layer records the decoded RPC body of
// every call. `calls[i]` is `{ op, args, … }` as the session would see it.
function connectSpy(sandboxOptions) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.op === 'execStream') {
      const writer = createExecStream(() => {});
      writer.end(EXEC_EXIT);
      return new Response(encodeExecStream(writer.stream), {
        status: 200,
        headers: { 'content-type': EXEC_STREAM_CONTENT_TYPE },
      });
    }
    const result = body.op === 'ready'
      ? { ok: true, preinstalled: [] }
      : START_RESULT;
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const box = Nimbus.connect({ endpoint: 'https://nimbus.test', fetch })
    .sandbox('s1', sandboxOptions);
  return { calls, box };
}

// `exec` leaves one `ready` call ahead of the real op; the last call is ours.
async function cwdSentToWire({ calls, box }, options) {
  const result = await box.exec('pwd', options);
  assert.equal(result.exitCode, 0);
  return calls.at(-1).args[1].cwd;
}

{
  const spy = connectSpy();
  assert.equal(await cwdSentToWire(spy, { cwd: 'rel' }), '/home/user/rel',
    'a bare relative cwd resolves under the sandbox root');
  assert.equal(await cwdSentToWire(spy, { cwd: './rel' }), '/home/user/rel',
    "'./' collapses");
  assert.equal(await cwdSentToWire(spy, { cwd: '../x' }), '/home/x',
    "'..' climbs out of the sandbox root, POSIX-style");
  assert.equal(await cwdSentToWire(spy, { cwd: 'a/b/../c' }), '/home/user/a/c',
    "interior '..' collapses too");
  assert.equal(await cwdSentToWire(spy, { cwd: '/abs/path' }), '/abs/path',
    'an absolute cwd passes through verbatim');
  assert.equal(await cwdSentToWire(spy, {}), '/home/user',
    'omitted still defaults to the sandbox root');
}

// The sandbox `root` option is the base a relative cwd resolves against.
{
  const spy = connectSpy({ root: '/work' });
  assert.equal(await cwdSentToWire(spy, { cwd: 'rel' }), '/work/rel');
}

// A named shell owns its cwd; a relative one resolves the same way and
// shellRoot still tags along to seed a fresh shell.
{
  const spy = connectSpy();
  await spy.box.exec('pwd', { cwd: 'rel', shellId: 'agent-1' });
  const sent = spy.calls.at(-1).args[1];
  assert.equal(sent.cwd, '/home/user/rel');
  assert.equal(sent.shellRoot, '/home/user');
  assert.equal(sent.shellId, 'agent-1');
}

// startProcess goes through the same normalization.
{
  const spy = connectSpy();
  await spy.box.startProcess('pwd', { cwd: 'rel' });
  assert.equal(spy.calls.at(-1).args[1].cwd, '/home/user/rel',
    'startProcess resolves a relative cwd identically');
}

console.log('sdk exec cwd: ok');
