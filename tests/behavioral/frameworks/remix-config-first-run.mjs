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
// This drives the relaunched CLI's config load as a one-shot: it must not be
// killed, nothing under node_modules may be bundled into the config, and the
// config loads on the first run or the run fails naming what it was refused
// (and the next run loads it). Then `react-router dev` itself, whose launch
// carries the config's own imports: its dev server must start on the first
// run. And a program that swallows a refused synchronous read, then finds the
// path with existsSync, must still fail, naming the file: the run built on a
// read that did not happen.
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

  // What `react-router dev` runs after its relaunch, before it serves: vite's
  // config load, from a program in the project. The config vite bundles is
  // what decided the memory: its inline source map names every module rolldown
  // bundled into it, and with every import externalized none is under
  // node_modules.
  await t.run(heredocCommand(`${APP}/config-load.mjs`, [
    "import fsp from 'node:fs/promises';",
    "const write = fsp.writeFile;",
    "let bundled = null;",
    "fsp.writeFile = function (file, data, ...rest) { if (/\\.timestamp-/.test(String(file))) bundled = String(data); return Reflect.apply(write, this, [file, data, ...rest]); };",
    "const { loadConfigFromFile } = await import('vite');",
    "let loaded = null;",
    "let error = null;",
    "try { loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }); } catch (e) { error = String(e && e.message || e).slice(0, 400); }",
    "const map = bundled && bundled.match(/sourceMappingURL=data:application\\/json;base64,([A-Za-z0-9+/=]+)/);",
    "const sources = map ? JSON.parse(Buffer.from(map[1], 'base64').toString()).sources : null;",
    "const packaged = sources ? sources.filter((s) => s.includes('node_modules/')) : null;",
    "console.log('CONFIG=' + JSON.stringify({ loaded: loaded !== null, plugins: loaded ? [loaded.config.plugins].flat(Infinity).filter(Boolean).length : 0, bundledBytes: bundled ? bundled.length : null, sources: sources ? sources.length : null, packaged: packaged ? packaged.length : null, firstPackaged: packaged ? packaged.slice(0, 8) : null, error }));",
  ].join('\n')), 10_000);
  const load = await t.run(`cd ${APP} && node --conditions=development config-load.mjs 2>&1`, 240_000);
  const loadOut = stripAnsi(load.output);
  const config = loadOut.match(/CONFIG=(\{.*\})/);
  const loaded = config ? JSON.parse(config[1]) : null;
  console.log(`[remix-config-first-run] first config load: exit ${load.exitCode} ${JSON.stringify(loaded)}`);
  a.check('the first config load is not killed for memory', !/exceeded memory limit/i.test(loadOut) && loaded !== null,
    JSON.stringify({ exit: load.exitCode, out: loadOut.slice(-1500) }));
  a.check('vite externalizes every package the config imports: nothing under node_modules is bundled into it',
    loaded !== null && loaded.sources > 0 && loaded.packaged === 0, JSON.stringify(loaded ?? loadOut.slice(-600)));
  // What the program then loads of the config's imports is its own first run:
  // it loads, or it fails naming the reads it was refused and the next run has them.
  const named = /Failing rather than reporting a result built on them:/.test(loadOut);
  a.check('the config loads on its first run, or the run fails naming what it was refused',
    (load.exitCode === 0 && loaded?.loaded === true && loaded.plugins > 0) || (load.exitCode !== 0 && named),
    JSON.stringify({ exit: load.exitCode, out: loadOut.slice(-1500) }));
  if (load.exitCode !== 0) {
    const again = await t.run(`cd ${APP} && node --conditions=development config-load.mjs 2>&1`, 240_000);
    const againOut = stripAnsi(again.output);
    const reloaded = againOut.match(/CONFIG=(\{.*\})/);
    console.log(`[remix-config-first-run] second config load: exit ${again.exitCode} ${reloaded ? reloaded[1] : ''}`);
    a.check('the next run, which stages what the first was refused, loads the config',
      again.exitCode === 0 && reloaded !== null && JSON.parse(reloaded[1]).loaded === true, JSON.stringify(againOut.slice(-1500)));
  }

  // The CLI itself: `react-router dev` relaunches with the development
  // condition and loads the config as the tool, with the config's own imports
  // in its first launch. Its dev server starting is the config loaded.
  t.reset();
  t.cmd(`cd ${APP} && ./node_modules/.bin/react-router dev --port 5173 2>&1`);
  const cli = t.submission;
  await t.waitFor((b) => /Local:\s+http/.test(stripAnsi(b)) || cli.end !== null, 240_000, 'the dev server banner or the prompt').catch(() => {});
  const cliOut = stripAnsi(t.buf);
  a.check('react-router dev, relaunched with the development condition, loads its config on the first run',
    /Relaunching with --conditions=development/.test(cliOut) && /Local:\s+http/.test(cliOut) && !/exceeded memory limit/i.test(cliOut),
    JSON.stringify(cliOut.slice(-2000)));
  if (cli.end === null) {
    t.send('\x03');
    await t.waitFor(() => cli.end !== null, 60_000, 'the prompt after Ctrl-C').catch(() => {});
  }

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
