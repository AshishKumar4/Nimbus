#!/usr/bin/env bun
// A real create-vite React/TS app with Tailwind CSS v4 (@tailwindcss/vite) in
// a workspace, its stylesheet naming a sibling package outside the app's
// working tree (`@source "../../shared"`), in a fresh session. oxide, Tailwind
// v4's scanner, reads the sources synchronously, so a file the dev server's
// facet does not hold is skipped and its classes are missing:
//   - the first stylesheet carries the utility ../shared/Card.tsx uses;
//   - an edit to Card.tsx written while the server runs reaches the next one.
// Tailwind is pinned to the version of the staged oxide build.
import { Terminal, mintSession, stripAnsi, makeAsserter, deleteSession, heredocCommand, BASE, requestHeaders, sleep } from '../_driver.mjs';
import { launchFrameworkDev } from '../_framework-dev.mjs';
if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('vite-tailwind4-out-of-root-source');
const ROOT = '/home/user/tw4-workspace', APP = ROOT + '/app', SHARED = ROOT + '/shared', PORT = 5176;
const TAILWIND = '4.3.3';
const CARD_TSX = (color) => `export default function Card() { return <div className="bg-[${color}]">card</div>; }\n`;
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
const sid = await mintSession(); console.log(`[vite-tailwind4-out-of-root-source] sid=${sid} BASE=${BASE}`);
const t = new Terminal(sid); let proc;
try {
  await t.connect(); await t.waitForPrompt(60_000);
  await t.run(`mkdir -p ${SHARED} && cd ${ROOT}`, 15_000);
  await t.run(heredocCommand(`${SHARED}/Card.tsx`, CARD_TSX('#13579b')), 15_000);
  const create = await t.run('npm create vite@latest app -- --template react-ts --no-interactive 2>&1', 240_000);
  a.check('create-vite creates the React/TS project', create.exitCode === 0, tail(create.output));
  if (create.exitCode !== 0) throw new Error('scaffold failed');
  const installed = await t.run(`cd ${APP} && npm install 2>&1 && npm install -D tailwindcss@${TAILWIND} @tailwindcss/vite@${TAILWIND} 2>&1`, 600_000);
  a.check('npm install adds Tailwind v4', installed.exitCode === 0, tail(installed.output));
  if (installed.exitCode !== 0) throw new Error('install failed');
  await t.run(heredocCommand(`${APP}/vite.config.ts`, "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport tailwindcss from '@tailwindcss/vite';\nexport default defineConfig({ plugins: [react(), tailwindcss()] });\n"), 15_000);
  await t.run(heredocCommand(`${APP}/src/index.css`, '@import "tailwindcss";\n@source "../../shared";\n'), 15_000);
  await t.run(heredocCommand(`${APP}/src/App.tsx`, 'export default function App() { return <main className="bg-[#123456]">app</main>; }\n'), 15_000);

  const dev = await launchFrameworkDev({
    terminal: t, sid, cwd: APP, command: `./node_modules/.bin/vite --host 0.0.0.0 --port ${PORT}`, port: PORT,
    accepts: (r) => r.status === 200 && r.body.includes('<div id="root">') && r.body.includes('/@vite/client'),
  });
  proc = dev.process;
  a.check('vite dev serves index.html through the port route on its first run', dev.ok, `${dev.last}\n${tail(dev.output, 30)}`);
  if (dev.ok) {
    const first = await stylesheetWith(sid, ['#123456', '#13579b'], 60_000);
    a.check('the first stylesheet carries the utility the out-of-tree source uses', first.ok, `${first.css.status} ${first.css.body.slice(0, 600)}`);
    await t.run(heredocCommand(`${SHARED}/Card.tsx`, CARD_TSX('#2468ac')), 15_000);
    const next = await stylesheetWith(sid, ['#123456', '#2468ac'], 90_000);
    a.check('an edit to the out-of-tree source written while it runs reaches the next stylesheet', next.ok, `${next.css.status} ${next.css.body.slice(0, 600)}`);
  }
} finally {
  if (proc) { try { proc.signal('SIGKILL'); proc.ws.close(); } catch {} }
  await t.close(); const d = await deleteSession(sid); a.check('probe session deleted', d.ok, `status=${d.status}`);
}
process.exit(a.summary().fail ? 1 : 0);
