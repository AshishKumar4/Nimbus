#!/usr/bin/env bun
// ruby/wall-clock — a timed wait yields; it does not spin.
//
// workerd freezes the clock inside a turn, so a wait implemented by reading
// the clock in a loop can never finish: it consumes the process's whole CPU
// budget and the invocation is killed with nothing to show for it. Every
// wall-clock wait Ruby offers therefore has to hand control back — to the
// scheduler, so peers run, and then to the host, which owns the clock.
//
// This probe covers the wait SHAPES rather than one method: each one below
// burned the budget before the scheduler learned to carry a deadline, and each
// asserts both that it returned and that real time actually passed.

import {
  deleteSession, mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/wall-clock';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run('nimbus install ruby', 180_000);
  await t.run('mkdir -p /home/user/rb-clock && cd /home/user/rb-clock', 10_000);

  // ── The clock itself ─────────────────────────────────────────────────────
  // A bounded read loop, so it terminates whatever the answer is. It reports
  // whether the clock moves at all without yielding, which is the fact every
  // assertion below rests on.
  await t.run(heredocCommand('rb_clock.rb', [
    'first = Time.now',
    'last = first',
    'moves = 0',
    '200_000.times do',
    '  now = Time.now',
    '  moves += 1 if now != last',
    '  last = now',
    'end',
    'puts "CLOCK_MOVES=#{moves} SPAN=#{last - first}"',
  ].join('\n')), 10_000);
  {
    const out = stripAnsi((await t.run('ruby rb_clock.rb', 120_000)).output);
    const m = out.match(/CLOCK_MOVES=(\d+) SPAN=(\S+)/);
    console.log(`  · clock diagnostic: ${m ? m[0] : JSON.stringify(out.slice(-300))}`);
    a.check('reading the clock in a loop terminates and reports itself',
      m !== null, JSON.stringify(out.slice(-600)));
  }

  // ── Every wait shape, in one process ─────────────────────────────────────
  // One script, so a single wasm boot covers all of them and a shape that
  // burns the budget takes down only the arms after it — which is exactly how
  // a regression should read.
  await t.run(heredocCommand('rb_waits.rb', [
    'require "timeout"',
    '',
    'def probe(label)',
    '  started = Time.now',
    '  value = yield',
    '  puts "#{label}=#{value.inspect} dt=#{(Time.now - started).round(3)}"',
    'rescue Exception => e',
    '  puts "#{label}=ERROR #{e.class}: #{e.message} dt=#{(Time.now - started).round(3)}"',
    'end',
    '',
    '# The plainest wall-clock wait there is, on the body the host resumes.',
    'probe("SLEEP") { sleep 0.2; :woke }',
    '',
    '# A sleeping peer must not stop the body, and the body must still see the',
    '# peer finish rather than giving up on it.',
    'probe("PEER_SLEEP") do',
    '  log = []',
    '  slow = Thread.new { sleep 0.2; log << :slept }',
    '  log << :main',
    '  slow.join',
    '  log',
    'end',
    '',
    '# Waiting on a thread with a limit: the limit is a deadline the scheduler',
    '# has to carry, or the wait has nothing to wake it.',
    'probe("JOIN_LIMIT") do',
    '  th = Thread.new { sleep 5 }',
    '  [th.join(0.2), th.alive?]',
    'end',
    '',
    '# select with a timeout and nothing to watch is how a great deal of',
    '# stdlib code spells sleep.',
    'probe("SELECT_TIMEOUT") { IO.select(nil, nil, nil, 0.2).inspect }',
    '',
    '# A condition nobody will ever signal, bounded by a deadline.',
    'probe("CONDVAR_TIMEOUT") do',
    '  m = Mutex.new',
    '  cv = ConditionVariable.new',
    '  m.synchronize { cv.wait(m, 0.2) }',
    '  :returned',
    'end',
    '',
    'probe("MUTEX_SLEEP") do',
    '  m = Mutex.new',
    '  m.lock',
    '  m.sleep(0.2)',
    '  :returned',
    'end',
    '',
    '# Nothing here can interrupt a block that does not yield, so a timeout is',
    '# delivered where the block waits. It has to be delivered SOMEWHERE: a',
    '# timeout that silently becomes an unbounded wait is the worst answer.',
    'probe("TIMEOUT_FIRES") do',
    '  Timeout.timeout(0.2) { sleep 5; :never }',
    'end',
    '',
    '# ...and a block that finishes in time is untouched.',
    'probe("TIMEOUT_PASSES") { Timeout.timeout(5) { 40 + 2 } }',
    '',
    '# A wait nothing can ever satisfy is a deadlock, and saying so beats',
    '# consuming the budget and dying with no diagnosis.',
    'probe("DEADLOCK") { Queue.new.pop }',
    '',
    'puts "DONE"',
  ].join('\n')), 10_000);

  {
    const { output, elapsed } = await t.run('ruby rb_waits.rb', 120_000);
    const out = stripAnsi(output);
    console.log(`  · rb_waits.rb ran in ${elapsed}ms`);
    const expect = [
      ['sleep returns after roughly the time asked for',
        /SLEEP=:woke dt=0\.[123]\d*/],
      ['a sleeping peer yields to the body and is still joined',
        /PEER_SLEEP=\[:main, :slept\] dt=0\.[123]\d*/],
      ['join with a limit gives up at its deadline',
        /JOIN_LIMIT=\[nil, true\] dt=0\.[123]\d*/],
      ['select with only a timeout waits that long and reports nothing ready',
        /SELECT_TIMEOUT="nil" dt=0\.[123]\d*/],
      ['a condition variable wait returns at its deadline',
        /CONDVAR_TIMEOUT=:returned dt=0\.[123]\d*/],
      ['Mutex#sleep waits and retakes the lock',
        /MUTEX_SLEEP=:returned dt=0\.[123]\d*/],
      ['a timeout is delivered to a block that waits past it',
        /TIMEOUT_FIRES=ERROR Timeout::Error/],
      ['a block that finishes in time is untouched', /TIMEOUT_PASSES=42/],
      ['an unsatisfiable wait is reported as a deadlock',
        /DEADLOCK=ERROR ThreadError: [^\n]*deadlock/],
      ['the script runs to completion', /DONE/],
    ];
    for (const [name, re] of expect) {
      a.check(name, re.test(out), JSON.stringify(out.slice(-1200)));
    }
  }
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
