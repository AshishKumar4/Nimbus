#!/usr/bin/env bun
// wrangler/new/wrangler-dev-do-rpc — a user Worker under `wrangler dev` calls
// RPC methods on a classic Durable Object binding as on Cloudflare.
//
// AllegedDuck's repro: `await env.P.get(env.P.idFromName('x')).hello()` threw
// "Could not serialize object of type "RpcPromise"". The Workers
// (_do-rpc-worker.mjs) call every part of a stub's RPC surface: methods with
// arguments and answers, a thrown error, pipelining, storage KV and SQL
// across calls and requests, the object's env, getters and paths through
// them, the namespace, ids and stubs as objects, RpcTargets, stubs and
// functions passed and returned, streams and responses, dup, dispose and
// `using`, Worker Loader envs, and default exports of other shapes. Each
// step's answer is checked against Cloudflare's, which the unit test
// wrangler-dev-do-rpc-workerd takes from plain workerd, but for the
// differences the shared file names.
//
// Black-box: the session's terminal and the Worker's URL only.

import { deleteSession, makeAsserter, mintSession, requestHeaders, stripAnsi, Terminal } from '../../_driver.mjs';
import {
  NIMBUS_DIFFERS, SHAPED_WORKERS, WORKER, WRANGLER_CONFIG, expectedAnswers, expectedShapedAnswer,
} from './_do-rpc-worker.mjs';

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
  const answer = async () => {
    const response = await fetch(`${process.env.BASE}/s/${sid}/worker/`, { headers: requestHeaders() });
    const body = await response.text();
    try { return { status: response.status, json: JSON.parse(body) }; } catch { return { status: response.status, body: body.slice(0, 600) }; }
  };
  /** Starts `wrangler dev` on `source`, answers `requests` GETs, then stops it. */
  const underNimbus = async (label, source, requests) => {
    await write('/home/user/do-rpc/src/index.js', source);
    t.reset();
    t.cmd('wrangler dev');
    let built = false;
    try {
      await t.waitFor((b) => /Worker built|Failed to start/.test(stripAnsi(b)), 120_000, 'wrangler dev build');
      built = /Worker built/.test(stripAnsi(t.buf));
    } catch { /* checked below */ }
    a.check(`wrangler dev builds the ${label} Worker`, built, JSON.stringify(stripAnsi(t.buf).slice(-800)));
    const answers = [];
    while (built && answers.length < requests) answers.push(await answer());
    t.send('\x03');
    await t.waitForPrompt(30_000).catch(() => {});
    return answers;
  };

  await write('/home/user/do-rpc/wrangler.jsonc', JSON.stringify(WRANGLER_CONFIG));
  await t.run('cd /home/user/do-rpc', 10_000);
  const [first, second] = await underNimbus('RPC', WORKER, 2);
  a.check('the Worker answers', first?.status === 200 && first.json !== undefined, JSON.stringify(first).slice(0, 600));
  const got = first?.json ?? {};
  for (const [step, value] of Object.entries({ ...expectedAnswers(0), ...NIMBUS_DIFFERS })) {
    a.check(`${step} answers as on Cloudflare${step in NIMBUS_DIFFERS ? ' (a named difference)' : ''}`,
      JSON.stringify(got[step]) === JSON.stringify(value), `got=${JSON.stringify(got[step])} expected=${JSON.stringify(value)}`);
  }
  a.check('the object and its storage outlive the request',
    JSON.stringify(second?.json?.rows) === '[3,4]' && second?.json?.get === 'v1',
    `rows=${JSON.stringify(second?.json?.rows)} get=${JSON.stringify(second?.json?.get)}`);
  for (const [shape, source] of Object.entries(SHAPED_WORKERS)) {
    const [shaped] = await underNimbus(shape, source, 1);
    a.check(`the ${shape} default export runs, its env's namespace working`,
      JSON.stringify(shaped?.json) === JSON.stringify(expectedShapedAnswer(shape)), JSON.stringify(shaped).slice(0, 400));
  }
} finally {
  await t.close().catch(() => {});
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
