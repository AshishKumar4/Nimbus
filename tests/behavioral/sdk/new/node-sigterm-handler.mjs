#!/usr/bin/env bun
// sdk/node-sigterm-handler — a Node program with a SIGTERM handler hears
// kill('SIGTERM') and exits by its own choice, as on Linux (Kinu ask 67.4):
// when the session's client kills it (sandbox.startProgram's kill, which is
// the session's signalProcess), and when its Node parent does
// (child.kill). One that ignores it runs on until SIGKILL; one with no
// handler ends by the signal. Before, every such kill took the signal's
// default action: the handler never ran.
import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('sdk/node-sigterm-handler');
const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(`node-sigterm-handler-${Date.now()}`);

const HEARS = "process.on('SIGTERM', () => { console.log('heard SIGTERM'); process.exit(7); }); console.log('ready'); setInterval(() => {}, 1000)";
const STUBBORN = "process.on('SIGTERM', () => { console.log('ignored SIGTERM'); }); console.log('ready'); setInterval(() => {}, 1000)";
const PLAIN = "console.log('ready'); setInterval(() => {}, 1000)";
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timed out'), ms))]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `code` started by the session, its output read as it comes; `signals` sent, one a second, once it says it is ready. */
async function killed(code, signals) {
  const started = await box.startProgram(['node', '-e', code]);
  let out = '';
  const reading = (async () => {
    for await (const chunk of started.output) out += new TextDecoder().decode(chunk.data);
  })();
  for (let i = 0; i < 300 && !out.includes('ready'); i++) await sleep(100);
  const states = [];
  for (const signal of signals) {
    started.kill(signal);
    states.push(await within(started.exit.then(() => 'ended'), 1500));
  }
  const exit = await within(started.exit, 30_000);
  await within(reading, 5000);
  return { exit, states, out: out.split('\n').filter(Boolean) };
}

try {
  let ran = await killed(HEARS, ['SIGTERM']);
  a.check('the session\'s kill: the handler hears it and exits 7', JSON.stringify(ran.exit) === JSON.stringify({ code: 7, signal: null }) && ran.out.includes('heard SIGTERM'), JSON.stringify(ran));
  ran = await killed(STUBBORN, ['SIGTERM', 'SIGKILL']);
  a.check('a handler that ignores it: runs on, until SIGKILL', ran.states[0] === 'timed out' && ran.exit?.signal === 'SIGKILL' && ran.out.includes('ignored SIGTERM'), JSON.stringify(ran));
  ran = await killed(PLAIN, ['SIGTERM']);
  a.check('no handler: ended by SIGTERM', ran.exit?.signal === 'SIGTERM' && ran.exit?.code === null, JSON.stringify(ran));

  const parent = `
const { spawn } = require('child_process');
const child = spawn('node', ['-e', ${JSON.stringify(HEARS)}]);
let out = '';
child.stdout.on('data', (d) => { out += d; if (out.includes('ready')) child.kill('SIGTERM'); });
child.on('close', (code, signal) => console.log(JSON.stringify({ code, signal, out: out.split('\\n').filter(Boolean) })));
`;
  await box.files.write('/home/user/parent.js', parent);
  const viaParent = await box.exec('node /home/user/parent.js');
  let seen = null;
  try { seen = JSON.parse(viaParent.stdout.trim().split('\n').pop()); } catch {}
  a.check('its Node parent\'s kill: the handler hears it and exits 7', seen?.code === 7 && seen?.signal === null && seen?.out?.includes('heard SIGTERM'), viaParent.stdout + viaParent.stderr);
} finally {
  await box.destroy({ reason: 'node-sigterm-handler-complete' }).catch(() => {});
}
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
