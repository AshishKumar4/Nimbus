#!/usr/bin/env bun
// ruby/green-threads — Ruby threads are real threads.
//
// ruby.wasm has one thread of execution, so Nimbus backs Thread with a fiber
// and schedules them cooperatively. This probe exists to stop that being
// regressed into "run the block inline and return a thread-shaped object",
// which passes a superficial smoke test and then deadlocks any program that
// uses threads for actual concurrency.
//
// The load-bearing cases are the ones inline execution CANNOT pass: a consumer
// that blocks on an empty queue before the producer runs, and two connections
// genuinely in flight at once.

import {
  deleteSession, mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi, fetchPort,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/green-threads';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const PORT = 8451;
const HANDLER_DELAY_MS = 400;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
let serverPid = 0;
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run('nimbus install ruby', 180_000);
  await t.run('mkdir -p /home/user/rb-threads && cd /home/user/rb-threads', 10_000);

  // ── Semantics ────────────────────────────────────────────────────────────
  await t.run(heredocCommand('rb_threads.rb', [
    'def probe(label)',
    '  puts "#{label}=#{yield.inspect}"',
    'rescue Exception => e',
    '  puts "#{label}=ERROR #{e.class}: #{e.message}"',
    'end',
    '',
    '# A spawned thread must NOT run at spawn time. Inline execution yields',
    '# [:thread, :main] here, which is the tell.',
    'probe("ORDER") do',
    '  order = []',
    '  th = Thread.new { order << :thread }',
    '  order << :main',
    '  th.join',
    '  order',
    'end',
    '',
    'probe("VALUE") { Thread.new { 6 * 7 }.value }',
    '',
    '# The consumer starts first and blocks on an empty queue; the producer',
    '# runs afterwards. Under inline execution this deadlocks at spawn.',
    'probe("HANDOFF") do',
    '  q = Queue.new',
    '  got = []',
    '  th = Thread.new { 3.times { got << q.pop } }',
    '  [1, 2, 3].each { |n| q.push(n) }',
    '  th.join',
    '  got',
    'end',
    '',
    '# Interleaving is observable and fair.',
    'probe("INTERLEAVE") do',
    '  log = []',
    '  x = Thread.new { 3.times { |i| log << "x#{i}"; Thread.pass } }',
    '  y = Thread.new { 3.times { |i| log << "y#{i}"; Thread.pass } }',
    '  x.join; y.join',
    '  log',
    'end',
    '',
    '# A raise inside a thread surfaces at join rather than vanishing.',
    'probe("RAISE") do',
    '  th = Thread.new { raise ArgumentError, "boom" }',
    '  begin; th.join; :swallowed; rescue ArgumentError => e; e.message; end',
    'end',
    '',
    '# A sleeping thread yields to its peers instead of stopping the world.',
    'probe("SLEEP_YIELDS") do',
    '  log = []',
    '  slow = Thread.new { sleep 0.05; log << :slept }',
    '  fast = Thread.new { log << :ran }',
    '  slow.join; fast.join',
    '  log',
    'end',
    '',
    '# kill unwinds the fiber, so ensure runs and a parked thread cannot leak',
    '# whatever it was holding.',
    'probe("KILL_UNWINDS") do',
    '  log = []',
    '  th = Thread.new do',
    '    begin; Thread.pass; sleep 5; log << :never; ensure; log << :cleaned; end',
    '  end',
    '  Thread.pass',
    '  th.kill',
    '  [log, th.alive?]',
    'end',
    '',
    '# A thread parked forever must not wedge the main flow.',
    'probe("PARKED_PEER") do',
    '  q = Queue.new',
    '  Thread.new { q.pop }',
    '  :main_runs',
    'end',
    '',
    'probe("LOCALS") { Thread.new { Thread.current[:k] = 5; Thread.current[:k] }.value }',
    '',
    '# Ruby names every synchronisation primitive twice - ::Queue and',
    '# Thread::Queue - and defines both. A program that reaches the namespaced',
    '# one gets the real class, which waits for an OS thread that does not',
    '# exist and stops the process. Each of these hands off between two green',
    '# threads, which only the parking implementations can do.',
    'probe("NS_QUEUE") do',
    '  q = Thread::Queue.new',
    '  got = []',
    '  th = Thread.new { 2.times { got << q.pop } }',
    '  [:a, :b].each { |v| q.push(v) }',
    '  th.join',
    '  got',
    'end',
    '',
    'probe("NS_SIZED_QUEUE") do',
    '  q = Thread::SizedQueue.new(1)',
    '  log = []',
    '  th = Thread.new { 2.times { |i| q.push(i); log << "p#{i}" } }',
    '  Thread.pass',
    '  2.times { log << "c#{q.pop}" }',
    '  th.join',
    '  log',
    'end',
    '',
    'probe("NS_MUTEX") do',
    '  m = Thread::Mutex.new',
    '  log = []',
    '  th = Thread.new { m.synchronize { log << :thread } }',
    '  m.synchronize { log << :main }',
    '  th.join',
    '  log',
    'end',
    '',
    'probe("NS_CONDVAR") do',
    '  m = Thread::Mutex.new',
    '  cv = Thread::ConditionVariable.new',
    '  log = []',
    '  th = Thread.new { m.synchronize { cv.wait(m); log << :woke } }',
    '  Thread.pass',
    '  m.synchronize { cv.signal }',
    '  th.join',
    '  log',
    'end',
    '',
    '# A thread that dies with an exception nobody joins says so, the way Ruby',
    '# does. Without that a thread killed by an unsatisfiable primitive fails',
    '# invisibly and the program merely does less than it was asked.',
    'probe("UNJOINED_REPORT") do',
    '  Thread.new { raise ArgumentError, "unjoined boom" }',
    '  Thread.pass',
    '  :main_runs',
    'end',
  ].join('\n')), 10_000);

  {
    const out = stripAnsi((await t.run('ruby rb_threads.rb', 180_000)).output);
    const expect = [
      ['a spawned thread does not run at spawn time', /ORDER=\[:main, :thread\]/],
      ['Thread#value returns the block result', /VALUE=42/],
      ['a consumer blocked on an empty queue is fed by the producer', /HANDOFF=\[1, 2, 3\]/],
      ['threads interleave in a fair, observable order', /INTERLEAVE=\["x0", "y0", "x1", "y1", "x2", "y2"\]/],
      ['an exception in a thread surfaces at join', /RAISE="boom"/],
      ['a sleeping thread yields to its peers', /SLEEP_YIELDS=\[:ran, :slept\]/],
      ['Thread#kill unwinds through ensure', /KILL_UNWINDS=\[\[:cleaned\], false\]/],
      ['a permanently parked thread does not wedge the main flow', /PARKED_PEER=:main_runs/],
      ['thread-locals work', /LOCALS=5/],
      ['Thread::Queue hands off between green threads', /NS_QUEUE=\[:a, :b\]/],
      ['Thread::SizedQueue blocks the producer at its bound',
        /NS_SIZED_QUEUE=\["p0", "c0", "p1", "c1"\]/],
      ['Thread::Mutex serialises without deadlocking', /NS_MUTEX=\[:main, :thread\]/],
      ['Thread::ConditionVariable wakes a waiter', /NS_CONDVAR=\[:woke\]/],
      ['a thread dying with an exception reports itself',
        /UNJOINED_REPORT=:main_runs/],
      ['the report names the exception that killed it',
        /terminated with exception[\s\S]*unjoined boom \(ArgumentError\)/],
    ];
    for (const [name, re] of expect) {
      a.check(name, re.test(out), JSON.stringify(out.slice(-900)));
    }
  }

  // ── Two connections in flight at once ────────────────────────────────────
  // A server whose handler is slow. If handlers ran inline, or if the accept
  // loop could not proceed past a blocked handler, two requests would cost two
  // delays. Concurrency means they cost one.
  await t.run(heredocCommand('rb_concurrent_server.rb', [
    'require "socket"',
    `server = TCPServer.new("0.0.0.0", ${PORT})`,
    'loop do',
    '  sock = server.accept',
    '  Thread.new(sock) do |conn|',
    '    head = conn.gets("\\r\\n\\r\\n").to_s',
    '    path = head.lines.first.to_s.split(" ")[1].to_s',
    `    sleep ${HANDLER_DELAY_MS / 1000.0}`,
    '    body = "HANDLED #{path}"',
    '    conn.write("HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: #{body.bytesize}\\r\\n\\r\\n#{body}")',
    '    conn.close',
    '  end',
    'end',
  ].join('\n')), 10_000);

  {
    const { output } = await t.run('ruby rb_concurrent_server.rb', 120_000);
    serverPid = Number((stripAnsi(output).match(/pid=(\d+)/) || [])[1] || 0);

    // Warm the path so instantiation cost is not counted in the timing below.
    await fetchPort(sid, PORT, 'warm');

    const started = Date.now();
    const [one, two] = await Promise.all([
      fetchPort(sid, PORT, 'one'),
      fetchPort(sid, PORT, 'two'),
    ]);
    const elapsed = Date.now() - started;

    a.check('two connections are served concurrently, not serially',
      one.status === 200 && two.status === 200 &&
      one.body === 'HANDLED /one' && two.body === 'HANDLED /two' &&
      elapsed < HANDLER_DELAY_MS * 1.8,
      `elapsed=${elapsed}ms (one handler delay is ${HANDLER_DELAY_MS}ms, two would be ${HANDLER_DELAY_MS * 2}ms) ` +
      `one=${one.status}/${JSON.stringify(one.body.slice(0, 80))} two=${two.status}/${JSON.stringify(two.body.slice(0, 80))}`);
  }

  if (serverPid > 0) await t.run(`kill ${serverPid}`, 10_000).catch(() => {});
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
