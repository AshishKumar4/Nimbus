#!/usr/bin/env bun
// runtime-primitives/undici-platform-http — `undici` resolves to Nimbus's
// platform-HTTP mapping, and installing it does not cost the session its own
// routing.
//
// undici is Node's reference fetch implementation and a very common transitive
// dependency. Its own client needs raw TCP sockets a facet does not have, and
// `undici.install()` replaces globalThis.fetch — which both breaks fetch
// outright and silently drops in-session loopback routing and AI-egress
// mediation, since both live on the patched global fetch.
//
// What a user would see if this regressed: any tool that installs undici (pi
// does, at import time) reports an unexplained "Connection error", and a
// program that reaches for a session port after installing it gets nothing.

import { mintSession, deleteSession, Terminal, makeAsserter, heredocCommand, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('runtime-primitives/undici-platform-http');

const server = `
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('in-session-ok:' + req.url);
}).listen(7311, '0.0.0.0', () => console.log('LISTENING 7311'));
`.trim();

// ESM with top-level await: proves `import … from 'undici'` reaches the same
// mapping the CJS require does (esbuild lowers the import into that require).
const esmProbe = `
import undici, { fetch as undiciFetch, request } from 'undici';

const before = globalThis.fetch;
undici.install();
console.log('SAME_GLOBAL_FETCH=' + String(globalThis.fetch === before));
console.log('UNDICI_FETCH_IS_GLOBAL=' + String(undici.fetch === before));
console.log('ESM_DEFAULT=' + String(undici.default === undici));

const loop = await undiciFetch('http://127.0.0.1:7311/after-install');
console.log('LOOPBACK=' + loop.status + ':' + (await loop.text()));

const viaRequest = await request('http://127.0.0.1:7311/via-request');
console.log('REQUEST=' + viaRequest.statusCode + ':' + (await viaRequest.body.text()));

const viaGlobal = await fetch('http://127.0.0.1:7311/global');
console.log('GLOBAL=' + viaGlobal.status + ':' + (await viaGlobal.text()));
`.trim();

// Everything a facet genuinely cannot do must name the limitation, never
// answer wrongly: proxying and mocking would silently misroute traffic the
// caller believes it redirected or stubbed.
const honestyProbe = `
const undici = require('undici');
for (const [name, fn] of [
  ['ProxyAgent', () => new undici.ProxyAgent('http://proxy:8080')],
  ['MockAgent', () => new undici.MockAgent()],
  ['dispatch', () => new undici.Agent().dispatch({}, {})],
  ['connect', () => undici.connect({ origin: 'https://example.com' })],
  ['interceptors', () => undici.interceptors.retry()],
]) {
  try { fn(); console.log('SILENT=' + name); }
  catch (e) { console.log('THREW=' + name + ':' + String(/^Nimbus: undici\\./.test(e.message))); }
}
// Inert dispatchers cannot change a response, so they are accepted.
undici.setGlobalDispatcher(new undici.Agent({ keepAliveTimeout: 10 }));
console.log('AGENT_ACCEPTED=' + String(undici.getGlobalDispatcher() instanceof undici.Agent));
// undici is an npm package, not node core.
console.log('CLAIMS_BUILTIN=' + String(require('module').builtinModules.includes('undici')));
`.trim();

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  await t.run(heredocCommand('/home/user/undici-server.js', server), 30_000);
  const boot = stripAnsi((await t.run('node /home/user/undici-server.js', 90_000)).output);
  a.check('in-session server is listening',
    /LISTENING 7311|bin started \(long-running\)/.test(boot), JSON.stringify(boot.slice(-600)));
  await sleep(3000);

  await t.run(heredocCommand('/home/user/undici-esm.mjs', esmProbe), 30_000);
  const esm = stripAnsi((await t.run('node /home/user/undici-esm.mjs', 180_000)).output);
  a.check('install() leaves globalThis.fetch as the patched fetch',
    /SAME_GLOBAL_FETCH=true/.test(esm), JSON.stringify(esm.slice(-900)));
  a.check('undici.fetch IS the patched global fetch',
    /UNDICI_FETCH_IS_GLOBAL=true/.test(esm), JSON.stringify(esm.slice(-900)));
  a.check("import … from 'undici' lands on the Nimbus mapping",
    /ESM_DEFAULT=true/.test(esm), JSON.stringify(esm.slice(-900)));
  a.check('undici.fetch reaches an in-session port after install()',
    /LOOPBACK=200:in-session-ok:\/after-install/.test(esm), JSON.stringify(esm.slice(-900)));
  a.check('undici.request reaches an in-session port',
    /REQUEST=200:in-session-ok:\/via-request/.test(esm), JSON.stringify(esm.slice(-900)));
  a.check('global fetch still routes loopback after install()',
    /GLOBAL=200:in-session-ok:\/global/.test(esm), JSON.stringify(esm.slice(-900)));

  await t.run(heredocCommand('/home/user/undici-honesty.js', honestyProbe), 30_000);
  const honest = stripAnsi((await t.run('node /home/user/undici-honesty.js', 120_000)).output);
  for (const name of ['ProxyAgent', 'MockAgent', 'dispatch', 'connect', 'interceptors']) {
    a.check(`undici.${name} fails loud with the limitation named`,
      honest.includes(`THREW=${name}:true`) && !honest.includes(`SILENT=${name}`),
      JSON.stringify(honest.slice(-1200)));
  }
  a.check('an inert dispatcher is accepted',
    /AGENT_ACCEPTED=true/.test(honest), JSON.stringify(honest.slice(-900)));
  a.check('undici is not reported as a node builtin',
    /CLAIMS_BUILTIN=false/.test(honest), JSON.stringify(honest.slice(-900)));

  // A real npm install of the package must not change which module wins.
  const install = stripAnsi((await t.run('cd /home/user && npm install undici 2>&1 | tail -3', 300_000)).output);
  a.check('npm install undici succeeds',
    !/ERR!|npm install failed|command not found/i.test(install), JSON.stringify(install.slice(-900)));
  const installed = stripAnsi((await t.run(
    `cd /home/user && node -e "const u=require('undici'); console.log('INSTALLED=' + String(u.fetch === globalThis.fetch) + ':' + typeof u.request)"`,
    120_000)).output);
  a.check('the installed package does not displace the Nimbus mapping',
    /INSTALLED=true:function/.test(installed), JSON.stringify(installed.slice(-900)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
