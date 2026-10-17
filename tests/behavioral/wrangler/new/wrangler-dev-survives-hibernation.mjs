#!/usr/bin/env bun
// wrangler/new/wrangler-dev-survives-hibernation — a running `wrangler dev`
// keeps serving its Worker across a new incarnation of its session, as a
// resident process does: after an instance reset (/api/_diag/abort, the
// deterministic one) and after the session idles out and the platform
// re-creates it (about two minutes idle, measured: every idle session's
// object was re-created within that). It is a process while it runs (`ps`
// lists it), and once stopped it stays stopped, through a reset too. A `vite`
// server in the same session comes back the same way on its preview door.
//
// Red before: the dev server lived only in the session's memory, so the
// Worker's URL answered the "no dev server running" page after either.
//
// Black-box: the session's terminal, its Worker URL and its diagnostics.

import { dirname } from 'node:path';
import { deleteSession, makeAsserter, mintSession, requestHeaders, sleep, stripAnsi, Terminal, writeFileViaShell } from '../../_driver.mjs';
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
const MARKER = 'vite-marker-7b1';
/** The session's preview door: whether it answers the `vite` server's page. */
const preview = async () => {
  const response = await afterReset(() => fetch(`${BASE}/s/${sid}/preview/`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(90_000) }));
  const body = await response.text();
  return { status: response.status, previewed: response.status === 200 && body.includes(MARKER), body: body.slice(0, 200) };
};

let t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const write = async (path, content) => {
    await t.run(`mkdir -p ${dirname(path)}`, 10_000);
    return writeFileViaShell((command) => t.run(command, 60_000), path, content);
  };
  await write('/home/user/idle/wrangler.jsonc', JSON.stringify(CONFIG));
  await write('/home/user/idle/src/index.js', WORKER);
  await write('/home/user/site/index.html', `<!doctype html><title>site</title><p>${MARKER}</p>`);
  await t.run('cd /home/user/site', 10_000);
  t.reset();
  t.cmd('vite --port 5174 --no-install-check');
  await t.waitFor((b) => /Nimbus Vite Dev Server|\u2718|Error/.test(stripAnsi(b)), 60_000, 'vite start');
  await t.waitForPrompt(30_000);
  const previewed = await preview();
  a.check('vite serves its preview', previewed.previewed, JSON.stringify(previewed));
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
  const reset = async (what) => {
    const abort = await fetch(`${BASE}/s/${sid}/api/_diag/abort`, { method: 'POST', headers: requestHeaders({}, sid) });
    a.check(`_diag/abort answers ${what}`, abort.status === 204, `status=${abort.status}`);
    // A request sent right after the 204 can still reach the instance being
    // reset; the reset ends the instance's sockets, so this terminal's close marks it.
    const deadline = Date.now() + 10_000;
    while (!t.closed && Date.now() < deadline) await sleep(50);
    a.check(`${what} ended the instance (its terminal socket dropped)`, t.closed, `closed=${t.closed}`);
  };
  await reset('the reset');
  const afterAbort = await worker('/after-reset');
  a.check('after an instance reset the Worker is served', served(afterAbort, '/after-reset'), JSON.stringify(afterAbort));
  const previewAfterAbort = await preview();
  a.check('after an instance reset the vite preview is served', previewAfterAbort.previewed, JSON.stringify(previewAfterAbort));

  // ── the session idles out and is re-created ──
  const before = await generation();
  await sleep(150_000);
  const afterIdle = await worker('/after-idle');
  const after = await generation();
  a.check('the idle session was re-created (its generation moved)', before !== null && after !== null && after > before, `before=${before} after=${after}`);
  a.check('after the session idled out the Worker is served', served(afterIdle, '/after-idle'), JSON.stringify(afterIdle));
  const previewAfterIdle = await preview();
  a.check('after the session idled out the vite preview is served', previewAfterIdle.previewed, JSON.stringify(previewAfterIdle));

  // ── stopped, it stays stopped ──
  t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  t.reset();
  await t.run('wrangler stop', 30_000);
  a.check('wrangler stop stops it', /Worker dev server stopped/.test(stripAnsi(t.buf)), JSON.stringify(stripAnsi(t.buf).slice(-400)));
  const stopped = await worker('/stopped');
  a.check('a stopped dev server serves nothing', !served(stopped, '/stopped'), JSON.stringify(stopped));
  t.reset();
  await t.run('vite stop', 30_000);
  a.check('vite stop stops it', /Dev server stopped/.test(stripAnsi(t.buf)), JSON.stringify(stripAnsi(t.buf).slice(-400)));
  await reset('the second reset');
  const afterStoppedReset = await worker('/stopped-reset');
  a.check('a stopped dev server is not brought back by a reset', !served(afterStoppedReset, '/stopped-reset'), JSON.stringify(afterStoppedReset));
  const previewAfterStoppedReset = await preview();
  a.check('a stopped vite is not brought back by a reset', !previewAfterStoppedReset.previewed, JSON.stringify(previewAfterStoppedReset));
} finally {
  await t.close().catch(() => {});
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
