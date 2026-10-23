#!/usr/bin/env bun
// node/new/sync-miss-reruns — a node one-shot whose synchronous read finds a
// file its process does not hold is run again as a resident process, which
// holds it: the command gets the bytes on its first run, prints what it
// printed before that read once, and ends with its own status after its
// asynchronous work. Its next launch stages the file and runs as a one-shot.
//
// The file lies outside the working tree and is named only on the command
// line, so no launch rule stages it before a run has read it.
//
// Red before: the read failed with EAGAIN, and the run ended 1 with a report
// that the file was not staged; only the next run of the command had it.
import { mintSession, deleteSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('node/new/sync-miss-reruns');

const PAYLOAD = `payload-${crypto.randomUUID()}`;
const PROGRAM = `
const fs = require('fs');
console.log('BEFORE');
const text = fs.readFileSync(process.argv[2], 'utf8').trim();
setTimeout(() => { console.log('READ=' + text); process.exitCode = 3; }, 200);
`;
const lines = (text) => stripAnsi(text).split('\n').map((line) => line.trim()).filter(Boolean);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  for (const line of ['mkdir -p /home/user/d21/app /home/user/d21-data', heredocCommand('/home/user/d21-data/x.txt', PAYLOAD), heredocCommand('/home/user/d21/app/main.js', PROGRAM)]) {
    const r = await t.run(line, 30_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${line.slice(0, 60)}: ${r.output.slice(-300)}`);
  }
  for (const run of ['first', 'second']) {
    const r = await t.run('cd /home/user/d21/app && node main.js /home/user/d21-data/x.txt', 120_000);
    const said = lines(r.output);
    console.log(JSON.stringify({ run, exit: r.exitCode, tail: said.slice(-6) }));
    a.check(`${run} run: it read the file, after its asynchronous work, and ended with its own status (3)`,
      said.includes(`READ=${PAYLOAD}`) && r.exitCode === 3, JSON.stringify({ exit: r.exitCode, tail: said.slice(-8) }));
    a.check(`${run} run: what it printed before the read is shown once`,
      said.filter((line) => line === 'BEFORE').length === 1, JSON.stringify(said.slice(-8)));
    a.check(`${run} run: no read failed`, !said.some((line) => /EAGAIN|never staged/.test(line)), JSON.stringify(said.slice(-8)));
  }
} catch (error) {
  a.check('probe completes', false, String(error?.stack ?? error).slice(0, 2000));
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
