#!/usr/bin/env bun
// A request to a git server names the agent capability only when the
// server advertised its own (gitprotocol-capabilities "agent"; fetch-pack.c
// and send-pack.c), as some servers (AWS CodeCommit) refuse a capability
// they did not offer. The server here is such a one: it answers 400 to a
// request that names one it did not advertise. A fetch's request for a
// pack (upload-pack.ts) and a push (receive-pack.ts, the built-in push's
// client) each go through to it; to a server that advertises an agent, each
// names ours.
//
// Red before: both always named agent=git/nimbus.

import assert from 'node:assert/strict';

import { discover, requestPack } from '../../packages/worker/src/git/pack/upload-pack.ts';
import { discoverReceivePack, sendPack } from '../../packages/worker/src/git/pack/receive-pack.ts';

const encoder = new TextEncoder();
const pkt = (line) => encoder.encode((line.length + 4).toString(16).padStart(4, '0') + line);
const FLUSH = encoder.encode('0000');
const OID = '1'.repeat(40);
const body = (...chunks) => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });

/** The capabilities a request's first pkt-line names, after its NUL (push) or its want and id (fetch). */
function requested(bytes) {
  const length = parseInt(new TextDecoder().decode(bytes.subarray(0, 4)), 16);
  const line = new TextDecoder().decode(bytes.subarray(4, length)).replace(/\n$/, '');
  const nul = line.indexOf('\0');
  return (nul >= 0 ? line.slice(nul + 1) : line.split(' ').slice(2).join(' ')).split(' ').filter(Boolean);
}

/** A smart-HTTP server for `service` that advertises `capabilities` and refuses a request naming any other. */
function server(service, capabilities) {
  const seen = [];
  const fetch = async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(body(pkt(`# service=${service}\n`), FLUSH, pkt(`${OID} refs/heads/main\0${capabilities.join(' ')}\n`), FLUSH), { status: 200 });
    }
    const sent = new Uint8Array(await new Response(init.body).arrayBuffer());
    const named = requested(sent);
    seen.push(named);
    const unoffered = named.filter((capability) => !capabilities.includes(capability) && !(capability.startsWith('agent=') && capabilities.some((offered) => offered.startsWith('agent='))));
    if (unoffered.length > 0) return new Response(`unadvertised capability ${unoffered.join(' ')}\n`, { status: 400, headers: { 'content-type': 'text/plain' } });
    return service === 'git-upload-pack'
      ? new Response(body(pkt('NAK\n'), FLUSH), { status: 200 })
      : new Response(body(pkt('unpack ok\n'), pkt('ok refs/heads/main\n'), FLUSH), { status: 200 });
  };
  return { fetch, seen };
}

const url = 'https://example.invalid/r.git';
const agentOf = (named) => named.find((capability) => capability.startsWith('agent='));

for (const agent of [[], ['agent=git/2.47.0']]) {
  const label = agent.length === 0 ? 'no agent advertised' : 'an agent advertised';

  const uploading = server('git-upload-pack', ['side-band-64k', 'ofs-delta', ...agent]);
  const advertised = await discover({ url, fetch: uploading.fetch });
  const answer = await requestPack({ url, fetch: uploading.fetch }, advertised.capabilities, { wants: [OID] });
  if (answer.pack !== null) for await (const _ of answer.pack) { /* drain */ }
  assert.equal(uploading.seen.length, 1, `${label}: the fetch's request went through`);
  assert.equal(agentOf(uploading.seen[0]), agent.length === 0 ? undefined : 'agent=git/nimbus', `${label}: the fetch's agent`);

  const receiving = server('git-receive-pack', ['report-status', 'delete-refs', ...agent]);
  const target = await discoverReceivePack({ url, fetch: receiving.fetch });
  const report = await sendPack({ url, fetch: receiving.fetch }, target, {
    commands: [{ ref: 'refs/heads/main', old: OID, new: '0'.repeat(40) }], pack: null, atomic: false, pushOptions: [],
  });
  assert.deepEqual(report, { unpack: { ok: true }, refs: [{ ref: 'refs/heads/main', ok: true }] }, `${label}: the push went through`);
  assert.equal(agentOf(receiving.seen[0]), agent.length === 0 ? undefined : 'agent=git/nimbus', `${label}: the push's agent`);
  console.log(`  ok  ${label}: fetch and push name an agent only as the server did`);
}

console.log('git-agent-capability: ok');
