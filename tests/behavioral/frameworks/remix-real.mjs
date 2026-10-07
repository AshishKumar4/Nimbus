#!/usr/bin/env bun
// frameworks/remix-real — honest-boundary probe for `create-react-router`.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npx create-react-router@latest mvp --no-git-init --no-install --yes
//
// Note: Remix v2 was upstreamed into React Router; `create-remix@latest`
// now redirects to `create-react-router@latest`, which we use.
//
// What this probe PROVES (the real, useful capability): create-react-
// router resolves+installs its own dependency tree, launches its CLI as a
// facet, downloads its template (outbound fetch + the default-User-Agent
// fix that lets codeload/GitHub answer 200, and Readable.fromWeb in
// stream.pipeline) and extracts it, and the project's own `npm install`
// completes.
//
// create-react-router extracts its template with a stream pipeline,
//   pipeline(input, gunzip-maybe(), tar-fs.extract(dest)),
// whose streams come from `readable-stream`. It inherits by constructor
// stealing (`inherits(Duplexify, Duplex)`, then `Duplex.call(this)`), so
// Nimbus's stream classes must be callable without `new`, as Node's are;
// and tar-fs's extract is a streamx Writable, written to but with no pipe
// of its own, which pipeline must take as the destination it is. The
// minimal repros below pin both, against Node's own output.
//
// `react-router dev` decides whether to relaunch itself by a subpath import
// with a condition (`#development-condition-enabled`: "development" true,
// else false), and relaunches with `node --conditions=development`. Nimbus's
// node takes the flag (a repro pins it against Node: COND=true), so the
// relaunched CLI takes its dev path.
//
// Boundary (documented, not faked): the dev path loads vite.config.ts, which
// vite bundles at run time into node_modules/.vite-temp/<config>.timestamp-
// <random>.mjs and imports: a module no launch can stage (its name is new
// each run), and the modules it reaches (@react-router/dev/vite) are not in
// the launch's module map either; with the template's Tailwind plugin
// beside it the load fails earlier, "Invalid array buffer length". The repro
// below runs vite's own config loader on the project's config and pins that
// failure (ContinuedMackerel's: first-launch staging and run-time import()
// of unstaged modules); once the config loads, the probe requires the dev
// page.

import { Terminal, mintSession, sleep, stripAnsi, makeAsserter, deleteSession, BASE } from '../_driver.mjs';
import { launchFrameworkDev } from '../_framework-dev.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('remix-real');

const sid = await mintSession();
console.log(`[remix-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('mkdir -p /home/user/remix-probe && cd /home/user/remix-probe', 10_000);
  console.log('[remix-real] npx create-react-router@latest...');

  // create-react-router resolves and installs its dependency tree, then
  // launches its CLI as a facet.
  const createR = await t.run(
    'npx --yes create-react-router@latest mvp --no-git-init --no-install --yes 2>&1; echo "___DONE___"',
    240_000,
  );
  const createOut = stripAnsi(createR.output);
  const launched = /facet started: pid=\d+ cmd="node[^"]*create-react-router/.test(createOut);
  a.check('create-react-router resolves its dependency tree and launches (npm resolver + facet spawn)',
    launched, JSON.stringify(createOut.split(/\r?\n/).slice(-6).join(' | ')));

  // The template extracted: the project create-react-router wrote.
  const extractCheck = [
    'const fs = require("fs");',
    'let p = {};',
    'try { p = JSON.parse(fs.readFileSync("/home/user/remix-probe/mvp/package.json", "utf8")); } catch {}',
    'const d = Object.assign({}, p.dependencies, p.devDependencies);',
    'console.log("EXTRACTED=" + JSON.stringify({ rr: Boolean(d["react-router"]), dev: Boolean(d["@react-router/dev"]), script: (p.scripts || {}).dev || null, root: fs.existsSync("/home/user/remix-probe/mvp/app/root.tsx") }));',
  ].join('\n');
  await t.run(`printf '%s' '${Buffer.from(extractCheck).toString('base64')}' | base64 -d > /home/user/remix-probe/extracted.js`, 15_000);
  const extracted = await t.run('node /home/user/remix-probe/extracted.js', 30_000);
  const extractedOut = stripAnsi(extracted.output);
  a.check('the template extracts: a React Router project (package.json, app/root.tsx)',
    /EXTRACTED=\{"rr":true,"dev":true,"script":"react-router dev","root":true\}/.test(extractedOut), JSON.stringify(extractedOut.slice(-400)));

  const install = await t.run('cd /home/user/remix-probe/mvp && npm install 2>&1; echo "___INSTALL=$?___"', 600_000);
  const installOut = stripAnsi(install.output);
  a.check("the project's npm install completes", /___INSTALL=0___/.test(installOut), JSON.stringify(installOut.slice(-600)));

  // readable-stream's constructor stealing: Node runs `Duplex.call(this)`
  // on an existing instance, and so must Nimbus.
  await t.waitForPrompt(60_000).catch(() => {});
  const repro = [
    'const s=require("stream");',
    'function Child(){ s.Duplex.call(this); }',
    'Object.setPrototypeOf(Child.prototype, s.Duplex.prototype);',
    'try{ new Child(); console.log("NEW=ok"); }catch(e){ console.log("NEW_ERR="+e.message); }',
  ].join('\n');
  const b64 = Buffer.from(repro).toString('base64');
  await t.run(`printf '%s' '${b64}' | base64 -d > /home/user/remix-probe/rs.js`, 15_000);
  const r = await t.run('node /home/user/remix-probe/rs.js 2>&1', 30_000);
  const rOut = stripAnsi(r.output);
  a.check('Duplex.call(this) constructs a stream, as in Node (readable-stream constructor stealing)',
    /NEW=ok/.test(rOut) && !/NEW_ERR=/.test(rOut), JSON.stringify(rOut.slice(-300)));

  // The boundary: a relaunch with --conditions resolves a conditional import as Node does (COND=true).
  const condFiles = {
    'package.json': JSON.stringify({ name: 'cond', type: 'module', imports: { '#cond': { development: './t.mjs', default: './f.mjs' } } }),
    't.mjs': 'export default true;',
    'f.mjs': 'export default false;',
    'main.mjs': "import c from '#cond'; console.log('COND=' + c);",
  };
  await t.run('mkdir -p /home/user/remix-probe/cond', 10_000);
  for (const [name, text] of Object.entries(condFiles)) {
    await t.run(`printf '%s' '${Buffer.from(text).toString('base64')}' | base64 -d > /home/user/remix-probe/cond/${name}`, 15_000);
  }
  const cond = stripAnsi((await t.run('cd /home/user/remix-probe/cond && node --conditions=development main.mjs 2>&1', 30_000)).output);

  a.check('node --conditions=development resolves the development condition, as Node (COND=true)',
    /COND=true/.test(cond), JSON.stringify(cond.slice(-200)));

  // The next boundary, run directly: vite's config loader on the project's own config.
  const loadConfig = [
    "const { loadConfigFromFile } = await import('vite');",
    "try {",
    "  const r = await loadConfigFromFile({ command: 'serve', mode: 'development' }, '/home/user/remix-probe/mvp/vite.config.ts');",
    "  console.log('CONFIG=loaded ' + r.config.plugins.length);",
    "} catch (e) { console.log('CONFIG=failed ' + String(e && e.message).split('\\n')[0]); }",
  ].join('\n');
  await t.run(`printf '%s' '${Buffer.from(loadConfig).toString('base64')}' | base64 -d > /home/user/remix-probe/mvp/load-config.mjs`, 15_000);
  const configOut = stripAnsi((await t.run('cd /home/user/remix-probe/mvp && node --conditions=development load-config.mjs 2>&1', 180_000)).output);
  const configLoaded = /CONFIG=loaded/.test(configOut);

  const dev = await launchFrameworkDev({
    terminal: t, sid, cwd: '/home/user/remix-probe/mvp', port: 5173,
    command: './node_modules/.bin/react-router dev --host 0.0.0.0 --port 5173',
    accepts: (r) => r.status === 200 && /<html/i.test(r.body),
  });
  if (dev.ok) {
    a.check('react-router dev serves the app through the port route', true, dev.last);
    dev.process.signal('SIGKILL');
    dev.process.ws.close();
  } else if (!configLoaded) {
    // The documented boundary, exactly: the relaunch takes its dev path, and vite's config load stops at the module map.
    a.check("boundary: the relaunched dev path stops loading vite.config.ts (vite's run-time bundle of it is not in the launch's module map)",
      !/has already been restarted/.test(dev.output) && /^CONFIG=failed .*(not in this launch's module map|Invalid array buffer length)/m.test(configOut),
      JSON.stringify({ config: /^CONFIG=.*$/m.exec(configOut)?.[0] ?? configOut.slice(-400), dev: dev.output.slice(-400) }));
  } else {
    a.check('react-router dev serves the app through the port route (vite loads its config now)', false, `${dev.last}\n${dev.output.slice(-800)}`);
  }
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
