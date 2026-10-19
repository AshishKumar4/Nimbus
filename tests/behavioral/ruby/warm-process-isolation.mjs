#!/usr/bin/env bun
// ruby/warm-process-isolation — a `ruby` one-shot runs on a warm worker,
// the one an earlier `ruby` of the session ran on, and finds nothing that
// process left: no global or constant, no loaded library, no open
// descriptor, none of its environment, directory or umask, and it writes as
// its own credential. A process that reached JavaScript (`require "js"`)
// leaves no worker to the next one, so what it set there is not seen. A
// process killed mid-run leaves the next `ruby` working. (Inside ruby.wasm,
// Process.pid, Process.uid and File.umask are WASI's constants; what the
// session sees is the owner and mode of what a process writes.)

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
  const id = fields((await run('echo "ID uid=$(stat -c %u /home/user) cwd=$(pwd)"')).text, 'ID');
  /** The owner and mode of `path`, as the session has them. */
  const owned = async (path) => fields((await run(`stat -c "FILE uid=%u mode=%a" ${path}`)).text, 'FILE');
  // The first ruby of the session is cold; it leaves its worker warm. What it writes has a fresh process's mode.
  await run(`ruby -e 'File.write("/tmp/fresh-mode", "f"); puts "WARMED"'`);
  const fresh = await owned('/tmp/fresh-mode');

  // ── Process 1 leaves all it can; process 2 looks for it ───────────────
  const p1 = fields((await run(`ruby -e '$p1 = 1; P1 = 2; require "ostruct"; f = File.open("/tmp/p1-open.txt", "w"); f.write("x"); ENV["P1_ONLY"] = "1"; Dir.chdir("/tmp"); File.umask(0o077); puts "P1 fd=#{f.fileno}"'`)).text, 'P1');
  const p2 = fields((await run(`ruby -e 'fd = begin; IO.for_fd(${Number(p1.fd)}, autoclose: false).write("y"); "open"; rescue => e; e.class; end; File.write("/tmp/p2-mode", "m"); puts "P2 gvar=#{defined?($p1).inspect} const=#{defined?(P1).inspect} lib=#{$LOADED_FEATURES.grep(%r{/ostruct\\.rb$}).size} env=#{ENV["P1_ONLY"].inspect} cwd=#{Dir.pwd} fd=#{fd}"'`)).text, 'P2');
  const warm = await lastRubyCall();
  const p2mode = await owned('/tmp/p2-mode');
  a.check('the next ruby of the session runs on a warm worker', typeof warm === 'object' && warm.cold === false, JSON.stringify(warm));
  a.check('no global or constant of the last process', p2.gvar === 'nil' && p2.const === 'nil', JSON.stringify(p2));
  a.check('no library the last process loaded', p2.lib === '0', JSON.stringify(p2));
  a.check('no descriptor the last process left open', p2.fd !== undefined && p2.fd !== 'open', JSON.stringify(p2));
  a.check('none of the last process\'s environment, directory or umask', p2.env === 'nil' && p2.cwd === id.cwd && p2mode.mode === fresh.mode, JSON.stringify({ id, p2, p2mode, fresh }));

  // ── Credentials: root's process, then the user's ───────────────────────
  await run(`sudo ruby -e 'File.write("/tmp/root-owned", "r")'`);
  await run(`ruby -e 'File.write("/tmp/user-owned", "u")'`);
  const [root, user] = [await owned('/tmp/root-owned'), await owned('/tmp/user-owned')];
  a.check('a process after root\'s writes as its own user', root.uid === '0' && user.uid === id.uid, JSON.stringify({ root, user, id }));

  // ── JavaScript: what a process set there is not seen ───────────────────
  const b1 = await run(`ruby -e 'require "js"; JS.global[:p1Leak] = 41; JS.global[:Array][:prototype][:p1Patched] = 1; puts "B1"'`);
  const b2 = fields((await run(`ruby -e 'require "js"; puts "B2 leak=#{JS.global[:p1Leak].inspect} patched=#{JS.global[:Array][:prototype][:p1Patched].inspect}"'`)).text, 'B2');
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
