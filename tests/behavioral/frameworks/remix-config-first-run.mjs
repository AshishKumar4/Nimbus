#!/usr/bin/env bun
// frameworks/remix-config-first-run — a fresh create-react-router project's
// vite config loads on its first run.
//
// Category: R (runtime-behavioral)
//
// `react-router dev` relaunches itself with `node --conditions=development`,
// and the relaunched CLI's first act is vite's loadConfigFromFile. vite
// bundles vite.config.ts with rolldown and externalizes every package import
// it can resolve, reading each package's package.json synchronously to do
// so. On a first run those manifests were not staged: each read answered
// EAGAIN, vite took that as "not found" and bundled @react-router/dev,
// @tailwindcss/vite, babel and the rest into the config instead, and
// rolldown's memory reached 163.9 MiB in about a second ("Worker exceeded
// memory limit"). The killed run reported none of its misses, so the second
// and third runs died the same way.
//
// This drives the relaunched CLI's config load as a one-shot, once: it must
// load, and nothing under node_modules may be bundled into the config. And a
// program that swallows a refused synchronous read, then finds the path with
// existsSync, must still fail, naming the file: the run built on a read that
// did not happen.
//
// The serve itself is frameworks/remix-real's (the relaunched CLI is a child
// process, which does not run resident yet).

import { Terminal, mintSession, sleep, stripAnsi, makeAsserter, deleteSession, heredocCommand, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('remix-config-first-run');
const APP = '/home/user/rx/mvp';

const sid = await mintSession();
console.log(`[remix-config-first-run] sid=${sid} BASE=${BASE}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);
  await t.run('mkdir -p /home/user/rx && cd /home/user/rx', 10_000);
  const create = await t.run('npx --yes create-react-router@latest mvp --yes --no-git-init --no-install 2>&1', 300_000);
  a.check('create-react-router scaffolds the project', create.exitCode === 0, JSON.stringify(stripAnsi(create.output).slice(-600)));
  const install = await t.run(`cd ${APP} && npm install 2>&1`, 600_000);
  a.check("the project's npm install completes", install.exitCode === 0, JSON.stringify(stripAnsi(install.output).slice(-600)));

  // What `react-router dev` runs after its relaunch, before it serves.
  await t.run(heredocCommand(`${APP}/config-load.mjs`, [
    "import { loadConfigFromFile } from 'vite';",
    "const r = await loadConfigFromFile({ command: 'serve', mode: 'development' });",
    "const bundled = r.dependencies.filter((d) => d.includes('/node_modules/'));",
    "console.log('CONFIG=' + JSON.stringify({ plugins: [r.config.plugins].flat(Infinity).filter(Boolean).length, bundled: bundled.length, first: bundled.slice(0, 10) }));",
  ].join('\n')), 10_000);
  const load = await t.run(`cd ${APP} && node --conditions=development config-load.mjs 2>&1`, 240_000);
  const loadOut = stripAnsi(load.output);
  const config = loadOut.match(/CONFIG=(\{.*\})/);
  const loaded = config ? JSON.parse(config[1]) : null;
  a.check('the config loads on its first run', load.exitCode === 0 && loaded !== null && loaded.plugins > 0,
    JSON.stringify({ exit: load.exitCode, out: loadOut.slice(-1500) }));
  a.check('every package the config imports is externalized, none bundled into it', loaded !== null && loaded.bundled === 0,
    JSON.stringify(loaded ?? loadOut.slice(-600)));

  // A refused read the program swallows, then finds with existsSync.
  await t.run('mkdir -p /home/user/elsewhere && echo kept > /home/user/elsewhere/data.txt', 10_000);
  await t.run(heredocCommand('/home/user/rx/swallow.js', [
    "const fs = require('fs');",
    "const target = ['', 'home', 'user', 'elsewhere', 'data' + '.txt'].join('/');",
    "let body = 'FALLBACK';",
    "try { body = fs.readFileSync(target, 'utf8'); } catch {}",
    "console.log('SWALLOW=' + JSON.stringify({ body, there: fs.existsSync(target) }));",
  ].join('\n')), 10_000);
  const swallow = await t.run('cd /home/user/rx && node swallow.js 2>&1', 60_000);
  const swallowOut = stripAnsi(swallow.output);
  // The premise is part of the claim: the read was refused and the path is there.
  a.check('a swallowed refused read fails the run, naming the file',
    swallowOut.includes('SWALLOW={"body":"FALLBACK","there":true}') && swallow.exitCode !== 0
      && swallowOut.includes('/home/user/elsewhere/data.txt'),
    JSON.stringify({ exit: swallow.exitCode, out: swallowOut.slice(-800) }));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
