#!/usr/bin/env bun
// pkg-manager/usr-bin-launchers — `nimbus install` puts a runtime where apt
// would: its tree in /usr/lib/nimbus/<name>/<version> and a launcher for each
// of its commands in /usr/bin, a link into the tree.
//
// From Nimbus's shell the launcher is the command: `/usr/bin/python3` runs
// Python as `python3` does, and `which` reports it. From GNU bash
// (`nimbus install bash`) it is not: bash runs its own coreutils and shell
// scripts, never the session's commands (ticket: GNU bash runs the session's
// commands). There a launcher's marker is a file that is not executable, and
// bash fails it as Linux fails one: 126, Permission denied. Before
// /usr/lib/nimbus, bash found no python3 at all (127); a marker left
// executable was run as an empty script and succeeded doing nothing.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'pkg-manager/usr-bin-launchers';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
const run = async (line, timeout = 60_000) => stripAnsi((await t.run(line, timeout)).output);
const tail = (out) => JSON.stringify(out.slice(-400));

const installed = await run('nimbus install python', 300_000);
const root = /installed at\s+\/?(usr\/lib\/nimbus\/cpython\/[\w.-]+)/.exec(installed)?.[1]
  ?? /already installed at\s+\/?(usr\/lib\/nimbus\/cpython\/[\w.-]+)/.exec(installed)?.[1];
a.check('python installs into /usr/lib/nimbus', root !== undefined, tail(installed));

// ── Nimbus's shell: the launcher is the command ──────────────────────────────
{
  const out = await run("python3 -c 'print(1)'; echo RC=$?");
  a.check('python3 runs by name', /^1$/m.test(out) && /RC=0/.test(out), tail(out));
}
{
  const out = await run('/usr/bin/python3 --version; echo RC=$?');
  a.check('/usr/bin/python3 runs it by path', /Python 3\.13/.test(out) && /RC=0/.test(out), tail(out));
}
{
  const out = await run('which python3');
  a.check('which python3 is its launcher', /^\/usr\/bin\/python3$/m.test(out), tail(out));
}
{
  const out = await run('readlink /usr/bin/python3; stat -c %a /usr/bin/python3');
  a.check('the launcher is a link into the tree, to a marker that is not executable',
    root !== undefined && out.includes(`/${root}/bin/python3`) && /^644$/m.test(out), tail(out));
}

// ── GNU bash: it runs no session command ─────────────────────────────────────
await run('nimbus install bash', 300_000);
{
  const out = await run('bash --version');
  a.check('bash is GNU bash', /GNU bash, version 5\./.test(out), tail(out));
}
{
  const out = await run(`bash -c '/${root}/bin/python3; echo RC=$?'`);
  a.check('bash fails the marker as Linux fails a file that is not executable',
    /Permission denied/.test(out) && /RC=126/.test(out), tail(out));
}
{
  const out = await run(`bash -c 'python3 -c "print(1)"; echo RC=$?'`);
  a.check('bash does not run python3 (GNU bash runs no session command): 126, not an empty success',
    /Permission denied/.test(out) && /RC=126/.test(out) && !/^1$/m.test(out), tail(out));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
