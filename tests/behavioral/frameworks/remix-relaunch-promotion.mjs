#!/usr/bin/env bun
// frameworks/remix-relaunch-promotion — `react-router dev` relaunches itself
// with `node --conditions=development` as a child_process child. That child
// is a live process: it runs past the relaunch and loads the app's Vite
// config. The default template's Tailwind v4 engine (@tailwindcss/oxide)
// ships only native bindings, which no Worker can load, so it ends there,
// loudly, naming the missing binding, never a silent exit 0.
// (frameworks/remix-real, which serves the app, waits for an oxide build.)
import { Terminal, mintSession, makeAsserter, deleteSession, termBody } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'frameworks/remix-relaunch-promotion';
const a = makeAsserter(label);
const sid = await mintSession(), t = new Terminal(sid);
console.log(`${label} — ${process.env.BASE} SID=${sid}`);
const APP = '/home/user/rr/mvp';
try {
  await t.connect(); await t.waitForPrompt(60_000);
  await t.run('mkdir -p /home/user/rr && cd /home/user/rr', 15_000);
  const created = termBody((await t.run('npx --yes create-react-router@latest mvp --yes --no-git-init --no-install 2>&1; echo CREATE_RC=$?', 240_000)).output);
  a.check('create-react-router creates the app', /CREATE_RC=0/.test(created), created.slice(-600));
  const installed = termBody((await t.run(`cd ${APP} && npm install 2>&1; echo INSTALL_RC=$?`, 400_000)).output);
  a.check('its npm install completes', /INSTALL_RC=0/.test(installed), installed.slice(-600));

  const dev = termBody((await t.run('npx react-router dev --host 0.0.0.0 --port 5173 2>&1; echo DEV_RC=$?', 240_000)).output);
  console.log('REMIX_RELAUNCH ' + JSON.stringify(dev.slice(-3000)));
  const rc = Number(/DEV_RC=(\d+)/.exec(dev)?.[1] ?? NaN);
  a.check('it relaunched itself', /Relaunching/i.test(dev), dev.slice(-1200));
  a.check('the relaunched CLI reached the app config and ends naming the missing native binding',
    /Cannot find native binding/.test(dev), dev.slice(-1200));
  a.check('with a failing status, never a silent exit 0', Number.isInteger(rc) && rc !== 0, `DEV_RC=${rc}\n${dev.slice(-600)}`);
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid);
}
process.exit(a.summary().fail > 0 ? 1 : 0);
