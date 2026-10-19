#!/usr/bin/env bun
// clang-state/new/concurrent-compiles-one-session — clang compile+link runs
// at once in one session all finish, and the session is not reset.
//
// Several sessions share one isolate and its memory limit, so k compiles at
// once in one session load it as k co-tenants compiling at once do. Each
// compile's images are read into the session isolate for the facet's load.
// Each step runs k at once, k = 1, 3, 5, and prints its wall time.

import { mintSession, Terminal, makeAsserter, stripAnsi, heredocCommand } from '../../_driver.mjs';
import { atOnce } from '../../_at-once.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang-state/new/concurrent-compiles-one-session');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install clang', 180_000);

for (const k of [1, 3, 5]) {
  const names = Array.from({ length: k }, (_, i) => `k${k}_${i}`);
  for (const [i, name] of names.entries()) {
    await t.run(heredocCommand(`${name}.c`, `#include <stdio.h>\nint main(void) { printf("RAN_${name}\\n"); return ${i + 1}; }`), 10_000);
  }
  const step = await atOnce(t, names.map((name) => `clang ${name}.c -o ${name}`), 300_000);
  console.log(`STEP clang k=${k} ${step.ms} ms ${step.survived ? 'survived' : 'lost'}`);
  a.check(`k=${k}: the session survives ${k} compiles at once`, step.survived, step.detail);
  if (!step.survived) break;
  for (const [i, name] of names.entries()) {
    const text = stripAnsi((await t.run(`./${name}; echo RC=$?`, 30_000)).output);
    a.check(`k=${k}: ./${name} runs`, text.includes(`RAN_${name}`) && text.includes(`RC=${i + 1}`), JSON.stringify(text.slice(-200)));
  }
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
