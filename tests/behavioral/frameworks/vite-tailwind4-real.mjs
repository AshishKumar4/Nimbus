#!/usr/bin/env bun
// A real create-vite React/TS project with Tailwind CSS v4 (@tailwindcss/vite),
// in a fresh session: Tailwind v4's scanner is oxide, a Rust napi binding
// that runs from Nimbus's staged threadless build and reads the project's
// sources synchronously through WASI.
//   - the dev server's first stylesheet carries the utility App.tsx uses;
//   - an edit to App.tsx and a new component it imports, written while the
//     server runs, reach the next stylesheet (oxide's incremental scan of a
//     changed file and of a new one);
//   - `vite build` writes a stylesheet with all three.
// Tailwind is pinned to the version of the staged oxide build: a launch
// carries the exact build a package's installed version names.
import { Terminal, mintSession, stripAnsi, makeAsserter, deleteSession, heredocCommand, BASE, requestHeaders, sleep } from '../_driver.mjs';
import { launchFrameworkDev } from '../_framework-dev.mjs';
if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('vite-tailwind4-real');
const ROOT = '/home/user/tw4-probe', APP = ROOT + '/app', PORT = 5175;
const TAILWIND = '4.3.3';
const MARKER = 'tw4-real-' + Date.now();
const APP_TSX = (extra) => `${extra ? "import Badge from './Badge';\n" : ''}export default function App() { return <main className="bg-[#123456]${extra ? ' text-[#246802]' : ''}"><h1>${MARKER}</h1>${extra ? '<Badge />' : ''}</main>; }\n`;
const BADGE_TSX = 'export default function Badge() { return <span className="text-[#654321]">new</span>; }\n';
function tail(s, n = 20) { return stripAnsi(s).split(/\r?\n/).filter(Boolean).slice(-n).join('\n'); }
async function get(sid, path) {
  const r = await fetch(`${BASE}/s/${sid}/port/${PORT}/${path}`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(60_000) });
  return { status: r.status, body: await r.text() };
}
/** The served stylesheet once it carries every one of `colors`, or the last one served within `ms`. */
async function stylesheetWith(sid, colors, ms) {
  const until = Date.now() + ms;
  let css;
  for (;;) {
    css = await get(sid, `src/index.css?t=${Date.now()}`);
    if (css.status === 200 && colors.every((c) => css.body.includes(c))) return { ok: true, css };
    if (Date.now() > until) return { ok: false, css };
    await sleep(1000);
  }
}
const sid = await mintSession(); console.log(`[vite-tailwind4-real] sid=${sid} BASE=${BASE}`);
const t = new Terminal(sid); let proc;
try {
  await t.connect(); await t.waitForPrompt(60_000);
  await t.run(`mkdir -p ${ROOT} && cd ${ROOT}`, 15_000);
  const create = await t.run('npm create vite@latest app -- --template react-ts --no-interactive 2>&1', 240_000);
  a.check('create-vite creates the React/TS project', create.exitCode === 0, tail(create.output));
  if (create.exitCode !== 0) throw new Error('scaffold failed');
  const installed = await t.run(`cd ${APP} && npm install 2>&1 && npm install -D tailwindcss@${TAILWIND} @tailwindcss/vite@${TAILWIND} 2>&1`, 600_000);
  a.check('npm install adds Tailwind v4 without an unsupported-build note', installed.exitCode === 0 && !/note:\s*@tailwindcss\/oxide has no Workers-compatible build/.test(installed.output), tail(installed.output));
  if (installed.exitCode !== 0) throw new Error('install failed');
  await t.run(heredocCommand(`${APP}/vite.config.ts`, "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport tailwindcss from '@tailwindcss/vite';\nexport default defineConfig({ plugins: [react(), tailwindcss()] });\n"), 15_000);
  await t.run(heredocCommand(`${APP}/src/index.css`, '@import "tailwindcss";\n'), 15_000);
  await t.run(heredocCommand(`${APP}/src/App.tsx`, APP_TSX(false)), 15_000);

  const dev = await launchFrameworkDev({
    terminal: t, sid, cwd: APP, command: `./node_modules/.bin/vite --host 0.0.0.0 --port ${PORT}`, port: PORT,
    accepts: (r) => r.status === 200 && r.body.includes('<div id="root">') && r.body.includes('/@vite/client'),
  });
  proc = dev.process;
  a.check('vite dev serves index.html through the port route on its first run', dev.ok, `${dev.last}\n${tail(dev.output, 30)}`);
  if (dev.ok) {
    const first = await stylesheetWith(sid, ['#123456'], 60_000);
    a.check('the first stylesheet carries the utility App.tsx uses', first.ok, `${first.css.status} ${first.css.body.slice(0, 600)}`);
    await t.run(heredocCommand(`${APP}/src/Badge.tsx`, BADGE_TSX), 15_000);
    await t.run(heredocCommand(`${APP}/src/App.tsx`, APP_TSX(true)), 15_000);
    const next = await stylesheetWith(sid, ['#123456', '#246802', '#654321'], 90_000);
    a.check('an edited file and a new one written while it runs reach the next stylesheet', next.ok, `${next.css.status} ${next.css.body.slice(0, 600)}`);
    proc.signal('SIGKILL'); for (let i = 0; i < 30 && !proc.exit; i++) await sleep(100); proc.ws.close(); proc = null;
  }

  const built = await t.run(`cd ${APP} && ./node_modules/.bin/vite build 2>&1`, 300_000);
  a.check('vite build exits 0 on its first run', built.exitCode === 0, tail(built.output, 30));
  const css = await t.run(`cd ${APP} && cat dist/assets/*.css`, 30_000);
  a.check('the built stylesheet carries every utility the sources use', ['#123456', '#246802', '#654321'].every((c) => css.output.includes(c)), tail(css.output, 5));
} finally {
  if (proc) { try { proc.signal('SIGKILL'); proc.ws.close(); } catch {} }
  await t.close(); const d = await deleteSession(sid); a.check('probe session deleted', d.ok, `status=${d.status}`);
}
process.exit(a.summary().fail ? 1 : 0);
