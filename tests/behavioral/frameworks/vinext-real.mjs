#!/usr/bin/env bun
// frameworks/vinext-real — a minimal Next.js App Router app on Vinext 1.0
// (Next.js on Vite 8) under Nimbus: `vinext dev` serves the page through the
// public port route.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   app/layout.tsx + app/page.tsx + the vite.config.ts `vinext init` writes,
//   package.json with vinext + vite@8 + react
//   npm install
//   npx vinext dev --port 3000
//
// Current boundary (the serve check is expected RED until it moves): Vite 8
// and rolldown load and run (Nimbus answers rolldown's binding with its
// staged single-threaded wasm32-wasip1 build), but `vinext dev` loads
// vite.config.ts the way the Vite CLI does — bundled to
// node_modules/.vite-temp and import()ed — and renders through Vite's RSC/SSR
// module runner (`new AsyncFunction`): runtime code generation a Worker
// refuses outside module evaluation. The evidence line records the log tail.

import {
  Terminal, mintSession, stripAnsi, makeAsserter, deleteSession, fetchPort,
  connectProcessTerminal, sleep, BASE, heredocCommand,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('vinext-real');

const PORT = 3000;
const APP = '/home/user/vinext-probe';
const MARKER = `vinext-on-nimbus-${Date.now()}`;
const FILES = {
  'package.json': JSON.stringify({
    name: 'vinext-probe', private: true, type: 'module',
    scripts: { dev: 'vinext dev' },
    dependencies: {
      vinext: '^1.0.0', vite: '^8.0.0', react: '^19.2.6', 'react-dom': '^19.2.6',
      '@vitejs/plugin-rsc': '^0.5.34', '@vitejs/plugin-react': '^5.1.4', 'react-server-dom-webpack': '^19.2.6',
    },
  }, null, 2),
  'app/layout.tsx': 'export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n',
  'app/page.tsx': `export default function Page() {\n  return <h1>${MARKER}</h1>;\n}\n`,
  // What `vinext init` writes: vinext refuses to start without a Vite config.
  'vite.config.ts': "import { defineConfig } from 'vite';\nimport vinext from 'vinext';\n\nexport default defineConfig({ plugins: [vinext()] });\n",
};

async function run(t, cmd, timeoutMs) {
  const r = await t.run(`${cmd}; echo "___EXIT=$?___"`, timeoutMs);
  const m = r.output.match(/___EXIT=(\d+)___/);
  return { exit: m ? Number(m[1]) : null, output: stripAnsi(r.output), elapsed: r.elapsed };
}

function tail(text, lines) {
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join('\n');
}

const sid = await mintSession();
console.log(`[vinext-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
let proc = null;
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await run(t, `mkdir -p ${APP}/app && cd ${APP}`, 10_000);
  for (const [path, content] of Object.entries(FILES)) await t.run(heredocCommand(`${APP}/${path}`, content), 15_000);
  const ins = await run(t, `cd ${APP} && npm install 2>&1`, 400_000);
  console.log(`[vinext-real] install exit=${ins.exit}\n${tail(ins.output, 6)}`);
  a.check('npm install exits 0', ins.exit === 0, tail(ins.output, 20));
  if (ins.exit !== 0) throw new Error('npm install failed');
  a.check('npm install refuses neither rolldown nor its wasm binding',
    !/note:\s*(rolldown|@rolldown\/binding-wasm32-wasi) has no Workers-compatible build/.test(ins.output), tail(ins.output, 20));

  const launch = await t.run(`cd ${APP} && npx vinext dev --port ${PORT}`, 120_000);
  const launchOut = stripAnsi(launch.output);
  const pid = Number((launchOut.match(/pid=(\d+)/) || [])[1] || 0);
  a.check('vinext dev starts as a long-running process', pid > 0, JSON.stringify(launchOut.slice(-600)));
  if (!(pid > 0)) throw new Error('vinext dev did not start');
  proc = await connectProcessTerminal(sid, pid);
  let served = null;
  let last = 'no response';
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline && !served && !proc.exit) {
    const r = await fetchPort(sid, PORT).catch((e) => ({ status: 0, body: String(e.message) }));
    last = `status=${r.status} body=${JSON.stringify(r.body.slice(0, 200))}`;
    if (r.status === 200 && r.body.includes(MARKER)) served = r;
    else await sleep(1_000);
  }
  const evidence = `exit=${JSON.stringify(proc.exit)} last ${last}\n--- vinext dev log (pid ${pid}) ---\n${tail(proc.output, 40)}`;
  console.log(`[vinext-real] ${evidence}`);
  a.check(`vinext dev serves the page: GET /s/<sid>/port/${PORT}/ is 200 with the page's text`, served !== null, evidence);
  a.check('vinext dev does not stop at the rolldown binding',
    !/rolldown has no Workers-compatible build|@rolldown\/binding-wasm32-wasi/.test(proc.output), evidence);
} finally {
  if (proc) { try { proc.ws.close(); } catch { /* probe teardown */ } }
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
