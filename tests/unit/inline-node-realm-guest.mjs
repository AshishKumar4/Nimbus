#!/usr/bin/env bun
// A program in the inline node's realm cannot take its host down, and its
// realm lives exactly as long as a Node process would (Kinu ask 17, review).
//
// Each case runs in a child process of its own (CASE=<name>), so a case that
// kills its host fails alone, and the next still runs:
//
//   start     a realm whose start message comes late still starts;
//   port      a guest that reaches for the host's call port finds none in
//             workerData, and one that takes the real port off its own posts
//             and sends calls no host method answers is refused, with the
//             host up;
//   body      a loopback response whose body fails is answered to the guest
//             as a failed request, with the host up;
//   abort     an abort that arrives while the realm is still starting ends it;
//   timer     a server a timer starts after the main script keeps the realm;
//   rejection a rejection nothing handles ends the process with 1, a server
//             listening or not; an ES module whose top-level await never
//             settles exits 13, as Node does;
//   vfserror  a filesystem refusal keeps its class: rm({ force: true }) of a
//             missing path succeeds; a plain error keeps its errno;
//   cost      a trivial ES module, and CommonJS and ES modules that load http
//             without a server, end as soon as their event loop is empty.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CASES = ['start', 'port', 'body', 'abort', 'timer', 'rejection', 'vfserror', 'cost'];

if (process.env.CASE === undefined) {
  const failed = [];
  for (const name of CASES) {
    const child = spawnSync('bun', [fileURLToPath(import.meta.url)], { env: { ...process.env, CASE: name }, encoding: 'utf8', timeout: 120_000 });
    const passed = child.status === 0 && child.stdout.includes(`case ${name} ok`);
    console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}${passed ? '' : `: status ${child.status} ${child.signal ?? ''}\n${(child.stdout + child.stderr).slice(-1500)}`}`);
    if (!passed) failed.push(name);
  }
  assert.deepEqual(failed, [], 'every case passed');
  console.log('ok - inline-node-realm-guest (a guest cannot take its host down; its realm lives as long as Node\'s process)');
  process.exit(0);
}

const { NimbusWorkspace } = await import('../../packages/core/src/workspace/nimbus-workspace.ts');
const { createSqliteVfsTestHarness } = await import('./sqlite-vfs-test-harness.mjs');
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1 });
const run = async (command, options = {}) => {
  const result = await ws.exec(command, { cwd: '/home/user', ...options });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
};
const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: not settled after ${ms} ms`)), ms)),
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The host stays up: a rejection nothing handles would end this process.
process.on('unhandledRejection', (reason) => { console.log(`HOST unhandled rejection: ${reason?.stack ?? reason}`); process.exit(3); });

switch (process.env.CASE) {
  case 'start': {
    // A host descheduled between starting the worker and posting its start:
    // each start message is posted 100 ms late.
    const { Worker } = await import('node:worker_threads');
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args) { setTimeout(() => post.apply(this, args), 100); };
    const r = await within(run('node -e "console.log(\'started\')"'), 20_000, 'a late start message');
    assert.equal(r.out, 'started\n', `a realm whose start comes late still starts: ${r.err}`);
    Worker.prototype.postMessage = post;
    break;
  }
  case 'port': {
    // CommonJS, so the import() is the realm's own, not node-compat's.
    const reach = await run(`node -e "const p = import('node:worker_threads'); p.then(({ workerData }) => console.log('PORTS ' + JSON.stringify(Object.keys(workerData ?? {}))))"`);
    assert.equal(reach.out, 'PORTS []\n', `the realm's workerData holds no port: ${reach.err}`);
    // The real route: take the port off the guest's own next post, then send
    // the host what no host method answers.
    const escape = [
      "const p = import('node:worker_threads');",
      'p.then(({ MessagePort }) => {',
      '  const post = MessagePort.prototype.postMessage;',
      '  let taken = null;',
      '  MessagePort.prototype.postMessage = function (...args) { if (!taken) taken = this; return post.apply(this, args); };',
      "  require('fs').existsSync('/home/user');",
      '  MessagePort.prototype.postMessage = post;',
      // Each as a call the host's transport carries ({ id, request, wait }), so it reaches the dispatcher, which refuses it.
      '  const refused = [];',
      '  taken.on(\'message\', (m) => { if (m && m.id >= 9000) refused.push(m.id + (m.error ? \' refused\' : \' answered\')); });',
      "  [{ op: 'fs', method: 'valueOf', args: [] }, { op: 'fs', method: 'constructor', args: [] }, { op: 'fs', method: 'exists', args: [42] }, { op: 'nope' }, null].forEach((request, i) => {",
      '    try { taken.postMessage({ id: 9000 + i, request, wait: false }); } catch (e) { console.log(\'NOT SENT \' + e.message); }',
      '  });',
      "  console.log('SENT ' + (taken !== null));",
      "  setTimeout(() => console.log('ANSWERS ' + refused.sort().join(',')), 300);",
      '});',
    ].join(' ');
    const escaped = await within(run(`node -e "${escape}"`), 20_000, 'a guest posting on the host\'s port');
    assert.match(escaped.out, /^SENT true$/m, `the guest took a real port: ${escaped.out}${escaped.err}`);
    assert.match(escaped.out, /^ANSWERS 9000 refused,9001 refused,9002 refused,9003 refused,9004 refused$/m,
      `each forged call reached the host's dispatcher and was refused: ${escaped.out}${escaped.err}`);
    await sleep(500);
    assert.equal((await run('echo up')).out, 'up\n', 'the host is up');
    // A guest that does hold a port of the host's, whatever it posts, is answered or ignored.
    const { serveRealmCall } = await import('../../packages/core/src/substrate/lifo/commands/system/node-realm.ts');
    const services = { filesystem: () => ({ exists: () => true, readFile: () => new Uint8Array([1]), stat: () => ({ type: 'file', mode: 0o644, size: 1 }) }) };
    for (const call of [
      { op: 'fs', method: 'valueOf', args: [] },
      { op: 'fs', method: 'constructor', args: [] },
      { op: 'fs', method: '__proto__', args: [] },
      { op: 'fs', method: 'exists', args: [{ toString() { return '/x'; } }] },
      { op: 'fs', method: 'readFile', args: [] },
      { op: 'nope' },
      null,
      { op: 'listen', port: 'eighty' },
    ]) {
      const answer = await serveRealmCall(call, services);
      assert.ok('error' in answer, `${JSON.stringify(call)} is refused: ${JSON.stringify(answer)}`);
      structuredClone(answer);
    }
    assert.deepEqual(await serveRealmCall({ op: 'fs', method: 'exists', args: ['/x'] }, services), { value: true });
    // An answer that cannot cross is answered as an error.
    const odd = { filesystem: () => ({ stat: () => ({ type: 'file', mode: 0, size: 0, f() {} }) }) };
    const unclonable = await serveRealmCall({ op: 'fs', method: 'stat', args: ['/x'] }, odd);
    assert.ok('error' in unclonable, `an answer that cannot be cloned is an error: ${JSON.stringify(unclonable)}`);
    assert.equal((await run('echo up')).out, 'up\n');
    break;
  }
  case 'body': {
    ws.kernel.routeLoopback = async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('body failed')); } }));
    const r = await within(run(`node -e "require('http').get('http://localhost:9911/', (res) => { res.on('data', () => {}); res.on('end', () => console.log('END')); }).on('error', (e) => console.log('ERR ' + e.message))"`), 20_000, 'the guest request');
    assert.match(r.out, /^ERR /m, `the guest sees its request fail: ${r.out}${r.err}`);
    await sleep(200);
    assert.equal((await run('echo up')).out, 'up\n');
    break;
  }
  case 'abort': {
    // Aborts landing anywhere in the realm's start: after each number of
    // microtask hops, which walks the abort through every await on the way
    // to the worker; then after timers.
    const hops = (n) => new Promise((resolve) => {
      const step = (left) => (left === 0 ? resolve() : queueMicrotask(() => step(left - 1)));
      step(n);
    });
    for (let n = 0; n < 400; n += 3) {
      const controller = new AbortController();
      const pending = run('node -e "while (true) {}"', { signal: controller.signal });
      void hops(n).then(() => controller.abort());
      const r = await within(pending, 10_000, `an abort after ${n} microtask hops`);
      assert.notEqual(r.code, 0, `an abort after ${n} hops ended the run`);
    }
    for (let delay = 0; delay < 12; delay++) {
      const controller = new AbortController();
      const pending = run('node -e "while (true) {}"', { signal: controller.signal });
      if (delay === 0) controller.abort();
      else setTimeout(() => controller.abort(), delay);
      const r = await within(pending, 10_000, `an abort ${delay} ms in`);
      assert.notEqual(r.code, 0, `an abort ${delay} ms in ended the run`);
    }
    break;
  }
  case 'timer': {
    const controller = new AbortController();
    const server = run(`node -e "setTimeout(() => require('http').createServer((q, s) => s.end('late ok')).listen(8123), 50)"`, { signal: controller.signal });
    let settled = false;
    server.then(() => { settled = true; });
    await sleep(1000);
    assert.equal(settled, false, 'the realm is still up: its server listens');
    const response = await ws.kernel.portRegistry.get(8123);
    assert.ok(response, 'the timer\'s server is listening');
    const fetched = await run('curl -s http://localhost:8123/');
    assert.equal(fetched.out.trim(), 'late ok');
    controller.abort();
    await within(server, 10_000, 'the server after its abort');
    // An https-only server keeps its realm as well.
    const secure = new AbortController();
    const https = run(`node -e "require('https').createServer((q, s) => s.end('s')).listen(8124)"`, { signal: secure.signal });
    let secureSettled = false;
    https.then(() => { secureSettled = true; });
    await sleep(800);
    assert.equal(secureSettled, false, 'an https server keeps its realm');
    secure.abort();
    await within(https, 10_000, 'the https server after its abort');
    break;
  }
  case 'rejection': {
    const served = await within(run(`node -e "require('http').createServer(() => {}).listen(8125); setTimeout(() => Promise.reject(new Error('boom')), 50)"`), 20_000, 'a server with a rejection');
    assert.equal(served.code, 1, `a rejection nothing handles ends the process with 1: ${served.err}`);
    assert.match(served.err, /boom/);
    assert.equal(ws.kernel.portRegistry.has(8125), false, 'its server is gone');
    await ws.fs.mkdir('/home/user/m', { recursive: true });
    await ws.fs.writeFile('/home/user/m/tla.mjs', 'console.log("before");\nawait new Promise(() => {});\nconsole.log("never");\n');
    const tla = await within(run('node m/tla.mjs'), 20_000, 'an unsettled top-level await');
    assert.equal(tla.code, 13, `an ES module whose top-level await never settles exits 13, as Node: ${tla.err}`);
    assert.equal(tla.out, 'before\n');
    assert.match(tla.err, /unsettled top-level await/);
    break;
  }
  case 'vfserror': {
    const r = await run(`node -e "const fs = require('fs'); fs.promises.rm('/home/user/nope', { force: true }).then(() => console.log('RM ok'), (e) => console.log('RM ' + e.constructor.name + ' ' + e.code))"`);
    assert.equal(r.out, 'RM ok\n', `rm({ force: true }) of a missing path succeeds: ${r.err}`);
    const code = await run(`node -e "try { require('fs').readFileSync('/home/user/nope'); } catch (e) { console.log(e.code + ' ' + e.syscall + ' ' + e.message) }"`);
    assert.equal(code.out, "ENOENT open ENOENT: no such file or directory, open '/home/user/nope'\n");
    // A plain error, as a mounted backend raises one, keeps every field across.
    const { fromRealmError, realmError } = await import('../../packages/core/src/runtime/realm.ts');
    const plain = Object.assign(new Error("EACCES: permission denied, open '/pc/x'"), { code: 'EACCES', errno: -13, syscall: 'open', path: '/pc/x' });
    const rebuilt = fromRealmError(structuredClone(realmError(plain)));
    assert.deepEqual([rebuilt.message, rebuilt.code, rebuilt.errno, rebuilt.syscall, rebuilt.path], [plain.message, 'EACCES', -13, 'open', '/pc/x'], 'a plain error keeps its errno');
    break;
  }
  case 'cost': {
    await ws.fs.mkdir('/home/user/m', { recursive: true });
    await ws.fs.writeFile('/home/user/m/one.mjs', 'export {};\nconsole.log(1);\n');
    await run('node m/one.mjs');
    const time = async (line) => {
      const times = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        const r = await run(line);
        assert.equal(r.code, 0, r.err);
        times.push(performance.now() - t);
      }
      return times.sort((a, b) => a - b)[2];
    };
    await ws.fs.writeFile('/home/user/m/http.mjs', "import 'http';\nconsole.log(1);\n");
    const trivial = await time('node m/one.mjs');
    const http = await time(`node -e "require('http'); console.log(1)"`);
    const esmHttp = await time('node m/http.mjs');
    console.log(`  a trivial ES module: ${trivial.toFixed(1)} ms; loading http without a server: ${http.toFixed(1)} ms (CommonJS), ${esmHttp.toFixed(1)} ms (ES module)`);
    assert.ok(trivial < 100, `a trivial ES module ends as its event loop empties (${trivial.toFixed(0)} ms)`);
    assert.ok(http < 100, `loading http without a server ends as its event loop empties (${http.toFixed(0)} ms)`);
    assert.ok(esmHttp < 100, `an ES module loading http without a server ends as its event loop empties (${esmHttp.toFixed(0)} ms)`);
    break;
  }
}
await ws.close();
console.log(`case ${process.env.CASE} ok`);
process.exit(0);
