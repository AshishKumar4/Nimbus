#!/usr/bin/env bun
// python/concurrent-one-shots-one-session — `python -c` runs at once in one
// session all finish, and the session is not reset.
//
// Each one-shot's interpreter image is read into the session isolate for its
// facet's load, and the isolate's memory limit is shared with every session
// it hosts. Each step runs k at once, k = 1, 5, 10 (ten is a Durable Object's
// limit of Dynamic Workers in flight), and prints its wall time.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';
import { atOnce } from '../_at-once.mjs';
import { installPython } from './_setup.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('python/concurrent-one-shots-one-session');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await installPython(t, a);

for (const k of [1, 5, 10]) {
  const runs = Array.from({ length: k }, (_, i) => i);
  const step = await atOnce(t, runs.map((i) => `python -c 'print("RAN_${k}_${i}")' > py${k}_${i}.out`), 300_000);
  console.log(`STEP python k=${k} ${step.ms} ms ${step.survived ? 'survived' : 'lost'}`);
  a.check(`k=${k}: the session survives ${k} python one-shots at once`, step.survived, step.detail);
  if (!step.survived) break;
  const text = stripAnsi((await t.run(runs.map((i) => `cat py${k}_${i}.out`).join('; '), 30_000)).output);
  a.check(`k=${k}: every one-shot printed`, runs.every((i) => text.includes(`RAN_${k}_${i}`)), JSON.stringify(text.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
