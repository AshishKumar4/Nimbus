#!/usr/bin/env bun
// frameworks/nuxt-real — the real `nuxi init` → `npm install` → `nuxt dev`
// flow under Nimbus, checked end to end over the public port route.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npx --yes nuxi@latest init mvp -t minimal --no-install --gitInit=false --packageManager=npm
//   cd mvp && npm install
//   npx nuxt dev --host 0.0.0.0 --port 3000
//
// What this probe PROVES, honestly:
//   1. `nuxi init` runs non-interactively to exit 0 and writes a real
//      project: package.json (scripts.dev === "nuxt dev"), nuxt.config.ts
//      and app/ exist on disk afterwards. nuxi 3.37 requires
//      `--gitInit=<bool>` in a non-interactive terminal, so the flags above
//      are the full non-interactive set; the template comes down over
//      outbound fetch, so this step also covers the startup-drain that
//      keeps the facet alive across nuxi's async download.
//   2. `npm install` of the generated project exits 0 and node_modules/nuxt
//      exists — ~760 packages, ~31k files through the resolver and the VFS.
//   3. `npx nuxt dev --host 0.0.0.0 --port 3000` starts as a long-running
//      bin, binds 3000, and `GET /s/<sid>/port/3000/` answers 200 with
//      HTML carrying Nuxt's mount point (`id="__nuxt"`) or the word Nuxt.
//
// Failure is loud: if the dev server does not serve within its budget the
// probe fails with the last 60 lines of the process log in the message
// instead of an assertion that encodes "expected to fail". Earlier
// versions of this file asserted nuxi's non-interactive *diagnostic*
// (template registry banner, "Missing required argument"); that described
// an older nuxi and is gone.

import {
  Terminal, mintSession, stripAnsi, makeAsserter, deleteSession, fetchPort,
  connectProcessTerminal, sleep, BASE,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('nuxt-real');

const PORT = 3000;
const ROOT = '/home/user/nuxt-probe';
const INIT_BUDGET_MS = 240_000;
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
console.log(`[nuxt-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
let proc = null;
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await run(t, `mkdir -p ${ROOT} && cd ${ROOT}`, 10_000);

  // ── 1. nuxi init ────────────────────────────────────────────────────
  console.log('[nuxt-real] npx nuxi@latest init...');
  const init = await run(t,
    'npx --yes nuxi@latest init mvp -t minimal --no-install --gitInit=false --packageManager=npm 2>&1',
    INIT_BUDGET_MS);
  console.log(`[nuxt-real] init exit=${init.exit} elapsed=${init.elapsed}ms`);
  console.log(tail(init.output, 12));
  a.check('nuxi init exits 0', init.exit === 0, `exit=${init.exit} tail=${JSON.stringify(tail(init.output, 15))}`);

  // The sandbox shell's `node` has no `-p`; `-e` with explicit fs calls
  // reports each file on its own line and the dev script verbatim.
  const scaffold = await run(t,
    `cd ${ROOT}/mvp && node -e "const fs=require('fs');`
    + `for(const f of ['package.json','nuxt.config.ts','app'])console.log('HAS_'+f+'='+(fs.existsSync(f)?(fs.statSync(f).isDirectory()?'dir':'file'):'missing'));`
    + `console.log('DEV_SCRIPT='+JSON.stringify(JSON.parse(fs.readFileSync('package.json','utf8')).scripts.dev))"`,
    30_000);
  const scaffoldOut = stripAnsi(scaffold.output);
  a.check('nuxi init wrote package.json, nuxt.config.ts and app/',
    scaffold.exit === 0 && /HAS_package\.json=file/.test(scaffoldOut) && /HAS_nuxt\.config\.ts=file/.test(scaffoldOut) && /HAS_app=dir/.test(scaffoldOut),
    `exit=${scaffold.exit} out=${JSON.stringify(scaffoldOut.slice(-400))}`);
  a.check('package.json scripts.dev is "nuxt dev"', /DEV_SCRIPT="nuxt dev"/.test(scaffoldOut),
    JSON.stringify(scaffoldOut.slice(-400)));
  if (init.exit !== 0 || scaffold.exit !== 0) throw new Error('nuxi init did not produce a project; nothing to install or serve');

  // ── 2. npm install ──────────────────────────────────────────────────
  console.log('[nuxt-real] npm install...');
  const ins = await run(t, `cd ${ROOT}/mvp && npm install 2>&1`, INSTALL_BUDGET_MS);
  console.log(`[nuxt-real] install exit=${ins.exit} elapsed=${ins.elapsed}ms`);
  console.log(tail(ins.output, 8));
  a.check('npm install exits 0', ins.exit === 0, `exit=${ins.exit} tail=${JSON.stringify(tail(ins.output, 20))}`);
  const nm = await run(t, `test -d ${ROOT}/mvp/node_modules/nuxt && echo NUXT_INSTALLED`, 30_000);
  a.check('node_modules/nuxt exists after install', /NUXT_INSTALLED/.test(nm.output), JSON.stringify(nm.output.slice(-300)));
  if (ins.exit !== 0) throw new Error('npm install failed; nothing to serve');

  // ── 3. nuxt dev ─────────────────────────────────────────────────────
  // A long-running npm bin returns the shell prompt immediately with a
  // `[bin started (long-running): pid=N ...]` line; its own output goes to
  // the process log at /api/logs/<pid>.
  console.log('[nuxt-real] npx nuxt dev...');
  const launch = await t.run(`cd ${ROOT}/mvp && npx nuxt dev --host 0.0.0.0 --port ${PORT}`, 120_000);
  const launchOut = stripAnsi(launch.output);
  console.log(tail(launchOut, 6));
  const pid = Number((launchOut.match(/\[bin started \(long-running\): pid=(\d+)/) || [])[1] || 0);
  a.check('nuxt dev starts as a long-running bin', pid > 0, JSON.stringify(launchOut.slice(-600)));
  if (!(pid > 0)) throw new Error('nuxt dev did not start; nothing to poll');

  proc = await connectProcessTerminal(sid, pid);
  let served = null;
  let lastStatus = 'no response';
  const deadline = Date.now() + DEV_BUDGET_MS;
  while (Date.now() < deadline && !served) {
    if (proc.exit) break;
    try {
      const pr = await fetchPort(sid, PORT);
      lastStatus = `status=${pr.status} body=${JSON.stringify(pr.body.slice(0, 200))}`;
      if (pr.status === 200 && /<html/i.test(pr.body)) { served = pr; break; }
    } catch (e) {
      lastStatus = `fetch error: ${e.message}`;
    }
    await sleep(1_000);
  }
  const procTail = tail(proc.output, 60);
  console.log(`[nuxt-real] process log tail:\n${procTail}`);
  a.check(`GET /s/<sid>/port/${PORT}/ answers 200 HTML within ${DEV_BUDGET_MS / 1000}s`,
    served !== null,
    `${proc.exit ? `process exited: ${JSON.stringify(proc.exit)}; ` : ''}last ${lastStatus}\n--- last 60 lines of nuxt dev log (pid ${pid}) ---\n${procTail}`);
  a.check('the served page is Nuxt-generated (id="__nuxt" or "Nuxt" in HTML)',
    served !== null && (/id="__nuxt"/.test(served.body) || /Nuxt/.test(served.body)),
    served ? JSON.stringify(served.body.slice(0, 600)) : 'not served');
} finally {
  if (proc) { try { proc.ws.close(); } catch { /* probe teardown */ } }
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
