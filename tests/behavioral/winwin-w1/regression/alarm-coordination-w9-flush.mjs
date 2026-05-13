#!/usr/bin/env bun
// winwin-w1/alarm-coordination-w9-flush — W9 flush still fires under
// the new multi-reason alarm dispatcher.
//
// Pre-W1, dispatchAlarm() always called processLogs.flush(). Post-W1,
// dispatchAlarm() reads the W1_NEXT_ALARM_REASONS_KEY map and runs the
// per-reason handlers. The W9 path now schedules 'w9-flush' via
// scheduleAlarm() instead of calling setAlarm directly.
//
// Regression: ensure that an exit-triggered W9 schedule still produces
// a flush. We measure this via hib.flushCount which increments on every
// processLogs.flush() that has dirty data.

import { mintSession, Terminal, sleep, makeAsserter, BASE } from '../../_driver.mjs';
import { diagMemory } from '../../heap-correctness/_diag.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('winwin-w1/alarm-coordination-w9-flush');
console.log(`winwin-w1/alarm-coordination-w9-flush — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const m0 = await diagMemory(sid);
const F0 = m0?.hib?.flushCount ?? 0;
console.log(`[pre] flushCount=${F0}`);

// Cause an exit through the FACET path so processLogs.append +
// markExit run (shell builtins like `echo`/`false` are inner-shell
// and bypass the facet log adapter). `node -e ...` spawns a real
// facet process; its stdout writes invoke processLogs.append →
// scheduleHibFlush → in-isolate setTimeout fires in ~250 ms →
// processLogs.flush(). The alarm-driven path is exercised in
// winwin-w1/new/log-janitor-still-fires.mjs (idle wake).
const { output } = await t.run(
  `node -e "console.log('flush-marker'); process.exit(3)"`,
  20_000,
);
a.check('node command produced flush-marker output',
  /flush-marker/.test(output),
  `output=${JSON.stringify(output.slice(-200))}`);

// Give W9 debounce window (250ms) + a comfortable margin for the
// in-isolate setTimeout fire + flush.
await sleep(2000);

const m1 = await diagMemory(sid);
const F1 = m1?.hib?.flushCount ?? 0;
console.log(`[post-exit] flushCount=${F1}`);

a.check('W9 flush ran after facet exit (flushCount incremented)',
  F1 > F0,
  `F0=${F0} F1=${F1}`);

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
