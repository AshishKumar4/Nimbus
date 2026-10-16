#!/usr/bin/env bun
// wrangler/new/wrangler-dev-storage-bindings — a user Worker under `wrangler
// dev` uses its KV, D1 and R2 bindings as on Cloudflare.
//
// Before: a Worker declaring kv_namespaces, d1_databases or r2_buckets did
// not start ("Could not serialize object of type "D1Emulator""). The Worker
// (_storage-bindings-worker.mjs) calls each API's main methods, their
// validation errors included, and a later request reads what the first
// left. Each call's answer is checked against Cloudflare's, which the unit
// test wrangler-dev-storage-bindings-workerd takes from the local bindings
// `wrangler dev` gives a Worker, but for the difference the shared file
// names.
//
// Black-box: the session's terminal and the Worker's URL only.

import { isDeepStrictEqual } from 'node:util';

import { dirname } from 'node:path';
import { deleteSession, makeAsserter, mintSession, requestHeaders, stripAnsi, Terminal, writeFileViaShell } from '../../_driver.mjs';
import { WORKER, WRANGLER_CONFIG, expectedAnswer, nimbusAnswer } from './_storage-bindings-worker.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'wrangler/new/wrangler-dev-storage-bindings';
const a = makeAsserter(label);
console.log(`${label} - ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const write = async (path, content) => {
    await t.run(`mkdir -p ${dirname(path)}`, 10_000);
    return writeFileViaShell((command) => t.run(command, 60_000), path, content);
  };
  await write('/home/user/storage/wrangler.jsonc', JSON.stringify(WRANGLER_CONFIG));
  await write('/home/user/storage/src/index.js', WORKER);
  await t.run('cd /home/user/storage', 10_000);
  t.reset();
  t.cmd('wrangler dev');
  let built = false;
  try {
    await t.waitFor((b) => /Worker built|Failed to start/.test(stripAnsi(b)), 120_000, 'wrangler dev build');
    built = /Worker built/.test(stripAnsi(t.buf));
  } catch { /* checked below */ }
  a.check('wrangler dev builds a Worker with KV, D1 and R2 bindings', built, JSON.stringify(stripAnsi(t.buf).slice(-800)));
  for (const step of built ? [1, 2] : []) {
    const response = await fetch(`${process.env.BASE}/s/${sid}/worker/?step=${step}`, { headers: requestHeaders({}, sid) });
    const body = await response.text();
    let got = null;
    try { got = JSON.parse(body); } catch { /* checked below */ }
    a.check(`step ${step}: the Worker answers`, response.status === 200 && got !== null, `status=${response.status} body=${body.slice(0, 600)}`);
    const expected = nimbusAnswer(expectedAnswer(step));
    // Each call on its own, so a red run names each one that answers otherwise.
    for (const [section, calls] of Object.entries(expected)) {
      if (calls === null || typeof calls !== 'object' || 'value' in calls || 'error' in calls) {
        a.check(`step ${step}: ${section} answers as on Cloudflare`,
          isDeepStrictEqual(got?.[section], calls), `got=${JSON.stringify(got?.[section])} expected=${JSON.stringify(calls)}`);
        continue;
      }
      for (const [call, value] of Object.entries(calls)) {
        a.check(`step ${step}: ${section}.${call} answers as on Cloudflare${(section === 'd1' && call === 'servedBy') || (section === 'r2' && call === 'unknownLength') ? ' (a named difference)' : ''}`,
          isDeepStrictEqual(got?.[section]?.[call], value), `got=${JSON.stringify(got?.[section]?.[call])} expected=${JSON.stringify(value)}`);
      }
    }
  }
  t.send('\x03');
  await t.waitForPrompt(30_000);
} finally {
  await t.close().catch(() => {});
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
