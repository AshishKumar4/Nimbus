#!/usr/bin/env bun
// durable/idle-host-replaced — a call to a process whose idle host the
// platform replaced is not failed for it (Kinu ask 63).
//
// WHAT IT PROVES
//   A Node server serves its port. Its terminal goes away, and the server
//   sits idle until no client holds its host. The platform then puts a fresh
//   instance in place of the server's facet. The next request to the port
//   is answered, by a new process the session starts for it at once; the
//   lost process ended (137). An embedder's own call to its worker, after the
//   same replacement, is refused as ProcessNotAdmitted, the worker's pid
//   already ended, so the embedder may run it once more.
//   Red before: the port answered 502 with "its host was reset by the
//   platform", and the embedder's call failed with ProcessHostLost.

import { BASE, mintSession, deleteSession, Terminal, makeAsserter, requestHeaders, sleep, fetchPort } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('durable/idle-host-replaced');
console.log(`durable/idle-host-replaced — BASE=${BASE}`);
const PORT = 3000;

/** The probe app's embedder route `what` for session `sid`. */
async function embedder(sid, what, body = {}) {
  const response = await fetch(`${BASE}/api/embedder/${sid}/${what}`, {
    method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }, sid), body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${what}: ${response.status} ${text}`);
  return JSON.parse(text);
}

const sessions = [];
try {
  // ── through the port ──────────────────────────────────────────────────
  const sid = await mintSession(); sessions.push(sid);
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.writeFile('/home/user/server.js', `require('http').createServer((q, s) => s.end('alive')).listen(${PORT});\n`);
  const boot = await t.run('node /home/user/server.js', 60_000);
  const pid = t.spawns.filter((event) => event.longRunning && event.command.includes('server.js')).at(-1)?.pid;
  a.check('the server starts', boot.exitCode === 0 && Number.isSafeInteger(pid), boot.output.slice(-300));
  const first = await fetchPort(sid, PORT, '/');
  a.check('it serves its port', first.status === 200 && first.body === 'alive', JSON.stringify(first));
  await t.close();
  // No client: its keep-alive lapses (RESIDENT_KEEPALIVE_DETACHED_MS, 60 s), and nothing holds its host.
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    await embedder(sid, 'host-loss', { action: 'state', pid });
  }
  const replaced = await embedder(sid, 'host-loss', { action: 'facet-replace', pid });
  a.check('the platform replaced its idle facet', typeof replaced.facet === 'string', JSON.stringify(replaced));
  const after = await fetchPort(sid, PORT, '/');
  a.check('the next request to its port is answered', after.status === 200 && after.body === 'alive', JSON.stringify(after));
  const lost = await embedder(sid, 'host-loss', { action: 'state', pid });
  a.check('by a new process: the lost one ended', lost.state === 'exited' && lost.exitCode === 137, JSON.stringify(lost));

  // ── through the embedder's own facet ──────────────────────────────────
  const other = await mintSession(); sessions.push(other);
  const called = await embedder(other, 'not-admitted');
  a.check('the embedder\'s first call is answered', called.first?.status === 200, JSON.stringify(called));
  const refused = called.second ?? {};
  a.check('its call after the replacement is refused as ProcessNotAdmitted',
    /ProcessNotAdmitted|did not take the request/.test(`${refused.name}: ${refused.message}`), JSON.stringify(refused));
  a.check('its worker had ended when it was told', refused.state === 'exited', JSON.stringify(refused));
} catch (error) {
  a.check('the scenario ran', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  for (const sid of sessions) await deleteSession(sid).catch(() => {});
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
