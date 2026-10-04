#!/usr/bin/env bun
// wrangler/new/wrangler-dev-do-rpc — a user Worker under `wrangler dev` calls
// RPC methods on a classic Durable Object binding as on Cloudflare.
//
// AllegedDuck's repro: `await env.P.get(env.P.idFromName('x')).hello()` threw
// "Could not serialize object of type "RpcPromise"". The Worker
// (_do-rpc-worker.mjs) calls methods with arguments and return values, one
// that throws a TypeError, pipelined ones (`stub.info().field`), storage KV
// and SQL across calls and requests, the object's own env, fetch, getByName
// and id round trips; each step's answer is checked against Cloudflare's.
//
// Black-box: the session's terminal and the Worker's URL only.

import { deleteSession, makeAsserter, mintSession, requestHeaders, stripAnsi, Terminal } from '../../_driver.mjs';
import { WORKER, WRANGLER_CONFIG, expectedAnswers } from './_do-rpc-worker.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'wrangler/new/wrangler-dev-do-rpc';
const a = makeAsserter(label);
console.log(`${label} - ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const write = (path, content) => t.run(
    `node -e "require('fs').mkdirSync(require('path').dirname('${path}'),{recursive:true});require('fs').writeFileSync('${path}', Buffer.from('${Buffer.from(content).toString('base64')}','base64'))"`,
    60_000,
  );
  await write('/home/user/do-rpc/wrangler.jsonc', JSON.stringify(WRANGLER_CONFIG));
  await write('/home/user/do-rpc/src/index.js', WORKER);
  await t.run('cd /home/user/do-rpc', 10_000);
  t.reset();
  t.cmd('wrangler dev');
  let built = false;
  try {
    await t.waitFor((b) => /Worker built|\x1b\[31m/.test(b), 120_000, 'wrangler dev build');
    built = /Worker built/.test(stripAnsi(t.buf));
  } catch { /* checked below */ }
  a.check('wrangler dev builds the Worker', built, JSON.stringify(stripAnsi(t.buf).slice(-800)));

  const answer = async () => {
    const response = await fetch(`${process.env.BASE}/s/${sid}/worker/`, { headers: requestHeaders() });
    const body = await response.text();
    try { return { status: response.status, json: JSON.parse(body) }; } catch { return { status: response.status, body: body.slice(0, 600) }; }
  };
  const first = await answer();
  a.check('the Worker answers', first.status === 200 && first.json !== undefined, JSON.stringify(first).slice(0, 600));
  const got = first.json ?? {};
  const expected = expectedAnswers(0);
  for (const [step, value] of Object.entries(expected)) {
    a.check(`${step} answers as on Cloudflare`, JSON.stringify(got[step]) === JSON.stringify(value),
      `got=${JSON.stringify(got[step])} expected=${JSON.stringify(value)}`);
  }
  a.check('a missing method is refused, not a serialization error',
    typeof got.missingMethod?.threw === 'string' && !/RpcPromise/.test(got.missingMethod?.message ?? ''),
    JSON.stringify(got.missingMethod));

  const second = await answer();
  a.check('the object and its storage outlive the request',
    JSON.stringify(second.json?.rows) === '[3,4]' && second.json?.get === 'v1',
    `rows=${JSON.stringify(second.json?.rows)} get=${JSON.stringify(second.json?.get)}`);
  t.send('\x03');
} finally {
  await t.close().catch(() => {});
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
