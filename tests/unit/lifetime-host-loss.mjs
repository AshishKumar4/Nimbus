#!/usr/bin/env bun
// A lifetime run (its start IS the process: an opencode TUI, a server)
// ends as host-lost when the platform resets its host, as a boot resident
// does, whether the start says so or the host's loss signal does; its own
// stop is never that. And a journaling resident's held() watch counts only
// a platform reset as its loss, from its creation. Red before: a lifetime
// handle awaited only its start, so a loss the host signalled while the
// start was pending never reached it, and a reset its start reported was a
// plain error (exit 1, not 137).

import assert from 'node:assert/strict';
import { ProcessFabric, ProcessHostLost } from '../../packages/fabric/src/process-fabric.ts';

const RESET = "Durable Object's isolate exceeded its memory limit and was reset.";

/** A host whose one process the test settles: its start and its loss signal. */
function hostOf() {
  const started = Promise.withResolvers();
  const lost = Promise.withResolvers();
  started.promise.catch(() => {});
  lost.promise.catch(() => {});
  return {
    started, lost,
    host: {
      async open() {
        return {
          started: started.promise,
          lost: lost.promise,
          handleHttpRequest: async () => new Response('ok'),
          handleWebSocketRequest: async () => new Response(null, { status: 426 }),
          release: async () => {},
        };
      },
    },
  };
}

async function lifetime(host) {
  const fabric = new ProcessFabric(host);
  return fabric.startResidentProcess({
    startContract: 'lifetime', pid: 7, workerKey: 'w', boot: { kind: 'code', code: {} },
    onWriterActivated: () => {}, onWriterRetired: () => {},
  });
}

const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

{
  const h = hostOf();
  const handle = await lifetime(h.host);
  h.lost.reject(new ProcessHostLost(new Error(RESET)));
  const end = await Promise.race([settled(handle.done), new Promise((resolve) => setTimeout(() => resolve('pending'), 200))]);
  assert.notEqual(end, 'pending', 'a loss the host signalled while the start was pending never reached the handle');
  assert.ok(end.error instanceof ProcessHostLost);
}
{
  const h = hostOf();
  const handle = await lifetime(h.host);
  h.started.reject(new Error(RESET));
  const end = await settled(handle.done);
  assert.ok(end.error instanceof ProcessHostLost, `a reset the start reported ended the run as ${end.error}`);
}
{
  const h = hostOf();
  const handle = await lifetime(h.host);
  const stop = Object.assign(new Error('nimbus-stop:{"run":1}'), { stop: true });
  h.started.reject(stop);
  const end = await settled(handle.done);
  assert.equal(end.error, stop, 'the run\'s own stop was taken for a lost host');
}

console.log('lifetime-host-loss: ok');
