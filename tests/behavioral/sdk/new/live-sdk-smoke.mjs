#!/usr/bin/env bun
// sdk/new/live-sdk-smoke — hosted-demo route exercises
// @nimbus-sh/sdk against the deployed NIMBUS_SESSION binding.

import { BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('sdk/new/live-sdk-smoke');
console.log(`sdk/new/live-sdk-smoke — BASE=${BASE}`);

const r = await fetch(`${BASE}/api/sdk-smoke`, {
  headers: { 'Cache-Control': 'no-store' },
});
const body = await r.text();
let json = null;
try { json = JSON.parse(body); } catch {}

a.check('sdk-smoke returns 200', r.status === 200, `status=${r.status} body=${body.slice(0, 200)}`);
a.check('sdk-smoke reports ok true', json?.ok === true, body.slice(0, 200));
a.check('sdk-smoke captured node stdout',
  json?.result?.success === true && json?.result?.stdout === '4\n',
  JSON.stringify(json?.result ?? null));

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
