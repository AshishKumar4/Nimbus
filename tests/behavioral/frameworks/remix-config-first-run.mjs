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
// config loads on the first run or the run fails naming what it was refused,
// which the next run then has. (This config then stops at Tailwind v4's
// oxide, which has no Workers-compatible build, and says so.) And a program
// that swallows a refused synchronous read, then finds the path with
// existsSync, must still fail, naming the file: the run built on a read that
// did not happen.
//
// The serve itself is frameworks/remix-real's (the relaunched CLI is a child
// process, which does not run resident yet, and whose output does not reach
// the terminal yet).

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
  // config load, from a program in the project. The config vite bundles (the
  // temporary file it writes and imports) is what decided the memory: with
  // every import externalized it is the config's own code, importing the
  // packages it names, and no module under node_modules.
  await t.run(heredocCommand(`${APP}/config-load.mjs`, [
    "import fsp from 'node:fs/promises';",
    "const write = fsp.writeFile;",
    "let bundled = null;",
    "fsp.writeFile = function (file, data, ...rest) { if (/\\.timestamp-/.test(String(file))) bundled = String(data); return Reflect.apply(write, this, [file, data, ...rest]); };",
    "const { loadConfigFromFile } = await import('vite');",
    "const report = (loaded) => console.log('CONFIG=' + JSON.stringify({",
    "  loaded: loaded !== null, plugins: loaded ? [loaded.config.plugins].flat(Infinity).filter(Boolean).length : 0,",
    "  bundledBytes: bundled === null ? null : bundled.length,",
    "  externals: bundled === null ? null : [...bundled.matchAll(/(?:from|import\\()\\s*[\"']([^\"'.][^\"']*)[\"']/g)].map((m) => m[1]),",
    "}));",
    "let loaded = null;",
    "try { loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }); }",
    "finally { report(loaded); }",
  ].join('\n')), 10_000);
  const configOf = (out) => {
    const m = out.match(/CONFIG=(\{.*\})/);
    return m ? JSON.parse(m[1]) : null;
  };
  const load = await t.run(`cd ${APP} && node --conditions=development config-load.mjs 2>&1`, 240_000);
  const loadOut = stripAnsi(load.output);
  const first = configOf(loadOut);
  console.log(`[remix-config-first-run] first config load: exit ${load.exitCode} ${JSON.stringify(first)}`);
  // What it was refused, as the run names it.
  const named = (out) => out.split(/\r?\n/).filter((l) => /^\s+\/\S+$/.test(l)).map((l) => l.trim());
  console.log(`[remix-config-first-run] first config load refused: ${JSON.stringify(named(loadOut))}`);
  a.check('the first config load is not killed for memory', !/exceeded memory limit/i.test(loadOut) && first !== null,
    JSON.stringify({ exit: load.exitCode, out: loadOut.slice(-1500) }));
  // The config itself is a few hundred bytes; with its packages bundled in
  // (@react-router/dev, babel, Tailwind) it was megabytes.
  a.check('vite externalizes every package the config imports: nothing under node_modules is bundled into it',
    first !== null && first.bundledBytes !== null && first.bundledBytes < 16 * 1024
      && first.externals.some((e) => e.includes('@react-router/dev')) && first.externals.some((e) => e.includes('@tailwindcss/vite')),
    JSON.stringify(first ?? loadOut.slice(-600)));
  // What the program then loads of the config's imports is its own first run:
  // it loads, or it fails naming the reads it was refused, and the next run has them.
  const refused = (out) => /Failing rather than reporting a result built on them:/.test(out);
  a.check('the config loads on its first run, or the run fails naming what it was refused',
    (load.exitCode === 0 && first?.loaded === true) || (load.exitCode !== 0 && refused(loadOut)),
    JSON.stringify({ exit: load.exitCode, out: loadOut.slice(-1500) }));
  if (load.exitCode !== 0) {
    const again = await t.run(`cd ${APP} && node --conditions=development config-load.mjs 2>&1`, 240_000);
    const againOut = stripAnsi(again.output);
    const why = againOut.split(/\r?\n/).find((l) => /^(?:Error|Nimbus:|failed to load config)/.test(l.trim()) && !/^failed to load config/.test(l.trim())) ?? '';
    console.log(`[remix-config-first-run] second config load: exit ${again.exitCode} ${JSON.stringify(configOf(againOut))} refused ${JSON.stringify(named(againOut))} why ${JSON.stringify(why.trim().slice(0, 400))}`);
    // Tailwind v4's oxide has no Workers-compatible build: past the reads the
    // first run was refused, that is where this config stops, and it says so.
    a.check('the next run has what the first was refused: it loads, or fails on something other than a refused read',
      again.exitCode === 0 ? configOf(againOut)?.loaded === true : !refused(againOut) && !/EAGAIN/.test(againOut) && againOut.trim().length > 0,
      JSON.stringify(againOut.slice(-1500)));
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
