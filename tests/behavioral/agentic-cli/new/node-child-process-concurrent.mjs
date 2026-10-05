#!/usr/bin/env bun
// agentic-cli/new/node-child-process-concurrent — an agent CLI runs a server
// child beside other children (`npm run dev` and its tests, a language server
// and a build), and Node runs them at once. What the user sees:
//   - a child that is still running does not hold back a second child: B
//     prints while A runs, in about the time a child takes alone;
//   - a child spawned after a kill runs at once;
//   - a burst of 14 children (wider than the Durable Object's 10 Dynamic
//     Workers) all run and exit 0, none refused;
//   - a child that spawns a grandchild and waits for it finishes.
// Before, a session's children ran one at a time behind a single dispatch
// slot: B waited the whole of A's life, a kill freed nothing until A's
// program ended on its own, and a grandchild deadlocked behind its parent.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/node-child-process-concurrent');

const source = `
import { spawn } from 'node:child_process';

const t0 = Date.now();
const at = () => Date.now() - t0;
const collect = (command, args) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let firstByte = null;
  child.stdout.on('data', (d) => { if (firstByte === null) firstByte = Date.now() - started; stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.on('close', (code, signal) => resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim(), firstByte }));
});

// A child alone: the time a child takes, to measure B against.
const solo = await collect('node', ['-e', "console.log('SOLO')"]);
console.log('SOLO_FIRST_BYTE_MS=' + solo.firstByte);

// A runs for 20 s; B is spawned while it runs.
const aStarted = at();
const aDone = collect('node', ['-e', "setTimeout(() => console.log('A done'), 20000)"]);
const b = await collect('node', ['-e', "console.log('B ran')"]);
console.log('B_OUT=' + b.stdout + ' B_CODE=' + b.code + ' B_FIRST_BYTE_MS=' + b.firstByte);
const aResult = await aDone;
console.log('A_OUT=' + aResult.stdout + ' A_CODE=' + aResult.code + ' A_LIFE_MS=' + (at() - aStarted));

// A long child, killed; then a child spawned after the kill.
const long = spawn('node', ['-e', "console.log('LONG up'); setTimeout(() => {}, 300000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve) => long.stdout.once('data', resolve));
long.kill();
const closedBy = await new Promise((resolve) => long.on('close', (_code, signal) => resolve(signal)));
const after = await collect('node', ['-e', "console.log('AFTER ran')"]);
console.log('KILLED_BY=' + closedBy + ' AFTER_OUT=' + after.stdout + ' AFTER_FIRST_BYTE_MS=' + after.firstByte);

// 14 children at once, each running 3 s.
const burstStarted = at();
const burst = await Promise.all(Array.from({ length: 14 }, (_, i) =>
  collect('node', ['-e', 'setTimeout(() => console.log("C' + i + '"), 3000)'])));
console.log('BURST_OK=' + burst.filter((r, i) => r.code === 0 && r.stdout === 'C' + i).length + '/14 BURST_MS=' + (at() - burstStarted));
for (const [i, r] of burst.entries()) if (r.code !== 0) console.log('BURST_FAIL C' + i + ' ' + r.code + ' ' + r.stderr.slice(0, 300));

// A child that spawns a grandchild and waits for it.
const nested = await collect('node', ['-e', "const g = require('child_process').spawn('node', ['-e', 'console.log(1+1)']); let o = ''; g.stdout.on('data', (d) => { o += d; }); g.on('close', (code) => console.log('G said ' + o.trim() + ' code ' + code));"]);
console.log('NESTED=' + nested.stdout + ' NESTED_CODE=' + nested.code);
`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run(heredocCommand('concurrent-children.mjs', source), 10_000);
const run = await t.run('node concurrent-children.mjs', 240_000);
const out = stripAnsi(run.output);
const num = (re) => Number(re.exec(out)?.[1] ?? NaN);
const detail = JSON.stringify(out.slice(-1500));

const solo = num(/SOLO_FIRST_BYTE_MS=(\d+)/);
const bFirst = num(/B_FIRST_BYTE_MS=(\d+)/);
const aLife = num(/A_LIFE_MS=(\d+)/);
a.check('B runs and exits 0 while A runs', /B_OUT=B ran B_CODE=0/.test(out), detail);
a.check('A runs to its own end', /A_OUT=A done A_CODE=0/.test(out), detail);
a.check(`B prints while A runs, about as soon as a child alone (B ${bFirst} ms, alone ${solo} ms, A ${aLife} ms)`,
  bFirst < solo + 3_000 && bFirst < aLife - 10_000, detail);
const afterFirst = num(/AFTER_FIRST_BYTE_MS=(\d+)/);
a.check('a killed child closes by its signal', /KILLED_BY=SIGTERM/.test(out), detail);
a.check(`a child spawned after the kill runs at once (${afterFirst} ms, alone ${solo} ms)`,
  /AFTER_OUT=AFTER ran/.test(out) && afterFirst < solo + 3_000, detail);
a.check('14 children at once, wider than the Dynamic Worker limit, all run and exit 0', /BURST_OK=14\/14/.test(out), detail);
a.check('a child that waits for its own child finishes', /NESTED=G said 2 code 0 NESTED_CODE=0/.test(out), detail);
console.log(`timings: solo=${solo} ms, B=${bFirst} ms beside A (${aLife} ms), after kill=${afterFirst} ms, burst=${num(/BURST_MS=(\d+)/)} ms`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
