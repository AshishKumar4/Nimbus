#!/usr/bin/env bun
// ruby-green-threads-scheduler — every wall-clock wait hands its deadline back.
//
// Drives the REAL scheduler source (runtime/ruby-green-threads.ts) under a real
// Ruby, exactly as the runtime ships it. What is substituted is the host, and
// only the host: in production __nimbusRubyDriveBoot resumes the body fiber,
// waits out whatever deadline it handed back on a real timer, and resumes it
// again; here that same loop is a dozen lines of Ruby at the bottom of the
// harness. That is a mock at a real seam — the guest/host boundary the whole
// design turns on — and nothing inside it.
//
// The load-bearing assertion is not "it slept for 0.2s": a Ruby that waited by
// watching the clock would pass that locally, because a local clock moves.
// It is `wakes` — the deadlines the body handed OUT. workerd freezes the clock
// inside a turn, so a wait that keeps control never ends and burns the whole
// CPU budget; handing the deadline to the host is the entire fix, and a
// regression to waiting in the guest shows up here as an empty `wakes`.
//
// Whether the guest can actually be resumed across turns is gated live, where
// workerd is: tests/behavioral/ruby/wall-clock.mjs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RUBY_GREEN_THREADS } from '../../packages/worker/src/runtime/ruby-green-threads.ts';

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name} — ${e && e.message ? e.message : e}`);
    failures++;
  }
};

const HARNESS = String.raw`
require 'json'
require 'timeout'

# Captured before the prelude replaces Kernel#sleep: this is the host's timer,
# and the host is the only thing that may wait on the wall clock.
REAL_SLEEP = Kernel.instance_method(:sleep)

# NIMBUS_PRELUDE

Nimbus::Threading.install_timeout_shim

# The host driver, mirroring __nimbusRubyDriveBoot in runtime/ruby-runner.ts.
def drive(host_driven: false)
  Nimbus::Threading.shutdown
  Nimbus::Threading.host_driven = host_driven
  $__nimbus_wake_after = nil
  value = nil
  error = nil
  wakes = []
  body = Fiber.new do
    begin
      value = yield
    rescue Exception => e
      error = e
    ensure
      Nimbus::Threading.shutdown
    end
  end
  started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  loop do
    body.resume
    break unless body.alive?
    wake = $__nimbus_wake_after
    break if wake.nil?
    wakes << wake
    REAL_SLEEP.bind(self).call(wake)
  end
  {
    value: value.inspect,
    error: error && error.class.to_s,
    message: error && error.message,
    wakes: wakes,
    parked: body.alive?,
    elapsed: Process.clock_gettime(Process::CLOCK_MONOTONIC) - started,
  }
end

cases = {}

cases['sleep'] = drive { sleep 0.2 }

cases['peer_sleep'] = drive do
  log = []
  slow = Thread.new { sleep 0.2; log << :slept }
  log << :main
  slow.join
  log
end

cases['join_limit'] = drive do
  th = Thread.new { sleep 5 }
  [th.join(0.2), th.alive?]
end

cases['condvar_deadline'] = drive do
  m = Mutex.new
  cv = ConditionVariable.new
  m.synchronize { cv.wait(m, 0.2); [:returned, m.owned?] }
end

cases['mutex_sleep'] = drive do
  m = Mutex.new
  m.lock
  m.sleep(0.2)
  [:returned, m.owned?]
end

cases['module_function_sleep'] = drive { Kernel.sleep(0.2) }

cases['timeout_fires'] = drive { Timeout.timeout(0.2) { sleep 5; :never } }

cases['timeout_passes'] = drive { Timeout.timeout(5) { 40 + 2 } }

cases['timeout_in_thread'] = drive do
  th = Thread.new { Timeout.timeout(0.2) { sleep 5; :never } }
  begin
    th.join
    :swallowed
  rescue Timeout::Error => e
    e.message
  end
end

cases['deadlock'] = drive { Queue.new.pop }

cases['deadlock_is_not_a_verdict_when_a_request_can_wake_it'] =
  drive(host_driven: true) { Queue.new.pop }

cases['zero_sleep_yields'] = drive do
  log = []
  peer = Thread.new { log << :peer }
  sleep 0
  log << :main
  peer.join
  log
end

# The grid a deadline has to land on. The host clock reports whole
# milliseconds and nothing finer, so an instant between two of them is never
# reported reached - and now + a Float is such an instant almost every time,
# because the double nearest 0.2 is 0.2000000000000000111. A local clock is far
# finer than that and cannot reproduce the failure, so the policy is asserted
# where it lives instead.
base = Time.at(0, 1_785_980_000_000_000)
offsets = [0.0, 0.001, 0.05, 0.2, 1.0 / 3, 5.0]
grid = offsets.map { |o| [base + o, Nimbus::Threading.on_the_clock(base + o)] }
cases['clock_grid'] = {
  on_grid: grid.all? { |(_, snapped)| (snapped.to_r * 1000).denominator == 1 },
  never_early: grid.all? { |(wanted, snapped)| snapped >= wanted },
  within_one_tick: grid.all? { |(wanted, snapped)| snapped.to_r - wanted.to_r <= Rational(1, 1000) },
}

puts JSON.generate(cases)
`;

const rubyVersion = spawnSync('ruby', ['--version'], { encoding: 'utf8' });
assert.equal(
  rubyVersion.status, 0,
  'this suite drives the Ruby scheduler under a real Ruby; install ruby 3.x to run it',
);

const dir = mkdtempSync(path.join(os.tmpdir(), 'nimbus-ruby-sched-'));
const script = path.join(dir, 'scheduler.rb');
let cases;
try {
  writeFileSync(script, HARNESS.replace('# NIMBUS_PRELUDE', () => RUBY_GREEN_THREADS));
  const run = spawnSync('ruby', [script], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(
    run.status, 0,
    `harness exited ${run.status}: ${run.stderr || run.stdout}`,
  );
  cases = JSON.parse(run.stdout.trim().split('\n').pop());
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/** A wait that never handed a deadline out is a wait that spun. */
const yielded = (name) => {
  const c = cases[name];
  assert.ok(c.wakes.length > 0, `${name} handed no deadline to the host: ${JSON.stringify(c)}`);
  assert.ok(c.elapsed >= 0.15, `${name} did not actually wait: ${JSON.stringify(c)}`);
};

check('sleep waits, returns whole seconds slept, and hands its deadline out', () => {
  assert.equal(cases.sleep.value, '0');
  assert.equal(cases.sleep.error, null);
  yielded('sleep');
});

check('Kernel.sleep is the scheduled sleep, not the module-function copy', () => {
  assert.equal(cases.module_function_sleep.error, null);
  yielded('module_function_sleep');
});

check('a sleeping peer yields to the body and is still joined', () => {
  assert.equal(cases.peer_sleep.value, '[:main, :slept]');
  yielded('peer_sleep');
});

check('join with a limit gives up at its deadline and leaves the thread alive', () => {
  assert.equal(cases.join_limit.value, '[nil, true]');
  yielded('join_limit');
});

check('a condition variable wait returns at its deadline holding the mutex', () => {
  assert.equal(cases.condvar_deadline.value, '[:returned, true]');
  yielded('condvar_deadline');
});

check('Mutex#sleep waits and retakes the lock', () => {
  assert.equal(cases.mutex_sleep.value, '[:returned, true]');
  yielded('mutex_sleep');
});

check('a timeout is delivered to a block that waits past it', () => {
  assert.equal(cases.timeout_fires.error, 'Timeout::Error');
  assert.equal(cases.timeout_fires.message, 'execution expired');
  assert.ok(cases.timeout_fires.elapsed < 1,
    `the timeout waited out the block instead: ${JSON.stringify(cases.timeout_fires)}`);
});

check('a block that finishes in time is untouched and waits on nothing', () => {
  assert.equal(cases.timeout_passes.value, '42');
  assert.deepEqual(cases.timeout_passes.wakes, []);
});

check('a timeout is delivered to a green thread and surfaces at join', () => {
  assert.equal(cases.timeout_in_thread.value, '"execution expired"');
  assert.ok(cases.timeout_in_thread.elapsed < 1,
    `the timeout waited out the thread instead: ${JSON.stringify(cases.timeout_in_thread)}`);
});

check('a wait nothing can satisfy is reported as a deadlock, not waited on', () => {
  assert.equal(cases.deadlock.error, 'ThreadError');
  assert.match(cases.deadlock.message, /deadlock/);
  assert.deepEqual(cases.deadlock.wakes, []);
});

check('the same wait is not a deadlock once a request could wake it', () => {
  const c = cases.deadlock_is_not_a_verdict_when_a_request_can_wake_it;
  assert.equal(c.error, null);
  assert.equal(c.parked, true, `expected the body parked on the host: ${JSON.stringify(c)}`);
  assert.deepEqual(c.wakes, []);
});

check('a deadline is rounded onto the clock grid, never early, never by more than a tick', () => {
  assert.deepEqual(cases.clock_grid, { on_grid: true, never_early: true, within_one_tick: true });
});

check('a zero-length sleep is a scheduling point rather than a busy loop', () => {
  assert.equal(cases.zero_sleep_yields.value, '[:peer, :main]');
  assert.ok(cases.zero_sleep_yields.elapsed < 1,
    `sleep 0 did not return promptly: ${JSON.stringify(cases.zero_sleep_yields)}`);
});

console.log(failures === 0 ? '\nOK' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
