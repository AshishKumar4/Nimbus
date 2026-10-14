#!/usr/bin/env bun
// wrangler/new/wrangler-dev-survives-hibernation — a running `wrangler dev`
// keeps serving its Worker across a new incarnation of its session, as a
// resident process does: after an instance reset (/api/_diag/abort, the
// deterministic one) and after the session idles out and the platform
// re-creates it (about two minutes idle, measured: every idle session's
// object was re-created within that). It is a process while it runs (`ps`
// lists it), and once stopped it stays stopped, through a reset too.
//
// Red before: the dev server lived only in the session's memory, so the
// Worker's URL answered the "no dev server running" page after either.
//
// Black-box: the session's terminal, its Worker URL and its diagnostics.

import { deleteSession, makeAsserter, mintSession, requestHeaders, sleep, stripAnsi, Terminal } from '../../_driver.mjs';
import { afterReset } from '../../durable/_reset-window.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const BASE = process.env.BASE;
const label = 'wrangler/new/wrangler-dev-survives-hibernation';
const a = makeAsserter(label);
console.log(`${label} - ${BASE}`);

const WORKER = 'export default { async fetch(request) { return new Response("served by " + new URL(request.url).pathname); } };\n';
const CONFIG = { name: 'idle-worker', main: 'src/index.js', compatibility_date: '2025-09-01' };

const sid = await mintSession();
console.log(`SID: ${sid}`);
/** The Worker's answer to `path`, or what the session answered in its place. */
const worker = async (path) => {
  const response = await afterReset(() => fetch(`${BASE}/s/${sid}/__nimbus/worker${path}`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(90_000) }));
  return { status: response.status, body: (await response.text()).slice(0, 300) };
};
const generation = async () => {
  const response = await afterReset(() => fetch(`${BASE}/s/${sid}/api/_diag/memory`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(30_000) }));
  return (await response.json()).hib?.isolateGen ?? null;
};
const served = (answer, path) => answer.status === 200 && answer.body === `served by ${path}`;

let t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const write = (path, content) => t.run(
    `node -e "require('fs').mkdirSync(require('path').dirname('${path}'),{recursive:true});require('fs').writeFileSync('${path}', Buffer.from('${Buffer.from(content).toString('base64')}','base64'))"`,
    60_000,
  );
  await write('/home/user/idle/wrangler.jsonc', JSON.stringify(CONFIG));
  await write('/home/user/idle/src/index.js', WORKER);
  await t.run('cd /home/user/idle', 10_000);
  t.reset();
  t.cmd('wrangler dev');
  await t.waitFor((b) => /Worker built|Failed to start/.test(stripAnsi(b)), 120_000, 'wrangler dev build');
  await t.waitForPrompt(30_000);
  a.check('wrangler dev serves the Worker', served(await worker('/one'), '/one'));
  t.reset();
  await t.run('ps', 10_000);
  a.check('the dev server is a process while it runs', /wrangler dev/.test(stripAnsi(t.buf)), JSON.stringify(stripAnsi(t.buf).slice(-600)));

  // ── an instance reset ──
  const abort = await fetch(`${BASE}/s/${sid}/api/_diag/abort`, { method: 'POST', headers: requestHeaders({}, sid) });
  a.check('_diag/abort answers the reset', abort.status === 204, `status=${abort.status}`);
  const afterAbort = await worker('/after-reset');
  a.check('after an instance reset the Worker is served', served(afterAbort, '/after-reset'), JSON.stringify(afterAbort));

  // ── the session idles out and is re-created ──
  const before = await generation();
  t.close();
  await sleep(150_000);
  const afterIdle = await worker('/after-idle');
  const after = await generation();
  a.check('the idle session was re-created (its generation moved)', before !== null && after !== null && after > before, `before=${before} after=${after}`);
  a.check('after the session idled out the Worker is served', served(afterIdle, '/after-idle'), JSON.stringify(afterIdle));

  // ── stopped, it stays stopped ──
  t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  t.reset();
  await t.run('wrangler stop', 30_000);
  a.check('wrangler stop stops it', /Worker dev server stopped/.test(stripAnsi(t.buf)), JSON.stringify(stripAnsi(t.buf).slice(-400)));
  const stopped = await worker('/stopped');
  a.check('a stopped dev server serves nothing', !served(stopped, '/stopped'), JSON.stringify(stopped));
  const again = await fetch(`${BASE}/s/${sid}/api/_diag/abort`, { method: 'POST', headers: requestHeaders({}, sid) });
  a.check('_diag/abort answers the second reset', again.status === 204, `status=${again.status}`);
  const afterStoppedReset = await worker('/stopped-reset');
  a.check('a stopped dev server is not brought back by a reset', !served(afterStoppedReset, '/stopped-reset'), JSON.stringify(afterStoppedReset));
} finally {
  t.close();
  await deleteSession(sid);
}
a.done();
