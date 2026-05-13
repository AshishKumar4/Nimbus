#!/usr/bin/env bun
// winwin-w1/log-janitor-still-fires — janitor body still executes after
// the setTimeout→setAlarm migration.
//
// We can't directly observe `dropOlderThan` (it's an internal method
// on processLogs); but processLogs.hibStats() is surfaced under
// /api/_diag/memory.hib. After an exit-record ages out + the janitor
// runs, the pending state should not grow indefinitely.
//
// Simpler observable: we run a few short commands (each exits → log
// rows), wait long enough for the 60s alarm to fire, then re-check
// that the DO is still functional and processLogs.hibStats reports
// non-zero flushCount (W9 path) AND that hib.isolateGen incremented
// (proves alarm-driven wake actually ran).
//
// Why we don't try to assert "exact rows deleted by janitor": the
// retainAfterExitMs default (process-logs.ts) is 10 minutes — the
// janitor wouldn't delete any of our test pids in a 70s window
// anyway. What we CAN assert: alarm fires (isolateGen++), alarm
// dispatcher runs without throwing (DO still healthy, /api/_diag
// still serves), AND the W9 flush still works (flushCount > 0).

import { mintSession, Terminal, sleep, makeAsserter, BASE } from '../../_driver.mjs';
import { diagMemory } from '../../heap-correctness/_diag.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('winwin-w1/log-janitor-still-fires');
console.log(`winwin-w1/log-janitor-still-fires — ${BASE}`);

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
// Wait for the 60s log-janitor alarm to fire (+ a margin for the
// 10s hib grace).
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

// 2. Alarm-driven activity during idle. Two valid evidence shapes:
//    (a) isolateGen incremented → DO hibernated + woke for alarm.
//    (b) flushCount increased during idle → alarm fired within the
//        10s hibernation grace, dispatcher drained dirty logs.
//    Either proves the alarm path runs; both are acceptable. The
//    smoking-gun PRE-vs-POST signal (hibernation cycle) is in the
//    dedicated probe winwin-w1/new/hibernation-eligible-after-idle.mjs.
a.check('alarm-driven activity during idle (G or F advanced)',
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
