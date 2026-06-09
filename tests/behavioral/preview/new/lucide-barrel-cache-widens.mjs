#!/usr/bin/env bun
// preview/new/lucide-barrel-cache-widens — large barrel module caches are
// invalidated when user source imports additional named exports.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi, BASE, requestHeaders } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'preview/new/lucide-barrel-cache-widens';
const a = makeAsserter(label);
console.log(`${label} — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const setupJs = `
const fs = require('fs');
const root = '/home/user/lucide-cache-probe';
const pkgRoot = root + '/node_modules/lucide-react';
fs.mkdirSync(root + '/src', { recursive: true });
fs.mkdirSync(pkgRoot + '/dist/esm/icons', { recursive: true });
fs.writeFileSync(root + '/package.json', JSON.stringify({
  name: 'lucide-cache-probe',
  type: 'module',
  scripts: { dev: 'vite --host 0.0.0.0 --port 5173' }
}, null, 2));
fs.writeFileSync(root + '/index.html', '<div id="root"></div><script type="module" src="/src/main.js"></script>\\n');
fs.writeFileSync(pkgRoot + '/package.json', JSON.stringify({
  name: 'lucide-react',
  version: '0.0.0',
  type: 'module',
  module: './dist/esm/lucide-react.js',
  exports: { '.': { import: './dist/esm/lucide-react.js' } },
  sideEffects: false
}, null, 2));
fs.writeFileSync(pkgRoot + '/dist/esm/lucide-react.js', [
  "export { default as Home } from './icons/home.js';",
  "export { default as AlertTriangle } from './icons/alert-triangle.js';",
  ''
].join('\\n'));
fs.writeFileSync(pkgRoot + '/dist/esm/icons/home.js', "export default function Home(){ return 'HOME_ICON'; }\\n");
fs.writeFileSync(pkgRoot + '/dist/esm/icons/alert-triangle.js', "export default function AlertTriangle(){ return 'ALERT_TRIANGLE_ICON'; }\\n");
for (let i = 0; i < 1600; i++) {
  fs.writeFileSync(pkgRoot + '/dist/esm/icons/dummy-' + i + '.js', 'export default ' + i + ';\\n');
}
fs.writeFileSync(root + '/src/main.js', [
  "import { Home } from 'lucide-react';",
  "document.getElementById('root').textContent = Home();",
  ''
].join('\\n'));
`;

await t.run('mkdir -p /home/user/lucide-cache-probe', 10_000);
await t.run(heredocCommand('/home/user/lucide-cache-probe/setup.js', setupJs), 30_000);
await t.run('node /home/user/lucide-cache-probe/setup.js', 120_000);
await t.run('cd /home/user/lucide-cache-probe', 10_000);

t.reset();
t.cmd('vite --host 0.0.0.0 --port 5173');
await t.waitFor((b) => /Nimbus Vite Dev Server|Preview:|Local:|started \(long-running\)/i.test(b), 60_000, 'vite ready');

async function fetchModule() {
  const url = `${BASE}/s/${sid}/preview/@modules/lucide-react`;
  const r = await fetch(url, { redirect: 'manual', headers: requestHeaders() });
  const code = await r.text();
  return { status: r.status, code };
}

{
  const first = await fetchModule();
  a.check('initial barrel bundle serves Home',
    first.status === 200 && /HOME_ICON/.test(first.code),
    `status=${first.status} tail=${JSON.stringify(first.code.slice(-800))}`);
  a.check('initial barrel bundle is still narrow',
    !/ALERT_TRIANGLE_ICON/.test(first.code),
    JSON.stringify(first.code.slice(-800)));
}

await t.run(heredocCommand('/home/user/lucide-cache-probe/src/main.js', [
  "import { Home, AlertTriangle } from 'lucide-react';",
  "document.getElementById('root').textContent = Home() + ':' + AlertTriangle();",
  ''
].join('\n')), 30_000);

{
  const second = await fetchModule();
  a.check('barrel bundle widens after source imports AlertTriangle',
    second.status === 200 && /HOME_ICON/.test(second.code) && /ALERT_TRIANGLE_ICON/.test(second.code),
    `status=${second.status} tail=${JSON.stringify(second.code.slice(-1200))}`);
  a.check('widened bundle does not report a missing export',
    !/MISSING.*AlertTriangle/.test(second.code),
    JSON.stringify(second.code.slice(-1200)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
