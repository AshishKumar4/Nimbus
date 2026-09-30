#!/usr/bin/env bun
// Two review regressions, on real npm installs.
//   - Vite 4 depends on rollup@^3, which is plain JavaScript: it installs as
//     published, not swapped for @rollup/wasm-node (whose registry has 4.x
//     only and used to hand back its latest 4.x). Only the install is proven
//     here: Vite 4's CLI builds `new Function('file', 'return import(file)')`
//     at load, and the plain Function constructor stays native (refused).
//   - Tailwind v3 reads the content files it scans with readFileSync. Those
//     reads are data for the next launch, never modules to execute: rooting
//     them walked App.jsx's imports (react) into the required graph. A Vite + Tailwind v3 app is launched twice and serves both times.
import { Terminal, mintSession, stripAnsi, makeAsserter, deleteSession, heredocCommand, BASE, requestHeaders, sleep } from '../_driver.mjs';
import { launchFrameworkDev } from '../_framework-dev.mjs';
if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('vite4-tailwind3-real');
const V4 = '/home/user/vite4-app', TW = '/home/user/tw3-app', PORT = 5174;
const MARKER = 'tw3-' + Date.now();
const TW_FILES = {
  'package.json': JSON.stringify({
    name: 'tw3-app', private: true, type: 'module',
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
    devDependencies: { vite: '^8.0.0', '@vitejs/plugin-react': '^5.0.0', tailwindcss: '^3.4.0', postcss: '^8.4.0', autoprefixer: '^10.4.0' },
  }, null, 2),
  'vite.config.js': "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
  'tailwind.config.js': "export default { content: ['./index.html', './src/**/*.{js,jsx}'], theme: { extend: {} }, plugins: [] };\n",
  'postcss.config.js': 'export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n',
  'index.html': '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
  'src/index.css': '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n',
  'src/main.jsx': "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './index.css';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
  'src/App.jsx': `import { useState } from 'react';\nexport default function App() { const [n] = useState(0); return <h1 className="text-[#123456] underline">${MARKER} {n}</h1>; }\n`,
};
function tail(s, n = 20) { return stripAnsi(s).split(/\r?\n/).filter(Boolean).slice(-n).join('\n'); }
async function run(t, cmd, timeout) { const r = await t.run(cmd + '; echo "___EXIT=$?___"', timeout); return { code: Number(r.output.match(/___EXIT=(\d+)___/)?.[1] ?? -1), output: stripAnsi(r.output) }; }
async function get(sid, path) {
  const r = await fetch(`${BASE}/s/${sid}/port/${PORT}/${path}`, { headers: requestHeaders(), signal: AbortSignal.timeout(60_000) });
  return { status: r.status, body: await r.text() };
}
const sid = await mintSession(); console.log(`[vite4-tailwind3-real] sid=${sid} BASE=${BASE}`);
const t = new Terminal(sid); let proc;
try {
  await t.connect(); await t.waitForPrompt(60_000);

  await t.run(`mkdir -p ${V4}`, 10_000);
  await t.run(heredocCommand(`${V4}/package.json`, JSON.stringify({ name: 'vite4-app', private: true, devDependencies: { vite: '^4.5.0' } })), 10_000);
  const v4 = await run(t, `cd ${V4} && npm install 2>&1`, 400_000);
  a.check('a Vite 4 app installs', v4.code === 0, tail(v4.output));
  const rollup = await run(t, `cd ${V4} && node -e "const p=require('./node_modules/rollup/package.json');console.log('ROLLUP',p.name,p.version)"`, 60_000);
  a.check('Vite 4 gets the rollup 3 it asked for, not @rollup/wasm-node 4.x', /ROLLUP rollup 3\.\d+\.\d+/.test(rollup.output), tail(rollup.output));

  await t.run(`mkdir -p ${TW}/src`, 10_000);
  for (const [name, text] of Object.entries(TW_FILES)) await t.run(heredocCommand(`${TW}/${name}`, text), 10_000);
  const installed = await run(t, `cd ${TW} && npm install 2>&1`, 400_000);
  a.check('a Vite + Tailwind v3 app installs', installed.code === 0, tail(installed.output));
  if (installed.code !== 0) throw new Error('install failed');
  for (const launch of [1, 2]) {
    const dev = await launchFrameworkDev({
      terminal: t, sid, cwd: TW, command: `./node_modules/.bin/vite --host 0.0.0.0 --port ${PORT}`, port: PORT, maxLaunches: 16,
      accepts: (r) => r.status === 200 && r.body.includes('<div id="root">') && r.body.includes('/@vite/client'),
    });
    proc = dev.process;
    a.check(`launch ${launch}: serves index.html through the port route`, dev.ok, `launches=${dev.attempt}; ${dev.last}\n${tail(dev.output, 30)}`);
    if (!dev.ok) break;
    const css = await get(sid, 'src/index.css');
    a.check(`launch ${launch}: Tailwind v3 generated the utility the scanned content uses`,
      css.status === 200 && css.body.includes('#123456'), css.body.slice(0, 400));
    proc.signal('SIGKILL'); for (let i = 0; i < 30 && !proc.exit; i++) await sleep(100); proc.ws.close(); proc = null;
  }
} finally {
  if (proc) { try { proc.signal('SIGKILL'); proc.ws.close(); } catch {} }
  await t.close(); const d = await deleteSession(sid); a.check('probe session deleted', d.ok, `status=${d.status}`);
}
process.exit(a.summary().fail ? 1 : 0);
