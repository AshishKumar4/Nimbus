#!/usr/bin/env bun
// A write to a node program's stdout that fails is what Node makes of it,
// checked against the host's Node 22 running the same line under bash:
//
//   - Node ignores SIGPIPE, so a write to a closed pipe is an EPIPE 'error'
//     on process.stdout ("write EPIPE"); unhandled, the program ends with
//     its stack and status 1; handled, the program goes on;
//   - a write the file refuses (/dev/full) is the same with its own errno
//     ("ENOSPC: no space left on device, write");
//   - console.log's writes never throw: a failure there is ignored;
//   - a program hears it through an 'error' listener on the stream (on,
//     once, prependListener, prependOnceListener), or as an error nothing
//     caught ('uncaughtException', its monitor, a capture callback); with
//     none, it ends of it, whenever the write fails.
//
// Each line runs in the workspace's shell (the built-in node) and in bash
// with the host's node; their stdout, every pipeline status and what stderr
// says (each line that is not part of a stack or Node's own frame) agree.
//
// Red before: the realm dropped a failed write, so the program never heard
// of it: the writer ran on, and a refused write ended with status 0.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const WRITER = 'function w(){ process.stdout.write("y\\n"); setImmediate(w) } w()';
const CASES = [
  [`node -e '${WRITER}' | head -1; echo "ps=\${PIPESTATUS[*]}"`, 'an unhandled EPIPE ends the writer with its stack and 1'],
  [`set -o pipefail; node -e '${WRITER}' | head -1; echo "pipefail=$?"`, 'which pipefail reports'],
  [`node -e 'let n = 0; process.stdout.on("error", (e) => { if (n++ === 0) { console.error("handled", e.code, e.syscall, e.errno, e.message); setTimeout(() => { console.error("still running"); process.exit(7) }, 100) } }); ${WRITER}' | head -1; echo "ps=\${PIPESTATUS[*]}"`,
    'a handled EPIPE leaves the program running'],
  [`node -e 'process.stdout.write("x\\n")' > /dev/full; echo "full=$?"`, 'an unhandled ENOSPC ends the program with its stack and 1'],
  [`node -e 'process.stdout.on("error", (e) => { console.error("handled", e.code, e.syscall, e.errno, e.message); process.exitCode = 3 }); process.stdout.write("x\\n")' > /dev/full; echo "full=$?"`,
    'a handled ENOSPC is the program\'s to answer'],
  [`node -e 'console.log("x")' > /dev/full; echo "full=$?"`, 'console.log ignores its failed write'],
  // Every way a program hears a failed write, each against host Node:
  [`node -e 'process.stdout.once("error", (e) => { console.error("once", e.code); process.exitCode = 3 }); process.stdout.write("x\\n")' > /dev/full; echo "full=$?"`, 'a once listener hears it'],
  [`node -e 'process.stdout.prependListener("error", (e) => { console.error("prepended", e.code); process.exitCode = 3 }); process.stdout.write("x\\n")' > /dev/full; echo "full=$?"`, 'a prepended listener hears it'],
  [`node -e 'process.stdout.prependOnceListener("error", (e) => { console.error("prepended once", e.code); process.exitCode = 3 }); process.stdout.write("x\\n")' > /dev/full; echo "full=$?"`, 'a prepended once listener hears it'],
  [`node -e 'process.stderr.on("error", (e) => { console.log("stderr", e.code); process.exitCode = 4 }); process.stderr.write("x\\n")' 2>/dev/full; echo "full=$?"`, 'stderr\'s listener hears a failed stderr write'],
  [`node -e 'process.on("uncaughtException", (e) => { console.error("caught", e.code) }); process.stdout.write("x\\n")' > /dev/full; echo "full=$?"`, 'an uncaughtException listener takes the unhandled error'],
  [`node -e 'process.on("uncaughtExceptionMonitor", (e, origin) => { console.error("monitor", e.code, origin) }); process.stdout.write("x\\n")' > /dev/full; echo "full=$?"`, 'a monitor sees it, and the program still ends of it'],
  [`node -e 'process.setUncaughtExceptionCaptureCallback((e) => { console.error("captured", e.code) }); process.stdout.write("x\\n")' > /dev/full; echo "full=$?"`, 'a capture callback takes it'],
  [`node -e 'setTimeout(() => process.stdout.write("late\\n"), 10)' > /dev/full; echo "full=$?"`, 'a late write with no listener ends the program with its stack and 1'],
];

/** What stderr says, without the frames of a stack or Node's report around an uncaught error. */
const said = (stderr) => stderr.split('\n')
  .filter((line) => line !== '' && !/^\s+at /.test(line) && !/^(node:|\s+throw er|\s*\^|Emitted 'error' event|Node\.js v)/.test(line))
  .join('\n');

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const [line, what] of CASES) {
    const host = spawnSync('bash', ['--norc', '--noprofile', '-c', line], { encoding: 'utf8', timeout: 30_000, cwd: '/tmp' });
    const ours = await ws.exec(line, { cwd: '/home/user', timeout: 30_000 });
    const expected = { stdout: host.stdout, said: said(host.stderr) };
    const actual = { stdout: ours.stdout, said: said(ours.stderr) };
    try {
      assert.deepEqual(actual, expected);
      console.log(`  ✓ ${what}`);
    } catch {
      failed.push(`${what}\n  line: ${line}\n  node: ${JSON.stringify(expected)}\n  ours: ${JSON.stringify(actual)}`);
    }
  }
} finally {
  await ws.close();
}
assert.deepEqual(failed, [], `as the host's node:\n${failed.join('\n')}`);
console.log('lifo-node-output-failures: ok');
