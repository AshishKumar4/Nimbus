#!/usr/bin/env bun
// frameworks/remix-relaunch-promotion: `react-router dev` relaunches itself
// as a child_process child, `node --conditions=development`. That child is a
// live process. It runs past the relaunch and loads the app's Vite config,
// which bundles it to node_modules/.vite-temp/ under a name made from the
// clock and a random draw, imports it, and removes it. Its listen promotes
// it, and Nimbus runs it again as a resident that retraces that run: the
// directory its first run made is there, the name is the same, and it serves.
// The default template's Tailwind v4 engine (@tailwindcss/oxide) runs from
// the staged threadless build.
import { Terminal, mintSession, makeAsserter, deleteSession, termBody, stripAnsi } from '../_driver.mjs';
import { launchFrameworkDev } from '../_framework-dev.mjs';

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

  const dev = await launchFrameworkDev({
    terminal: t, sid, cwd: APP, port: 5173,
    command: './node_modules/.bin/react-router dev --host 0.0.0.0 --port 5173',
    accepts: (r) => r.status === 200 && /<html/i.test(r.body),
  });
  proc = dev.process;
  const output = stripAnsi(dev.output);
  console.log('REMIX_RELAUNCH ' + JSON.stringify(output.slice(-3000)));
  a.check('it relaunched itself', /Relaunching/i.test(output), output.slice(-1200));
  a.check('the relaunched CLI, run again as a server, retraces its run and serves the app through the port route', dev.ok,
    JSON.stringify({ last: dev.last, dev: output.slice(-1500) }));
} finally {
  if (proc) { try { proc.signal('SIGKILL'); proc.ws.close(); } catch {} }
  await t.close().catch(() => {});
  await deleteSession(sid);
}
process.exit(a.summary().fail > 0 ? 1 : 0);
