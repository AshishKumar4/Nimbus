#!/usr/bin/env bun
// frameworks/astro-real — the real `npm create astro` → `npm install` →
// `astro dev` flow under Nimbus, up to the boundary it stops at.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npm create astro@latest mvp -- --template minimal --no-install --no-git --skip-houston --yes
//   cd mvp && npm install
//   npx astro dev --host 0.0.0.0 --port 4321
//
// What this probe PROVES:
//   1. create-astro resolves+installs its own dependency tree and launches
//      as a facet, stays alive through giget's template download (outbound
//      fetch with Nimbus's default "User-Agent: node"; api.github.com 403s
//      UA-less requests), exits 0, and the template is on disk (node-tar's
//      gzip extract over workerd's synchronous zlib).
//   2. `npm install` of the generated project exits 0 and refuses neither
//      rolldown nor its wasm binding (Nimbus answers the binding with its
//      staged single-threaded wasm32-wasip1 build).
//   3. `npx astro dev` starts as a long-running bin and serves the minimal
//      template's page through /s/<sid>/port/4321/.
//
// Current boundary (check 3 is expected RED until it moves): Vite 8 and
// rolldown load and run, but Astro loads astro.config and every page through
// Vite's SSR module runner, which evaluates transformed module text with
// `new AsyncFunction` — runtime code generation a Worker refuses outside
// module evaluation. The evidence line records the process log's tail.

import {
  Terminal, mintSession, stripAnsi, makeAsserter, deleteSession, fetchPort,
  connectProcessTerminal, sleep, BASE,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('astro-real');

const PORT = 4321;
const ROOT = '/home/user/astro-probe';
const CREATE_BUDGET_MS = 240_000;
const INSTALL_BUDGET_MS = 400_000;
const DEV_BUDGET_MS = 240_000;

// Terminal.run() waits for the prompt to return; an exit sentinel keeps
// the command's exit code inside the returned output.
async function run(t, cmd, timeoutMs) {
  const r = await t.run(`${cmd}; echo "___EXIT=$?___"`, timeoutMs);
  const m = r.output.match(/___EXIT=(\d+)___/);
  return { exit: m ? Number(m[1]) : null, output: r.output, elapsed: r.elapsed };
}

function tail(text, lines) {
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join('\n');
}

const sid = await mintSession();
console.log(`[astro-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
let proc = null;
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await run(t, `mkdir -p ${ROOT} && cd ${ROOT}`, 10_000);

  // ── 1. npm create astro ─────────────────────────────────────────────
  console.log('[astro-real] npm create astro@latest...');
  const create = await run(t,
    'npm create astro@latest mvp -- --template minimal --no-install --no-git --skip-houston --yes 2>&1',
    CREATE_BUDGET_MS);
  const createOut = stripAnsi(create.output);
  console.log(`[astro-real] create exit=${create.exit} elapsed=${create.elapsed}ms`);
  console.log(tail(createOut, 12));
  a.check('create-astro resolves its dependency tree and launches (npm resolver + facet spawn)',
    /facet started: pid=\d+ cmd="node[^"]*create-astro/.test(createOut),
    JSON.stringify(tail(createOut, 6)));
  a.check('create-astro stays alive through the template download and exits 0',
    create.exit === 0, `exit=${create.exit} tail=${JSON.stringify(tail(createOut, 15))}`);

  // The sandbox shell's `node` has no `-p`; `-e` with explicit fs calls
  // reports each file on its own line.
  const scaffold = await run(t,
    `cd ${ROOT}/mvp && node -e "const fs=require('fs');`
    + `for(const f of ['package.json','astro.config.mjs','src/pages/index.astro'])console.log('HAS_'+f+'='+(fs.existsSync(f)?'file':'missing'))"`,
    30_000);
  const scaffoldOut = stripAnsi(scaffold.output);
  a.check('create-astro wrote mvp/package.json, astro.config.mjs and src/pages/index.astro',
    scaffold.exit === 0 && /HAS_package\.json=file/.test(scaffoldOut) && /HAS_astro\.config\.mjs=file/.test(scaffoldOut)
      && /HAS_src\/pages\/index\.astro=file/.test(scaffoldOut),
    `exit=${scaffold.exit} out=${JSON.stringify(scaffoldOut.slice(-400))}`);
  if (create.exit !== 0 || scaffold.exit !== 0) throw new Error('create-astro did not produce a project; nothing to install or serve');

  // ── 2. npm install ──────────────────────────────────────────────────
  console.log('[astro-real] npm install...');
  const ins = await run(t, `cd ${ROOT}/mvp && npm install 2>&1`, INSTALL_BUDGET_MS);
  console.log(`[astro-real] install exit=${ins.exit} elapsed=${ins.elapsed}ms`);
  console.log(tail(ins.output, 8));
  a.check('npm install exits 0', ins.exit === 0, `exit=${ins.exit} tail=${JSON.stringify(tail(ins.output, 20))}`);
  if (ins.exit !== 0) throw new Error('npm install failed; nothing to launch');
  const insOut = stripAnsi(ins.output);
  a.check('npm install refuses neither rolldown nor its wasm binding',
    !/note:\s*(rolldown|@rolldown\/binding-wasm32-wasi) has no Workers-compatible build/.test(insOut),
    tail(insOut, 20));

  // ── 3. astro dev ────────────────────────────────────────────────────
  // A long-running npm bin returns the shell prompt immediately with a
  // `[bin started (long-running): pid=N ...]` line; its own output goes to
  // the process log at /api/logs/<pid>.
  console.log('[astro-real] npx astro dev...');
  const launch = await t.run(`cd ${ROOT}/mvp && npx astro dev --host 0.0.0.0 --port ${PORT}`, 120_000);
  const launchOut = stripAnsi(launch.output);
  console.log(tail(launchOut, 6));
  const pid = Number((launchOut.match(/\[bin started \(long-running\): pid=(\d+)/) || [])[1] || 0);
  a.check('astro dev starts as a long-running bin', pid > 0, JSON.stringify(launchOut.slice(-600)));
  if (!(pid > 0)) throw new Error('astro dev did not start; nothing to poll');

  proc = await connectProcessTerminal(sid, pid);
  let served = null;
  let lastStatus = 'no response';
  const deadline = Date.now() + DEV_BUDGET_MS;
  while (Date.now() < deadline && !served && !proc.exit) {
    try {
      const pr = await fetchPort(sid, PORT);
      lastStatus = `status=${pr.status} body=${JSON.stringify(pr.body.slice(0, 200))}`;
      if (pr.status === 200 && /<html/i.test(pr.body)) served = pr;
    } catch (e) {
      lastStatus = `fetch error: ${e.message}`;
    }
    if (!served) await sleep(1_000);
  }
  const procOut = proc.output;
  const procTail = tail(procOut, 60);
  console.log(`[astro-real] process log tail:\n${procTail}`);
  const evidence = `exit=${JSON.stringify(proc.exit)} last ${lastStatus}\n--- last 60 lines of astro dev log (pid ${pid}) ---\n${procTail}`;
  a.check(`astro dev serves the template's page: GET /s/<sid>/port/${PORT}/ is 200 HTML`,
    served !== null, evidence);
  a.check('astro dev does not stop at the rolldown binding',
    !/rolldown has no Workers-compatible build|@rolldown\/binding-wasm32-wasi/.test(procOut), evidence);
} finally {
  if (proc) { try { proc.ws.close(); } catch { /* probe teardown */ } }
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
