// @serial
// @tier slow — drives a local workerd; streams a 48 MiB < file: 44-120 s for the stream alone
// A 48 MiB `< file` into a Node guest flagged as reading stdin
// synchronously, under workerd: one that streams it with process.stdin gets
// every byte, though its synchronous read is preloaded only up to the read
// ahead (node-runtime-code-stdin-file-workerd).
//
// One of five files, each its own local workerd and session, so each fits
// the suite's per-file budget on a loaded machine (together they took
// 240-260 s alone, against run-all's 300 s): runtime code
// (node-runtime-code-workerd); stdin (node-runtime-code-stdin-workerd);
// a 48 MiB `< file` handed and refused (node-runtime-code-stdin-file-workerd)
// and streamed (node-runtime-code-stdin-stream-workerd); resident processes
// (node-runtime-code-resident-workerd).
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/w';

console.log('node-runtime-code-stdin-stream-workerd: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    await terminal.run(`mkdir -p ${W}`);
    const made = await terminal.run(`cd ${W} && yes | head -c ${48 * 1048576} > big.txt && wc -c < big.txt`, 120_000);
    assert.match(made.stdout, new RegExp(`^${48 * 1048576}$`, 'm'), made.stdout);
    // Not a deadline on the stream: the session answers nothing while it
    // streams (no terminal output, no _diag), so there is no progress to
    // wait on, and it took 44 to 120 s alone (a slow path, with the stdin
    // owner). The bound only tells a hang from it, inside the file's budget.
    const bigStream = await terminal.run(`cd ${W} && node -e 'if (process.argv[2]) require("fs").readFileSync(0); let n = 0; process.stdin.on("data", (d) => { n += d.length; }).on("end", () => console.log("BIGSTREAM " + n))' < big.txt`, 240_000);
    assert.match(bigStream.stdout, new RegExp(`^BIGSTREAM ${48 * 1048576}$`, 'm'), `a flagged program streams all of a 48 MiB < file: ${bigStream.stdout}`);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-runtime-code-stdin-stream-workerd: a flagged program streams all of a 48 MiB < file, under workerd');
