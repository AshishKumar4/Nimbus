#!/usr/bin/env bun
// preview/new/real-vite-react-refresh — `NIMBUS_REAL_VITE=1 vite` on a React
// project whose vite.config uses @vitejs/plugin-react, which Nimbus serves
// from its pre-bundled copy (public/_assets/cirrus-plugin-react.bundle.js).
//
// What a user gets from it:
//   - the page carries the Fast Refresh preamble;
//   - the /@react-refresh runtime it serves treats memo and forwardRef
//     components as components, so editing one refreshes it in place. The
//     bundle once shipped react-refresh reading `type.$typeof` for
//     `type.$$typeof` (a String.replace `$$` pattern), and neither kind was
//     ever refreshed;
//   - a .jsx module comes back with JSX lowered and its component
//     registered for refresh;
//   - an edit to that module arrives as an HMR update.

import WebSocket from 'ws';
import {
  BASE, Terminal, mintSession, deleteSession, makeAsserter, heredocCommand,
  requestHeaders, wsHeaders, sleep,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('preview/new/real-vite-react-refresh');
const sid = await mintSession();
const root = '/home/user/refresh-app';
const port = 5182;
const url = `${BASE}/s/${sid}/port/${port}/`;
const marker = 'refresh-before-' + Date.now();
const app = (text) => [
  "import { memo } from 'react';",
  `const Title = memo(function Title() { return <h1>${text}</h1>; });`,
  'export default function App() { return <main><Title /></main>; }',
  '',
].join('\n');
const terminal = new Terminal(sid);
let socket;
try {
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  await terminal.run(`mkdir -p ${root}/src`, 10_000);
  const files = {
    'package.json': JSON.stringify({ name: 'refresh-app', private: true, type: 'module' }),
    'vite.config.js': [
      "import react from '@vitejs/plugin-react';",
      `export default { plugins: [react()], server: { allowedHosts: [${JSON.stringify(new URL(BASE).hostname)}] } };`,
    ].join('\n'),
    'index.html': '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
    'src/main.jsx': [
      "import { createRoot } from 'react-dom/client';",
      "import App from './App.jsx';",
      "createRoot(document.getElementById('root')).render(<App />);",
    ].join('\n'),
    'src/App.jsx': app(marker),
  };
  for (const [name, content] of Object.entries(files)) {
    await terminal.run(heredocCommand(`${root}/${name}`, content), 10_000);
  }
  const installed = await terminal.run(`cd ${root} && npm install react@18.3.1 react-dom@18.3.1 2>&1`, 300_000);
  a.check('react and react-dom install', installed.exitCode === 0, installed.output.slice(-400));
  const started = await terminal.run(`cd ${root} && NIMBUS_REAL_VITE=1 vite --host 0.0.0.0 --port ${port}`, 180_000);
  console.log(started.output.slice(-600));

  const get = async (path) => {
    const response = await fetch(url + path, { headers: requestHeaders(), signal: AbortSignal.timeout(60_000) });
    return { status: response.status, body: await response.text() };
  };

  const page = await get('');
  a.check('the page carries the Fast Refresh preamble',
    page.status === 200 && page.body.includes('/@react-refresh') && page.body.includes('id="root"'),
    `status=${page.status} ${page.body.slice(0, 300)}`);

  const runtime = await get('@react-refresh');
  a.check('/@react-refresh is served', runtime.status === 200 && runtime.body.includes('performReactRefresh'),
    `status=${runtime.status} ${runtime.body.slice(0, 200)}`);
  if (runtime.status === 200) {
    // Evaluate the runtime as served; it registers on `window`. Vite's import
    // analysis prepends `import { injectQuery as __vite__injectQuery } from
    // "<base>/@vite/client"`, a browser-only helper the runtime never calls
    // here, so that one import is bound to the identity.
    globalThis.window ??= globalThis;
    const source = runtime.body.replace(
      /^import \{ injectQuery as __vite__injectQuery \} from "[^"]*\/@vite\/client";$/m,
      'const __vite__injectQuery = (url) => url;',
    );
    const refresh = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
    const render = () => null;
    const memoType = { $$typeof: Symbol.for('react.memo'), type: render, compare: null };
    const forwardRefType = { $$typeof: Symbol.for('react.forward_ref'), render };
    a.check('the served runtime treats a memo component as a component',
      refresh.isLikelyComponentType(memoType) === true, 'isLikelyComponentType(memo(...)) is false');
    a.check('the served runtime treats a forwardRef component as a component',
      refresh.isLikelyComponentType(forwardRefType) === true, 'isLikelyComponentType(forwardRef(...)) is false');
    a.check('a plain object is not a component', refresh.isLikelyComponentType({ $$typeof: Symbol.for('react.element') }) === false);
  }

  const module = await get('src/App.jsx');
  a.check('App.jsx is served with JSX lowered and its components registered for refresh',
    module.status === 200 && module.body.includes(marker) && module.body.includes('$RefreshReg$')
      && !module.body.includes(`<h1>${marker}`),
    `status=${module.status} ${module.body.slice(0, 400)}`);

  const messages = [];
  let error = '';
  socket = new WebSocket(url.replace(/^http/, 'ws') + '__nimbus_hmr', ['vite-hmr'], wsHeaders());
  socket.on('message', (data) => {
    try { messages.push(JSON.parse(String(data))); } catch { /* not a Vite payload */ }
  });
  socket.on('error', (e) => { error = e.message; });
  const waitFor = async (predicate) => {
    const until = Date.now() + 20_000;
    while (!predicate() && !error && Date.now() < until) await sleep(100);
    return predicate();
  };
  a.check('the HMR websocket connects', await waitFor(() => messages.some((m) => m.type === 'connected')),
    error || JSON.stringify(messages));
  const edited = marker + '-edited';
  await terminal.run(heredocCommand(`${root}/src/App.jsx`, app(edited)), 10_000);
  a.check('an edit to App.jsx arrives as an HMR update',
    await waitFor(() => messages.some((m) => m.type === 'update' && m.updates?.some((u) => u.path.endsWith('/src/App.jsx')))),
    error || JSON.stringify(messages).slice(0, 600));
  const after = await get('src/App.jsx');
  a.check('the next request serves the edited component', after.status === 200 && after.body.includes(edited),
    after.body.slice(0, 300));
} finally {
  socket?.close();
  await terminal.close();
  const deleted = await deleteSession(sid);
  a.check('the probe session is deleted', deleted.ok, `status=${deleted.status}`);
}
process.exit(a.summary().fail ? 1 : 0);
