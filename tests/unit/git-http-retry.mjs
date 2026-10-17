#!/usr/bin/env bun
// A push's requests under the git layer's transport policy (transport.ts),
// through the client the built-in push speaks (receive-pack.ts): its
// discovery (a GET) is tried again when it fails in transit or is answered
// with a transient edge status, and not for a status that is an answer
// (404); its request for the pack (a POST) is sent once, whatever happens to
// it, as a retried push could apply twice.

import assert from 'node:assert/strict';

import { discoverReceivePack, sendPack } from '../../packages/worker/src/git/pack/receive-pack.ts';
import { RETRY_ATTEMPTS, UploadPackError } from '../../packages/worker/src/git/pack/transport.ts';

const encoder = new TextEncoder();
const pkt = (line) => encoder.encode((line.length + 4).toString(16).padStart(4, '0') + line);
const OID = '1'.repeat(40);
const advertisement = () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(pkt('# service=git-receive-pack\n'));
    controller.enqueue(encoder.encode('0000'));
    controller.enqueue(pkt(OID + ' refs/heads/main\0report-status delete-refs\n'));
    controller.enqueue(encoder.encode('0000'));
    controller.close();
  },
}), { status: 200 });

/** A fetch answering with `outcomes` in turn (an Error is thrown), each request kept. */
function queued(outcomes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const outcome = outcomes[calls.length - 1];
    if (outcome instanceof Error) throw outcome;
    return typeof outcome === 'function' ? outcome() : new Response('edge', { status: outcome });
  };
  return { calls, fetch };
}

const url = 'https://example.invalid/project.git';

{
  const { calls, fetch } = queued([522, advertisement]);
  const discovered = await discoverReceivePack({ url, fetch });
  assert.equal(discovered.refs.get('refs/heads/main'), OID);
  assert.deepEqual(calls.map(({ method }) => method), ['GET', 'GET'], 'a transient status: discovery tried again');
  assert.ok(calls.every(({ url }) => url.endsWith('/info/refs?service=git-receive-pack')));
}
{
  const { calls, fetch } = queued([new Error('connection reset'), advertisement]);
  await discoverReceivePack({ url, fetch });
  assert.equal(calls.length, 2, 'a failure in transit: discovery tried again');
}
{
  const { calls, fetch } = queued([404]);
  await assert.rejects(discoverReceivePack({ url, fetch }), (error) => error instanceof UploadPackError && error.status === 404);
  assert.equal(calls.length, 1, 'a 404 is an answer: not tried again');
}
{
  const { calls, fetch } = queued(Array(RETRY_ATTEMPTS).fill(522));
  await assert.rejects(discoverReceivePack({ url, fetch }), (error) => error instanceof UploadPackError && error.status === 522);
  assert.equal(calls.length, RETRY_ATTEMPTS, 'a transient status each time: every attempt, then the failure');
}

const discovered = await discoverReceivePack({ url, fetch: queued([advertisement]).fetch });
const deletion = { commands: [{ ref: 'refs/heads/main', old: OID, new: '0'.repeat(40) }], pack: null, atomic: false, pushOptions: [] };
{
  const { calls, fetch } = queued([522, 522]);
  await assert.rejects(sendPack({ url, fetch }, discovered, deletion), (error) => error instanceof UploadPackError && error.status === 522);
  assert.deepEqual(calls.map(({ method, url }) => [method, url.slice(url.lastIndexOf('/'))]), [['POST', '/git-receive-pack']], 'the push request: sent once, on a transient status too');
}
{
  const { calls, fetch } = queued([new Error('push connection reset'), 522]);
  await assert.rejects(sendPack({ url, fetch }, discovered, deletion), (error) => error instanceof UploadPackError && /push connection reset/.test(error.message));
  assert.equal(calls.length, 1, 'the push request: sent once, when it fails in transit too');
}

console.log('git-http-retry: ok (a push\'s discovery retried as a GET is; its request for the pack sent once)');
