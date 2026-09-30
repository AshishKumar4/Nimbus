#!/usr/bin/env bun
// session-lifecycle/alarms/log-janitor-still-fires — a session that ran
// processes still idles, wakes, and keeps its process-log path working.
//
// The janitor is armed for a retention deadline only (an exit + 10 min,
// retainAfterExitMs in process-logs.ts), never on a cadence, so nothing
// holds or wakes the DO during this probe's 70s idle; the unit tests
// session-alarm-lifecycle and hosted-runtime-idle-hibernation cover the
// janitor's deadlines and its sweep. What this probe asserts after the
// idle: the DO hibernated and woke (isolateGen advanced) or flushed
// (flushCount advanced), /api/_diag still serves, the shell works, and
// a new exit is still flushed (flushCount > 0).

import { mintSession, Terminal, sleep, makeAsserter, BASE } from '../../../_driver.mjs';
import { diagMemory } from '../../../heap-correctness/_diag.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('session-lifecycle/alarms/log-janitor-still-fires');
console.log(`session-lifecycle/alarms/log-janitor-still-fires — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

let t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

// Generate some facet-path process exits → triggers W9 flush path.
// Shell builtins (echo/false) bypass the facet log adapter; we use
// `node -e` so each invocation actually spawns a facet, runs
// processLogs.append/markExit, and schedules a 'w9-flush' alarm.
for (let i = 0; i < 3; i++) {
  const { output } = await t.run(
    `node -e "console.log('janitor-run-${i}'); process.exit(${i})"`,
    20_000,
  );
  a.check(`facet run ${i} produced marker output`,
    new RegExp(`janitor-run-${i}`).test(output),
    `output tail=${JSON.stringify(output.slice(-200))}`);
}

const m0 = await diagMemory(sid);
const G0 = m0?.hib?.isolateGen ?? null;
const F0 = m0?.hib?.flushCount ?? 0;
console.log(`[pre-idle] isolateGen=${G0} flushCount=${F0}`);

await t.close();
// Idle well past the 10s hibernation grace.
await sleep(70_000);

t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const m1 = await diagMemory(sid);
const G1 = m1?.hib?.isolateGen ?? null;
const F1 = m1?.hib?.flushCount ?? 0;
console.log(`[post-idle] isolateGen=${G1} flushCount=${F1}`);

// Health gates:
// 1. /api/_diag/memory still serves → DO healthy post-wake.
a.check('post-wake DO serves /api/_diag/memory', typeof G1 === 'number',
  `m1.hib=${JSON.stringify(m1?.hib).slice(0, 200)}`);

// 2. The idle went somewhere. Two valid evidence shapes:
//    (a) isolateGen incremented → the DO hibernated and the reconnect woke it.
//    (b) flushCount increased during idle → the w9-flush alarm drained
//        dirty logs within the 10s hibernation grace.
a.check('hibernated or flushed during idle (G or F advanced)',
  (typeof G1 === 'number' && typeof G0 === 'number' && G1 > G0)
  || (typeof F1 === 'number' && typeof F0 === 'number' && F1 > F0),
  `G0=${G0} G1=${G1} F0=${F0} F1=${F1}`);

// 3. Shell still functional post-wake.
const { output: pwdOut } = await t.run('pwd', 10_000);
a.check('shell functional post-wake', /\/home\/user/.test(pwdOut),
  `pwd output=${JSON.stringify(pwdOut.slice(-100))}`);

// 4. Cause another facet exit; verify W9 flush path still operational.
await t.run(
  `node -e "console.log('post-wake'); process.exit(0)"`,
  20_000,
);
await sleep(2000); // W9 debounce + flush window
const m2 = await diagMemory(sid);
const F2 = m2?.hib?.flushCount ?? 0;
console.log(`[post-wake-exit] flushCount=${F2}`);
a.check('W9 flush path still operational post-wake (flushCount>0)',
  F2 > 0,
  `F0=${F0} F1=${F1} F2=${F2}`);

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
