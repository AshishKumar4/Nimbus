#!/usr/bin/env bun
// frameworks/remix-relaunch-promotion: `react-router dev` relaunches itself
// as a child_process child, `node --conditions=development`. That child is a
// live process. It runs past the relaunch and loads the app's Vite config,
// which bundles it to node_modules/.vite-temp/ under a name made from the
// clock and a random draw, imports it, and removes it. Its listen promotes
// it: Nimbus runs it again as a resident that retraces that run (the
// directory its first run made is there, the name is the same) and reaches
// its listen, which Vite announces. The default template's Tailwind v4
// engine (@tailwindcss/oxide) runs from the staged threadless build.
// (frameworks/remix-real, which also serves the app's pages, is past this
// and excluded on memory: tests/behavioral/_deferred.mjs.)
import { Terminal, mintSession, makeAsserter, deleteSession, termBody, connectProcessTerminal } from '../_driver.mjs';
import { LONG_RUNNING, startDevCommand } from '../_dev-start.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'frameworks/remix-relaunch-promotion';
const a = makeAsserter(label);
const sid = await mintSession(), t = new Terminal(sid);
console.log(`${label} — ${process.env.BASE} SID=${sid}`);
const APP = '/home/user/rr/mvp';
let proc = null;
try {
  await t.connect(); await t.waitForPrompt(60_000);
  await t.run('mkdir -p /home/user/rr && cd /home/user/rr', 15_000);
  const created = termBody((await t.run('npx --yes create-react-router@latest mvp --yes --no-git-init --no-install 2>&1; echo CREATE_RC=$?', 240_000)).output);
  a.check('create-react-router creates the app', /CREATE_RC=0/.test(created), created.slice(-600));
  const installed = termBody((await t.run(`cd ${APP} && npm install 2>&1; echo INSTALL_RC=$?`, 400_000)).output);
  a.check('its npm install completes', /INSTALL_RC=0/.test(installed), installed.slice(-600));

  const started = await startDevCommand({ terminal: t, cwd: APP, command: './node_modules/.bin/react-router dev --host 0.0.0.0 --port 5173' });
  a.check('it relaunched itself', /Relaunching/i.test(started.output), started.output.slice(-1200));
  const promoted = LONG_RUNNING.exec(started.output);
  a.check('the relaunched CLI is run again as a server, retracing its run',
    promoted !== null && /--conditions=development/.test(started.output.slice(promoted.index)) && !/did not retrace/.test(started.output),
    started.output.slice(-1500));
  if (started.pid) {
    proc = await connectProcessTerminal(sid, started.pid);
    const listened = await proc.waitFor((text) => /Local:\s+http:\/\/localhost:5173/.test(text), 120_000, "Vite's listen").then(() => true, () => false);
    a.check('run again, it reaches its listen', listened && !proc.exit, (started.output + proc.output).slice(-1500));
  }
} finally {
  if (proc) { try { proc.signal('SIGKILL'); proc.ws.close(); } catch {} }
  await t.close().catch(() => {});
  await deleteSession(sid);
}
process.exit(a.summary().fail > 0 ? 1 : 0);
