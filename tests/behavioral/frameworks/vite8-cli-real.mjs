#!/usr/bin/env bun
// frameworks/vite8-cli-real — a `npm create vite@latest` app's own Vite 8 CLI
// under Nimbus: `vite build` writes dist/, and `vite` serves the app through
// the public port route.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npm create vite@latest app -- --template react-ts --no-interactive
//   cd app && npm install
//   ./node_modules/.bin/vite build
//   ./node_modules/.bin/vite --host 0.0.0.0 --port 5173
//
// The project's bin is invoked by path: the bare `vite` command is Nimbus's
// built-in dev server.
//
// Current boundary (this probe is expected RED until it moves): rolldown runs
// (frameworks/vite8-real proves dev and build through Vite's JS API), but the
// CLI loads vite.config by bundling it with rolldown to
// node_modules/.vite-temp/vite.config.ts.timestamp-*.mjs and import()ing that
// file. A module written after launch cannot be compiled in a Worker isolate
// (the Worker Loader builds a launch's module map once; code generation from
// strings is refused outside module evaluation), so Nimbus answers "not in
// this launch's module map". The fix is content-addressed staging of
// runtime-generated modules into the next launch; when it lands, both checks
// below go green.

import {
  Terminal, mintSession, stripAnsi, makeAsserter, deleteSession, fetchPort,
  connectProcessTerminal, sleep, BASE,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('vite8-cli-real');

const PORT = 5173;
const ROOT = '/home/user/vite8-cli-probe';
const APP = `${ROOT}/app`;

async function run(t, cmd, timeoutMs) {
  const r = await t.run(`${cmd}; echo "___EXIT=$?___"`, timeoutMs);
  const m = r.output.match(/___EXIT=(\d+)___/);
  return { exit: m ? Number(m[1]) : null, output: stripAnsi(r.output), elapsed: r.elapsed };
}

function tail(text, lines) {
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join('\n');
}

const sid = await mintSession();
console.log(`[vite8-cli-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
let proc = null;
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await run(t, `mkdir -p ${ROOT} && cd ${ROOT}`, 10_000);
  const create = await run(t, 'npm create vite@latest app -- --template react-ts --no-interactive 2>&1', 240_000);
  a.check('npm create vite@latest (react-ts) exits 0', create.exit === 0, tail(create.output, 15));
  if (create.exit !== 0) throw new Error('create-vite failed');
  const ins = await run(t, `cd ${APP} && npm install 2>&1`, 400_000);
  a.check('npm install exits 0', ins.exit === 0, tail(ins.output, 20));
  if (ins.exit !== 0) throw new Error('npm install failed');

  // ── vite build ─────────────────────────────────────────────────────
  const build = await run(t, `cd ${APP} && ./node_modules/.bin/vite build 2>&1`, 300_000);
  console.log(`[vite8-cli-real] vite build exit=${build.exit}\n${tail(build.output, 12)}`);
  const dist = await run(t, `cd ${APP} && ls dist/assets`, 30_000);
  a.check('vite build exits 0 and writes hashed JS and CSS under dist/assets',
    build.exit === 0 && /index-[\w-]+\.js/.test(dist.output) && /index-[\w-]+\.css/.test(dist.output),
    tail(build.output, 20));

  // ── vite (dev) ─────────────────────────────────────────────────────
  const launch = await t.run(`cd ${APP} && ./node_modules/.bin/vite --host 0.0.0.0 --port ${PORT}`, 120_000);
  const pid = Number((stripAnsi(launch.output).match(/pid=(\d+)/) || [])[1] || 0);
  let served = null;
  let last = 'no response';
  if (pid > 0) {
    proc = await connectProcessTerminal(sid, pid);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !served && !proc.exit) {
      const r = await fetchPort(sid, PORT).catch((e) => ({ status: 0, body: String(e.message) }));
      last = `status=${r.status} body=${JSON.stringify(r.body.slice(0, 200))}`;
      if (r.status === 200 && /<div id="root">/.test(r.body)) served = r;
      else await sleep(1_000);
    }
  }
  a.check(`vite serves the app's index.html at /s/<sid>/port/${PORT}/`, served !== null,
    `pid=${pid} last ${last}\n${tail(proc?.output ?? stripAnsi(launch.output), 20)}`);
} finally {
  if (proc) { try { proc.ws.close(); } catch { /* probe teardown */ } }
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
