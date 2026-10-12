// @serial
// @tier slow — drives a local workerd; 30-46 s alone, up to 111 s on 4 CPUs beside 12 busy loops
// Resident Node guests under workerd: a server's launch, how it learns for
// the next one, and how it ends.
//
// What has to hold:
//   - A resident process runs the code it produces at runtime in the launch
//     that produced it, and its exit report stages that code, so the next
//     launch of the same command runs it natively.
//   - An SSR server can catch a missing module without exiting: the file miss
//     is persisted before startup is acknowledged, so a forced kill (no exit
//     report) does not lose it for the next launch.
//   - A native server that is closed, or unref'd, ends the process by itself
//     (no runner deadline), with no timer of its own left: the process ends,
//     as the session's process table records it, though its launch returned
//     the prompt as a resident.
//
// One of five files, each its own local workerd and session, so each fits
// the suite's per-file budget on a loaded machine (together they took
// 240-260 s alone, against run-all's 300 s): runtime code
// (node-runtime-code-workerd); stdin (node-runtime-code-stdin-workerd);
// a 48 MiB `< file` handed and refused (node-runtime-code-stdin-file-workerd)
// and streamed (node-runtime-code-stdin-stream-workerd); resident processes
// (node-runtime-code-resident-workerd).
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/w';
const FILES = {
  'server.js': [
    'require("http").createServer((q, s) => s.end("ok")).listen(7071);',
    'setTimeout(() => {',
    '  let r;',
    '  try { r = new (Object.getPrototypeOf(function* () {}).constructor)("yield \\"resident-ok \\" + (new Error().stack.includes(\\"/gen/\\") ? \\"native\\" : \\"interpreted\\")")().next().value; } catch (e) { r = e.code || e.name; }',
    '  require("fs").writeFileSync("/home/user/w/resident.txt", String(r));',
    '  process.exit(0);',
    '}, 300);',
  ].join('\n'),
  'node_modules/late-module/package.json': '{"name":"late-module","main":"unused.js"}',
  'node_modules/late-module/unused.js': 'module.exports = "unused";',
  'node_modules/late-module/deep/hidden.cjs': 'module.exports = "learned-live-file";',
  'caught.js': [
    'require("http").createServer((q,s)=>s.end("alive")).listen(7072);',
    'let result; try { result = require(process.cwd()+"/node_modules/"+["late","module"].join("-")+"/deep/"+["hid","den"].join("")+".cjs"); } catch(e) { result="CAUGHT "+e.message; }',
    'require("fs").writeFileSync("/home/user/w/caught.txt",String(result));',
  ].join('\n'),
};

console.log('node-runtime-code-resident-workerd: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(FILES)).toString('base64');
    const setup = await terminal.run(
      `mkdir -p ${W}/node_modules/late-module/deep && node -e "const f = JSON.parse(Buffer.from('${payload}', 'base64').toString()); for (const [n, t] of Object.entries(f)) require('fs').writeFileSync('${W}/' + n, t); console.log('SETUP')"`,
    );
    assert.match(setup.stdout, /SETUP/, setup.stdout);

    /** `pid`'s status in the session's process table (ps). */
    const statusOf = async (pid) => new RegExp(`^\\s*${pid}\\s+(\\S+)`, 'm').exec((await terminal.run('ps')).stdout)?.[1];
    /** `pid`'s status once it has ended (no longer `running`), waited for up to 60 s. */
    const ended = async (pid) => {
      let status = await statusOf(pid);
      for (const until = Date.now() + 60_000; status === 'running' && Date.now() < until; status = await statusOf(pid)) await Bun.sleep(250);
      return status;
    };
    const residentResult = async () => {
      for (let i = 0; i < 120; i++) {
        const r = await terminal.run(`cat ${W}/resident.txt 2>/dev/null`);
        if (r.stdout.trim()) return r.stdout.trim();
        await Bun.sleep(500);
      }
      return '(no result)';
    };
    const firstServer = await terminal.run(`cd ${W} && node server.js`);
    assert.equal(await residentResult(), 'resident-ok interpreted', 'a resident process runs the code in the launch that produced it');
    // Its exit report stages the code: the next launch waits for that exit
    // (it writes its result, then exits), not for a second.
    const firstPid = Number(/pid=(\d+)/.exec(firstServer.stdout)?.[1]);
    assert.ok(firstPid > 0, firstServer.stdout);
    assert.equal(await ended(firstPid), 'exited(0)', 'the first server ended by its own exit');
    await terminal.run(`rm -f ${W}/resident.txt`);
    await terminal.run(`cd ${W} && node server.js`);
    assert.equal(await residentResult(), 'resident-ok native', 'and its exit report staged it for the next launch');
    // An SSR server can catch a missing module without exiting. Persist that
    // file miss before acknowledging startup, so killing it does not lose
    // the dependency and make every subsequent launch repeat the same error.
    const caughtFile = async () => {
      for (let n = 0; n < 100; n++) {
        const r = await terminal.run('cat ' + W + '/caught.txt');
        if (r.status === 0) return r.stdout.trim();
        await Bun.sleep(50);
      }
      const ps = await terminal.run('ps');
      const logs = await terminal.run('logs ' + caughtPid);
      throw new Error('caught module fixture never wrote its result: ' + JSON.stringify({startup:caughtFirst,ps,logs}));
    };
    const caughtFirst = await terminal.run('cd ' + W + ' && node caught.js');
    const caughtPid = Number(caughtFirst.stdout.match(/pid=(\d+)/)?.[1]);
    assert.ok(caughtPid > 0, caughtFirst.stdout);
    assert.match(await caughtFile(), /^CAUGHT /);
    await terminal.run('kill -KILL ' + caughtPid);
    await terminal.run('rm -f ' + W + '/caught.txt');
    await terminal.run('cd ' + W + ' && node caught.js');
    assert.equal(await caughtFile(), 'learned-live-file', 'a caught file miss survives a forced kill without an exit report');


    // Real workerd uses its own HTTP scheduling, not the Bun fixture's TCP
    // connection sweep. Measure the guest counter while each server is bound,
    // and see the process end by itself once the server is closed or unref'd
    // (no runner deadline). Its launch returns the prompt once it is up, as a
    // resident's does, so the end is read from the process table: a program
    // that never ended would stay `running` there.
    const closeStart = performance.now();
    const closing = await terminal.run(
      `node -e "const s=require('http').createServer();s.listen(0,()=>{console.log('BOUND_TIMERS='+globalThis.__nimbusPendingTimers);s.close(()=>console.log('CLOSED_TIMERS='+globalThis.__nimbusPendingTimers))})"`,
    );
    assert.equal(closing.status, 0, closing.stdout);
    assert.match(closing.stdout, /^BOUND_TIMERS=0$/m);
    assert.match(closing.stdout, /^CLOSED_TIMERS=0$/m);
    const closedPid = Number(/pid=(\d+)/.exec(closing.stdout)?.[1]);
    assert.ok(closedPid > 0, closing.stdout);
    assert.equal(await ended(closedPid), 'exited(0)', 'a closed native server ends its process by itself');
    console.log('workerd native listen/close natural exit: ' + Math.round(performance.now() - closeStart) + 'ms');
    const unrefStart = performance.now();
    const unref = await terminal.run(
      `node -e "const s=require('http').createServer();s.listen(0,()=>{console.log('UNREF_TIMERS='+globalThis.__nimbusPendingTimers);s.unref();console.log('UNREF_OK')})"`,
    );
    assert.equal(unref.status, 0, unref.stdout);
    assert.match(unref.stdout, /^UNREF_TIMERS=0$/m);
    assert.match(unref.stdout, /^UNREF_OK$/m);
    const unrefPid = Number(/pid=(\d+)/.exec(unref.stdout)?.[1]);
    assert.ok(unrefPid > 0, unref.stdout);
    assert.equal(await ended(unrefPid), 'exited(0)', 'an unrefed native listener does not keep the process alive');
    console.log('workerd native listen/unref natural exit: ' + Math.round(performance.now() - unrefStart) + 'ms');

    const beforeExitSource = String.raw`
const events = [];
const server = require('http').createServer((_request, response) => { response.end('closed'); server.close(); });
function broken() { throw new Error('resident beforeExit failure'); }
process.on('beforeExit', broken);
process.on('uncaughtException', (error, kind) => {
  events.push([error.message, kind]);
  process.removeListener('beforeExit', broken);
  setTimeout(() => { events.push('continued'); process.exitCode = 7; }, 0);
});
process.on('exit', (code) => console.log('BEFORE_RESULT ' + JSON.stringify({ code, events })));
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log('BOUND:' + server.address().port));
`;
    const hostBefore = await new Promise((resolve, reject) => {
      const child = spawn('node', ['-e', beforeExitSource], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', error = '', closing = false;
      const deadline = setTimeout(() => child.kill(), 30000);
      child.stdout.on('data', (part) => {
        output += part;
        const port = /BOUND:(\d+)/.exec(output)?.[1];
        if (port && !closing) { closing = true; void fetch('http://127.0.0.1:' + port + '/close').catch(reject); }
      });
      child.stderr.on('data', (part) => { error += part; });
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(deadline); resolve({ code, output, error }); });
    });
    assert.equal(hostBefore.code, 7, hostBefore.error);
    const expectedBefore = JSON.parse(/BEFORE_RESULT ([^\r\n]+)/.exec(hostBefore.output)[1]);
    await terminal.writeFile(W + '/resident-before.js', beforeExitSource);
    const launchedBefore = await terminal.run('cd ' + W + ' && PORT=7073 node resident-before.js');
    const beforePid = Number(/pid=(\d+)/.exec(launchedBefore.stdout)?.[1]);
    assert.ok(beforePid > 0, launchedBefore.stdout);
    await terminal.run('curl -s http://127.0.0.1:7073/close');
    const beforeStatus = await ended(beforePid);
    const beforeCode = /^(?:exited|crashed)\((\d+)\)$/.exec(beforeStatus)?.[1];
    assert.equal(Number(beforeCode), hostBefore.code, 'a handled resident beforeExit throw releases its natural-exit check: ' + beforeStatus);
    const beforeLogs = (await terminal.run('logs ' + beforePid)).stdout;
    const actualBefore = /BEFORE_RESULT ([^\r\n]+)/.exec(beforeLogs)?.[1];
    assert.ok(actualBefore, beforeLogs);
    assert.deepEqual(JSON.parse(actualBefore), expectedBefore, 'resident exception kind and continuation match Node');

    // A client that leaves a response the server has gone quiet on: the
    // guest hears it as Node's server does, its response closed unfinished
    // and later writes refused.
    const abandonSource = String.raw`
const events = [];
const server = require('http').createServer((request, response) => {
  if (request.url === '/report') return response.end(JSON.stringify(events));
  request.on('aborted', () => events.push('request aborted'));
  request.on('close', () => events.push('request close'));
  response.on('finish', () => events.push('response finish'));
  response.on('error', (error) => events.push('response error ' + error.code));
  response.on('close', () => {
    events.push('response close ' + JSON.stringify({ destroyed: response.destroyed, finished: response.writableFinished }));
    response.write('late', (error) => events.push('late write ' + (error?.code ?? 'written')));
  });
  response.writeHead(200);
  response.write(Buffer.alloc(65536, 97));
});
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log('BOUND:' + server.address().port));
`;
    const leave = async (url, headers = {}) => {
      const client = new AbortController();
      // Identity: a compressing hop holds a small first chunk back.
      const response = await fetch(url + '/stall', { headers: { ...headers, 'Accept-Encoding': 'identity' }, signal: client.signal });
      await response.body.getReader().read();
      client.abort();
      for (let i = 0; i < 100; i++) {
        const report = JSON.parse(await (await fetch(url + '/report', { headers })).text());
        if (report.some((event) => event.startsWith('late write')) && report.includes('request close')) return report;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the server never heard its client leave');
    };
    const hostAbandon = await new Promise((resolve, reject) => {
      const child = spawn('node', ['-e', abandonSource], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (part) => {
        output += part;
        const port = /BOUND:(\d+)/.exec(output)?.[1];
        if (port) leave('http://127.0.0.1:' + port).then(resolve, reject).finally(() => child.kill());
      });
      child.on('error', reject);
    });
    await terminal.writeFile(W + '/abandon.js', abandonSource);
    await terminal.run('cd ' + W + ' && PORT=7074 node abandon.js');
    const { requestHeaders } = await import('../behavioral/_driver.mjs');
    const nimbusAbandon = await leave(`${probe.base}/s/${terminal.sid}/port/7074`, requestHeaders());
    // Every event Node's server sees, the resident's sees, and nothing more
    // but one event of workerd's own: a write that fails after the client
    // left cancels the body with a reason, and workerd's ServerResponse
    // (src/node/internal/internal_http_server.ts, body cancel →
    // destroy(reason)) emits it as 'error', which Node's never does.
    for (const event of hostAbandon) assert.ok(nimbusAbandon.includes(event), `a client leaving mid-response reaches the resident server as it reaches Node's: ${event} in ${JSON.stringify(nimbusAbandon)}`);
    assert.deepEqual(nimbusAbandon.filter((event) => !hostAbandon.includes(event) && !event.startsWith('response error')), [], JSON.stringify({ nimbusAbandon, hostAbandon }));
    // Heard as the caller leaving (not as that failed write), the request is aborted before its response closes, as in Node.
    if (!nimbusAbandon.some((event) => event.startsWith('response error'))) assert.deepEqual(nimbusAbandon.slice(0, 2), hostAbandon.slice(0, 2));
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-runtime-code-resident-workerd: resident processes learn for their next launch, keep a caught miss, and end by themselves under workerd');
