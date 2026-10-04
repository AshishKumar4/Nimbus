#!/usr/bin/env bun
// agentic-cli/new/node-outbound-websocket — a node program's WebSocket to a
// remote wss:// server opens, sends and receives. Every outbound socket used
// to fail with "Fetch API cannot load: wss://...": the session fetched the
// socket's own URL for the upgrade, and workerd's fetch takes http(s) only.
// Agent CLIs and SDKs (realtime APIs, CDP, dev-server HMR clients) need it.

import {
  deleteSession,
  heredocCommand,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/node-outbound-websocket');

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  // echo.websocket.org greets with one message, then echoes each message sent.
  const script = `
const marker = 'nimbus-echo-' + Date.now();
const ws = new WebSocket('wss://echo.websocket.org/');
const timer = setTimeout(() => { console.log('WS_TIMEOUT'); process.exit(1); }, 30000);
ws.addEventListener('open', () => { console.log('WS_OPEN'); ws.send(marker); });
ws.addEventListener('message', (event) => {
  if (String(event.data) === marker) { console.log('WS_ECHO'); ws.close(1000, 'done'); }
});
ws.addEventListener('close', (event) => { clearTimeout(timer); console.log('WS_CLOSE ' + event.code); });
ws.addEventListener('error', (event) => { console.log('WS_ERROR ' + (event.message || event.error?.message || 'error')); });
`;

  await t.run(heredocCommand('/home/user/ws-probe.js', script), 60_000);
  const run = await t.run('node /home/user/ws-probe.js', 60_000);
  const out = stripAnsi(run.output);

  a.check('the wss:// socket opens', /WS_OPEN/.test(out), JSON.stringify(out.slice(-800)));
  a.check('a message sent comes back', /WS_ECHO/.test(out), JSON.stringify(out.slice(-800)));
  a.check('the socket closes cleanly', /WS_CLOSE 1000/.test(out), JSON.stringify(out.slice(-800)));
  a.check('no fetch scheme refusal', !/Fetch API cannot load/.test(out), JSON.stringify(out.slice(-800)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
