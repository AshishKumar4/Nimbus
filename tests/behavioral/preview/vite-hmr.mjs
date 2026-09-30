#!/usr/bin/env bun
// Nimbus's existing NIMBUS_REAL_VITE=1 built-in path, not the project's Node
// CLI. Its own HMR bridge must deliver a real Vite update after an app edit.
import WebSocket from 'ws';
import {
  BASE, Terminal, mintSession, deleteSession, makeAsserter, heredocCommand,
  requestHeaders, wsHeaders, sleep,
} from '../_driver.mjs';

if (!process.env.BASE) throw new Error('BASE is required');
const a = makeAsserter('vite-hmr');
const sid = await mintSession();
const root = '/home/user/hmr-app';
const port = 5180;
const url = `${BASE}/s/${sid}/port/${port}/`;
const first = 'hmr-before-' + Date.now();
const second = first + '-edited';
const source = value => `document.querySelector('#app').textContent = ${JSON.stringify(value)};\nif (import.meta.hot) import.meta.hot.accept();\n`;
const terminal = new Terminal(sid);
let socket;
try {
  await terminal.connect();
  await terminal.waitForPrompt(60000);
  await terminal.run(`mkdir -p ${root}/src`, 10000);
  for (const [name, content] of Object.entries({
    'package.json': '{"name":"hmr-app","private":true,"type":"module"}\n',
    'vite.config.js': `export default ${JSON.stringify({ server: { allowedHosts: [new URL(BASE).hostname] } })};\n`,
    'index.html': '<!doctype html><html><body><main id="app"></main><script type="module" src="/src/main.js"></script></body></html>\n',
    'src/main.js': source(first),
  })) await terminal.run(heredocCommand(`${root}/${name}`, content), 10000);
  const started = await terminal.run(`cd ${root} && NIMBUS_REAL_VITE=1 vite --host 0.0.0.0 --port ${port}`, 120000);
  console.log(started.output);
  const get = async path => {
    const response = await fetch(url + path, { headers: requestHeaders(), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.text() };
  };
  const page = await get('');
  a.check('the built-in Vite server serves its application through the port route', page.status === 200 && page.body.includes('id="app"'), page.body.slice(0, 240));
  const before = await get('src/main.js');
  a.check('Vite transforms the self-accepting module', before.status === 200 && before.body.includes(first) && before.body.includes('createHotContext'), before.body.slice(0, 240));

  const messages = [];
  let error = '';
  socket = new WebSocket(url.replace(/^http/, 'ws') + '__nimbus_hmr', ['vite-hmr'], wsHeaders());
  socket.on('message', data => {
    try { messages.push(JSON.parse(String(data))); } catch {}
  });
  socket.on('error', e => { error = e.message; });
  const waitFor = async predicate => {
    const until = Date.now() + 15000;
    while (!predicate() && !error && Date.now() < until) await sleep(100);
    return predicate();
  };
  const connected = await waitFor(() => messages.some(message => message.type === 'connected'));
  a.check('the existing HMR bridge delivers Vite connected', connected, error || JSON.stringify(messages));
  await terminal.run(heredocCommand(root + '/src/main.js', source(second)), 10000);
  const updated = await waitFor(() => messages.some(message => message.type === 'update' && message.updates?.some(update => update.path.endsWith('/src/main.js'))));
  a.check('an edit delivers a real module update over the HMR websocket', updated, error || JSON.stringify(messages));
  const after = await get('src/main.js');
  a.check('the next module request serves rebuilt application content', after.status === 200 && after.body.includes(second), after.body.slice(0, 240));
} finally {
  socket?.close();
  await terminal.close();
  const deleted = await deleteSession(sid);
  a.check('the probe session is deleted', deleted.ok, `status=${deleted.status}`);
}
process.exit(a.summary().fail ? 1 : 0);
