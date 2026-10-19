#!/usr/bin/env bun
// ruby/warm-process-isolation — a `ruby` one-shot runs on a warm worker,
// the one an earlier `ruby` of the session ran on, and finds nothing that
// process left: no global or constant, no loaded library, no open
// descriptor, no environment, directory or umask of its own, and its own
// pid and credential. A process that reached JavaScript (`require "js"`)
// leaves no worker to the next one, so what it wrote there is not seen. A
// process killed mid-run leaves the next `ruby` working.

import { mintSession, Terminal, makeAsserter, deleteSession, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/warm-process-isolation';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

/** `command`'s output, its prompt echo dropped. */
const run = async (command, ms = 120_000) => {
  const { output, exitCode } = await t.run(command, ms);
  return { text: stripAnsi(output), exitCode };
};
/** The `key=value` words of the line that starts with `tag`. */
const fields = (text, tag) => Object.fromEntries((text.split('\n').find((line) => line.startsWith(tag)) ?? '').trim().split(' ').slice(1).map((word) => word.split('=')));
/** Whether the session's last Ruby facet call ran on a warm worker. */
const lastRubyCall = async () => {
  const calls = await t.facetCalls();
  return typeof calls === 'string' ? calls : calls.findLast((call) => call.tag === 'ruby-runner') ?? 'no ruby call recorded';
};

try {
  const install = await run('nimbus install ruby', 180_000);
  if (install.exitCode !== 0) throw new Error(`nimbus install ruby: ${install.text.slice(-300)}`);
  const id = fields((await run('echo "ID uid=$(id -u) umask=$(umask) cwd=$(pwd)"')).text, 'ID');
  // The first ruby of the session is cold; it leaves its worker warm.
  await run(`ruby -e 'puts "WARMED"'`);

  // ── Process 1 leaves all it can; process 2 looks for it ───────────────
  const p1 = fields((await run(`ruby -e '$p1 = 1; P1 = 2; require "ostruct"; f = File.open("/tmp/p1-open.txt", "w"); f.write("x"); ENV["P1_ONLY"] = "1"; Dir.chdir("/tmp"); File.umask(0o077); puts "P1 pid=#{Process.pid} fd=#{f.fileno}"'`)).text, 'P1');
  const p2run = await run(`ruby -e 'fd = begin; IO.for_fd(${Number(p1.fd)}, autoclose: false).write("y"); "open"; rescue => e; e.class; end; puts "P2 pid=#{Process.pid} uid=#{Process.uid} gvar=#{defined?($p1).inspect} const=#{defined?(P1).inspect} lib=#{$LOADED_FEATURES.grep(%r{/ostruct\\.rb$}).size} env=#{ENV["P1_ONLY"].inspect} cwd=#{Dir.pwd} umask=#{File.umask.to_s(8)} fd=#{fd}"'`);
  const p2 = fields(p2run.text, 'P2');
  const warm = await lastRubyCall();
  a.check('the next ruby of the session runs on a warm worker', typeof warm === 'object' && warm.cold === false, JSON.stringify(warm));
  a.check('it is its own process', p2.pid !== undefined && p2.pid !== p1.pid, JSON.stringify({ p1, p2 }));
  a.check('no global or constant of the last process', p2.gvar === 'nil' && p2.const === 'nil', JSON.stringify(p2));
  a.check('no library the last process loaded', p2.lib === '0', JSON.stringify(p2));
  a.check('no descriptor the last process left open', p2.fd !== 'open', JSON.stringify(p2));
  a.check('none of the last process\'s environment, directory or umask', p2.env === 'nil' && p2.cwd === id.cwd && Number.parseInt(p2.umask, 8) === Number.parseInt(id.umask, 8), JSON.stringify({ id, p2 }));

  // ── Credentials: root's process, then the user's ───────────────────────
  const root = fields((await run(`sudo ruby -e 'File.write("/tmp/root-owned", "r"); puts "ROOT uid=#{Process.uid}"'`)).text, 'ROOT');
  const user = fields((await run(`ruby -e 'File.write("/tmp/user-owned", "u"); puts "USER uid=#{Process.uid} gid=#{Process.gid}"'`)).text, 'USER');
  const owner = (await run('stat -c "OWNER uid=%u" /tmp/user-owned')).text;
  a.check('a process after root\'s runs as its own user, and writes as it', root.uid === '0' && user.uid === id.uid && fields(owner, 'OWNER').uid === id.uid, JSON.stringify({ root, user, owner: owner.slice(-200), id }));

  // ── JavaScript: what a process wrote there is not seen ─────────────────
  const b1 = await run(`ruby -e 'require "js"; JS.global[:p1Leak] = 41; JS.eval("Array.prototype.p1Patched = 1"); puts "B1"'`);
  const b2 = fields((await run(`ruby -e 'require "js"; puts "B2 leak=#{JS.global[:p1Leak].inspect} patched=#{JS.eval("return [].p1Patched").inspect}"'`)).text, 'B2');
  a.check('a global or prototype a process set through JavaScript is not seen by the next', /B1/.test(b1.text) && b2.leak === 'undefined' && b2.patched === 'undefined', JSON.stringify({ b1: b1.text.slice(-300), b2 }));

  // ── Killed mid-run: the next ruby works ────────────────────────────────
  await run(`timeout 2 ruby -e 'sleep 30'`);
  const after = await run(`ruby -e 'puts "AFTER" + "KILL"'`);
  a.check('a ruby after one killed mid-run runs', /AFTERKILL/.test(after.text) && after.exitCode === 0, after.text.slice(-300));
} catch (error) {
  a.check('the scenario ran', false, error instanceof Error ? error.message : String(error));
} finally {
  await t.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
