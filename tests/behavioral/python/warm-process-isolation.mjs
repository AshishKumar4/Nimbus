#!/usr/bin/env bun
// python/warm-process-isolation — a `python3` one-shot runs on a warm
// worker, the one an earlier `python3` of the session ran on, and finds
// nothing that process left: no module it imported or changed, no open
// descriptor, none of its environment, directory or umask, and it writes as
// its own credential. A process that reached the network (a socket) leaves
// no worker to the next one. A process killed mid-run leaves the next
// `python3` working. Reuse is read from the session's facet-call record,
// not timed.

import { mintSession, Terminal, makeAsserter, deleteSession, stripAnsi } from '../_driver.mjs';
import { installPython } from './_setup.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'python/warm-process-isolation';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

/** `command`'s output and exit. */
const run = async (command, ms = 120_000) => {
  const { output, exitCode } = await t.run(command, ms);
  return { text: stripAnsi(output), exitCode };
};
/** The `key=value` words of the line that starts with `tag`. */
const fields = (text, tag) => Object.fromEntries((text.split('\n').find((line) => line.startsWith(tag)) ?? '').trim().split(' ').slice(1).map((word) => word.split('=')));
/** The session's last python facet call, as its facet-call record has it. */
const lastPythonCall = async () => {
  const calls = await t.facetCalls();
  return typeof calls === 'string' ? calls : calls.findLast((call) => /^cpython-runner/.test(call.tag)) ?? 'no python call recorded';
};
/** The owner and mode of `path`, as the session has them. */
const owned = async (path) => fields((await run(`stat -c "FILE uid=%u mode=%a" ${path}`)).text, 'FILE');

try {
  await installPython(t, a);
  const id = fields((await run('echo "ID uid=$(stat -c %u /home/user) cwd=$(pwd)"')).text, 'ID');
  // The first python of the session is cold; it leaves its worker warm. What it writes has a fresh process's mode.
  await run(`python3 -c 'open("/tmp/fresh-mode", "w").write("f"); print("WARMED")'`);
  const fresh = await owned('/tmp/fresh-mode');

  // ── Process 1 leaves all it can; process 2 looks for it ───────────────
  const p1 = fields((await run(`python3 -c 'import os, json, colorsys; json.P1 = 1; os.environ["P1_ONLY"] = "1"; f = open("/tmp/p1-open.txt", "w"); f.write("x"); os.chdir("/tmp"); os.umask(0o077); print("P1 fd=%d" % f.fileno())'`)).text, 'P1');
  const p2 = fields((await run(`python3 -c 'import os, sys, json
try:
    os.write(${Number(p1.fd)}, b"y"); fd = "open"
except OSError as e:
    fd = type(e).__name__
open("/tmp/p2-mode", "w").write("m")
print("P2 mod=%s attr=%s env=%s cwd=%s fd=%s" % ("colorsys" in sys.modules, hasattr(json, "P1"), os.environ.get("P1_ONLY"), os.getcwd(), fd))'`)).text, 'P2');
  const warm = await lastPythonCall();
  const p2mode = await owned('/tmp/p2-mode');
  a.check('the next python of the session runs on a warm worker', typeof warm === 'object' && warm.cold === false, JSON.stringify(warm));
  a.check('no module the last process imported or changed', p2.mod === 'False' && p2.attr === 'False', JSON.stringify(p2));
  a.check('no descriptor the last process left open', p2.fd !== undefined && p2.fd !== 'open', JSON.stringify(p2));
  a.check('none of the last process\'s environment, directory or umask', p2.env === 'None' && p2.cwd === id.cwd && p2mode.mode === fresh.mode, JSON.stringify({ id, p2, p2mode, fresh }));

  // ── Credentials: root's process, then the user's ───────────────────────
  await run(`sudo python3 -c 'open("/tmp/root-owned", "w").write("r")'`);
  await run(`python3 -c 'open("/tmp/user-owned", "w").write("u")'`);
  const [root, user] = [await owned('/tmp/root-owned'), await owned('/tmp/user-owned')];
  a.check('a process after root\'s writes as its own user', root.uid === '0' && user.uid === id.uid, JSON.stringify({ root, user, id }));

  // ── The network: a process that reached it leaves no worker ────────────
  await run(`python3 -c 'import socket
try:
    socket.create_connection(("127.0.0.1", 9), timeout=2)
except OSError:
    pass
print("NET")'`);
  await run(`python3 -c 'print("AFTER" + "NET")'`);
  const afterNet = await lastPythonCall();
  a.check('a process after one that reached the network does not get its worker', typeof afterNet === 'object' && afterNet.cold === true, JSON.stringify(afterNet));

  // ── Killed mid-run: the next python works ──────────────────────────────
  await run(`timeout 2 python3 -c 'import time; time.sleep(30)'`);
  const after = await run(`python3 -c 'print("AFTER" + "KILL")'`);
  a.check('a python after one killed mid-run runs', /AFTERKILL/.test(after.text) && after.exitCode === 0, after.text.slice(-300));
} catch (error) {
  a.check('the scenario ran', false, error instanceof Error ? error.message : String(error));
} finally {
  await t.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
