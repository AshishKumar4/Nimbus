// @serial
// A node program in a session whose workspace goes out through an egress
// (apps/probe's TestEgress, NIMBUS_TEST_EGRESS=1): every common HTTPS client
// reaches the egress, which alone answers egress-test.invalid: https.get,
// http.get, global fetch, node-fetch 3, undici (fetch and request), the
// global WebSocket over wss and the shell's curl. A TLS socket (tls.connect)
// is refused by name. No common client ends on tls.connect: axios and the
// `ws` package fail in a node child before any request, exactly as they do
// without an egress (measured on main: axios asks workerd for a cache mode it
// refuses; ws needs https's createConnection, which workerd does not
// implement), and the test holds them to that, so the egress breaks none of
// them. (node-fetch 3's body reads empty in a child with or without an
// egress: its request is checked by its status, from a host only the egress
// answers.)
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change. Needs the npm registry
// (the session installs the clients, through the egress, which passes it on).
import assert from 'node:assert/strict';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const CLIENTS = String.raw`
const results = {};
const t = async (name, run) => {
  try { results[name] = String(await run()).trim().slice(0, 120); }
  catch (error) { results[name] = 'FAILED ' + (error && (error.code || '')) + ' ' + String(error && error.message).slice(0, 160); }
};
const host = 'egress-test.invalid';
const get = (mod, url) => new Promise((resolve, reject) => {
  mod.get(url, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve(body)); }).on('error', reject);
});
(async () => {
  await t('https.get', () => get(require('https'), 'https://' + host + '/https-get'));
  await t('http.get', () => get(require('http'), 'http://' + host + '/http-get'));
  await t('fetch', async () => (await fetch('https://' + host + '/fetch')).text());
  await t('axios', async () => (await require('axios').get('https://' + host + '/axios')).data);
  await t('node-fetch', async () => {
    const res = await (await import('node-fetch')).default('https://' + host + '/node-fetch');
    return res.status + ' ' + res.headers.get('x-nimbus-test-egress');
  });
  await t('ws', () => new Promise((resolve, reject) => {
    const ws = new (require('ws'))('wss://' + host + '/ws-package');
    ws.on('open', () => ws.send('hi'));
    ws.on('message', (data) => { resolve(String(data)); ws.close(); });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 20000);
  }));
  await t('undici.fetch', async () => (await require('undici').fetch('https://' + host + '/undici-fetch')).text());
  await t('undici.request', async () => (await require('undici').request('https://' + host + '/undici-request')).body.text());
  await t('WebSocket', () => new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://' + host + '/ws');
    ws.addEventListener('open', () => ws.send('hi'));
    ws.addEventListener('message', (event) => { resolve(String(event.data)); ws.close(); });
    ws.addEventListener('error', () => reject(new Error('websocket error')));
    setTimeout(() => reject(new Error('websocket timeout')), 20000);
  }));
  await t('tls.connect', () => new Promise((resolve, reject) => {
    const socket = require('tls').connect(443, host, { servername: host }, () => { resolve('connected'); socket.destroy(); });
    socket.on('error', reject);
    setTimeout(() => reject(new Error('tls timeout')), 20000);
  }));
  console.log('RESULTS ' + JSON.stringify(results));
})();
`;

const egressed = process.env.NIMBUS_TEST_EGRESS ?? '1';
console.log(`workspace-egress-node-clients-workerd: starting local workerd (NIMBUS_TEST_EGRESS=${egressed})`);
const probe = await startLocalProbe({ runtimes: [], vars: { NIMBUS_TEST_EGRESS: egressed } });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const setup = await terminal.run('mkdir -p /home/user/clients && cd /home/user/clients && npm init -y >/dev/null && npm install axios@1 node-fetch@3 undici@6 ws@8', 600_000);
    assert.equal(setup.status, 0, 'npm install through the egress:\n' + setup.stdout.slice(-1200));

    const curl = await terminal.run('curl -s https://egress-test.invalid/curl');
    assert.match(curl.stdout, /via-egress GET \/curl/, 'curl did not reach the egress:\n' + curl.stdout);

    const b64 = Buffer.from(CLIENTS).toString('base64');
    const w = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/clients/clients.js', Buffer.from('${b64}', 'base64'))"`);
    assert.equal(w.status, 0, w.stdout);
    const run = await terminal.run('cd /home/user/clients && node clients.js', 180_000);
    const line = run.stdout.split('\n').find((l) => l.startsWith('RESULTS '));
    assert.ok(line, 'no results:\n' + run.stdout.slice(-1500));
    const results = JSON.parse(line.slice('RESULTS '.length));
    for (const [name, value] of Object.entries(results)) console.log(`  ${name}: ${value}`);

    const expected = {
      'https.get': /^via-egress GET \/https-get$/,
      'http.get': /^via-egress GET \/http-get$/,
      fetch: /^via-egress GET \/fetch$/,
      // As without an egress: refused before any request, never at a TLS socket.
      axios: /^FAILED .*Unsupported cache mode: default$/,
      // A 200 from a host only the egress answers (its headers and body read empty in a child either way).
      'node-fetch': /^200 /,
      ws: /^FAILED ERR_OPTION_NOT_IMPLEMENTED The options\.createConnection option is not implemented$/,
      'undici.fetch': /^via-egress GET \/undici-fetch$/,
      'undici.request': /^via-egress GET \/undici-request$/,
      WebSocket: /^via-egress:hi$/,
      'tls.connect': /^FAILED ERR_NIMBUS_EGRESS_TLS Nimbus: TLS sockets are not available when the workspace's network goes through an egress/,
    };
    for (const [name, pattern] of Object.entries(expected)) assert.match(results[name] ?? '(missing)', pattern, name);
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - workspace-egress-node-clients-workerd (every common HTTPS client goes out through the egress; a TLS socket is refused by name)');
