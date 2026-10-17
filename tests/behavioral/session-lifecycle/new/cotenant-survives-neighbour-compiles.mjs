#!/usr/bin/env bun
// session-lifecycle/new/cotenant-survives-neighbour-compiles — a session
// sharing an isolate with another session is not reset by that session's
// work: while one user runs three clang compiles at once, a second user's
// session in the same isolate keeps its terminal and its shell.
//
// The platform places several sessions in one isolate, with one memory
// limit, and resets all of them when it is crossed. Sessions are minted until
// two land in one isolate (/api/_diag/memory names it), so the property is
// checked on real co-tenants, never on sessions that happened to be apart.

import { mintSession, Terminal, makeAsserter, stripAnsi, heredocCommand } from '../../_driver.mjs';
import { atOnce, isolateOf } from '../../_at-once.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('session-lifecycle/new/cotenant-survives-neighbour-compiles');

/**
 * How many sessions may be minted looking for two in one isolate: measured,
 * one pair came in 8, 16 and 24 sessions.
 */
const CANDIDATES = 48;

async function candidate() {
  const sid = await mintSession();
  const terminal = new Terminal(sid);
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  return { sid, terminal, isolate: await isolateOf(sid) };
}

const sessions = [];
let pair = null;
while (pair === null && sessions.length < CANDIDATES) {
  sessions.push(...await Promise.all(Array.from({ length: Math.min(8, CANDIDATES - sessions.length) }, candidate)));
  const byIsolate = Map.groupBy(sessions, (session) => session.isolate);
  pair = [...byIsolate.values()].find((group) => group.length >= 2)?.slice(0, 2) ?? null;
}
const counts = [...Map.groupBy(sessions, (session) => session.isolate).values()].map((group) => group.length).sort((x, y) => y - x);
console.log(`${sessions.length} sessions in ${counts.length} isolates (sessions per isolate: ${counts.join(' ')})`);
for (const session of sessions) if (!pair?.includes(session)) await session.terminal.close();
a.check(`two of the sessions share an isolate (${sessions.length} minted)`, pair !== null, `sessions per isolate: ${counts.join(' ')}`);

if (pair) {
  const [compiler, neighbour] = pair;
  console.log(`SID: ${compiler.sid} (compiles) and ${neighbour.sid}, isolate ${compiler.isolate}`);
  const ct = compiler.terminal;
  await ct.run('nimbus install clang', 180_000);
  const names = ['n0', 'n1', 'n2'];
  for (const [i, name] of names.entries()) {
    await ct.run(heredocCommand(`${name}.c`, `#include <stdio.h>\nint main(void) { printf("RAN_${name}\\n"); return ${i}; }`), 10_000);
  }
  const shared = await isolateOf(compiler.sid) === compiler.isolate && await isolateOf(neighbour.sid) === compiler.isolate;
  a.check('the two still share their isolate when the compiles start', shared, `isolate ${compiler.isolate}`);
  if (shared) {
    const step = await atOnce(ct, names.map((name) => `clang ${name}.c -o ${name}`), 300_000);
    console.log(`STEP cotenant clang k=3 ${step.ms} ms ${step.survived ? 'survived' : 'lost'}`);
    a.check('the compiling session survives its three compiles', step.survived, step.detail);
    a.check('the co-tenant\'s terminal stays open through them', !neighbour.terminal.closed, neighbour.terminal.closeDetail ?? '');
    let answered = '';
    try {
      answered = stripAnsi((await neighbour.terminal.run('echo NEIGHBOUR_ALIVE', 30_000)).output);
    } catch (error) {
      answered = String(error?.message ?? error);
    }
    a.check('the co-tenant\'s shell still answers', answered.includes('NEIGHBOUR_ALIVE'), JSON.stringify(answered.slice(-300)));
    const after = await isolateOf(neighbour.sid).catch((error) => `unreadable: ${error.message}`);
    a.check('the co-tenant is still in the isolate it started in (no reset)', after === compiler.isolate, `before ${compiler.isolate}, after ${after}`);
  }
  await neighbour.terminal.close();
  await ct.close();
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
