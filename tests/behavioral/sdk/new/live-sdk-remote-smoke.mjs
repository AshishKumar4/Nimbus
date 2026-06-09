#!/usr/bin/env bun
// sdk/new/live-sdk-remote-smoke — hosted-demo route exercises
// Nimbus.connect against the deployed remote sandbox API.

import { BASE, makeAsserter, requestHeaders } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('sdk/new/live-sdk-remote-smoke');
console.log(`sdk/new/live-sdk-remote-smoke — BASE=${BASE}`);

const r = await fetch(`${BASE}/api/sdk-remote-smoke`, {
  headers: requestHeaders({ 'Cache-Control': 'no-store' }),
});
const body = await r.text();
let json = null;
try { json = JSON.parse(body); } catch {}

a.check('sdk-remote-smoke returns 200', r.status === 200, `status=${r.status} body=${body.slice(0, 200)}`);
a.check('sdk-remote-smoke reports ok true', json?.ok === true, body.slice(0, 200));
a.check('sdk-remote-smoke captured node stdout',
  json?.result?.success === true && json?.result?.stdout === '7\n',
  JSON.stringify(json?.result ?? null));
a.check('sdk-remote-smoke roundtrips binary file bytes',
  Array.isArray(json?.bytes) && json.bytes.join(',') === '0,1,2,255',
  JSON.stringify(json?.bytes ?? null));

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
