// @serial
// @tier slow — drives a local workerd; refuses a 48 MiB < file: over 60 s for one read under a 1-CPU quota
// A 48 MiB `< file` into a Node guest flagged as reading stdin
// synchronously, under workerd: it is preloaded only up to the read ahead.
// One that never reads stdin is handed no more, twice in a row the same, and
// the session's cache does not grow with the file; a whole-file synchronous
// read of it fails naming the bound and process.stdin. (One that streams it
// gets every byte: node-runtime-code-stdin-stream-workerd.)
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
const FILES = {
  // A synchronous stdin read that does not run: the run may not be handed
  // more of its `< file` than the read ahead.
  'fp.js': 'if (process.argv[2]) require("fs").readFileSync(0); console.log("RAN");',
};

console.log('node-runtime-code-stdin-file-workerd: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(FILES)).toString('base64');
    const setup = await terminal.run(
      `mkdir -p ${W} && node -e "const f = JSON.parse(Buffer.from('${payload}', 'base64').toString()); for (const [n, t] of Object.entries(f)) require('fs').writeFileSync('${W}/' + n, t); console.log('SETUP')"`,
    );
    assert.match(setup.stdout, /SETUP/, setup.stdout);

    const READ_AHEAD = 16 * 1048576;
    const answered = async (work) => {
      const before = (await terminal.memory()).counters.supervisorAnsweredBytes;
      const result = await work();
      return { result, bytes: (await terminal.memory()).counters.supervisorAnsweredBytes - before };
    };
    // A large `< file` into a program flagged as reading stdin synchronously
    // is preloaded only up to the read ahead: one that never reads stdin is
    // handed no more. Twice in a row, the same: nothing kept the file for the
    // next run, and the session's cache did not grow with it.
    const made = await terminal.run(`cd ${W} && yes | head -c ${48 * 1048576} > big.txt && wc -c < big.txt`, 120_000);
    assert.match(made.stdout, new RegExp(`^${48 * 1048576}$`, 'm'), made.stdout);
    const bigUnread = await answered(() => terminal.run(`cd ${W} && node fp.js < big.txt`, 60_000));
    assert.match(bigUnread.result.stdout, /^RAN$/m, bigUnread.result.stdout);
    console.log(`node fp.js < 48 MiB file: the run was handed ${(bigUnread.bytes / 1048576).toFixed(1)} MiB`);
    assert.ok(bigUnread.bytes <= READ_AHEAD + 1048576, `a 48 MiB < file is not held whole: the run was handed ${bigUnread.bytes} bytes`);
    const cacheAfterFirst = (await terminal.memory()).vfsDetail.lruBytes;
    const again = await answered(() => terminal.run(`cd ${W} && node fp.js < big.txt`, 60_000));
    assert.match(again.result.stdout, /^RAN$/m, again.result.stdout);
    assert.equal(again.bytes, bigUnread.bytes, 'the second run is handed what the first was');
    const cacheAfterSecond = (await terminal.memory()).vfsDetail.lruBytes;
    assert.ok(cacheAfterSecond <= cacheAfterFirst, `the session's cache did not grow with the file: ${cacheAfterFirst} -> ${cacheAfterSecond} bytes`);
    // The refusal waits on the same slow path as a stream of the file (it
    // took over 60 s under a 1-CPU quota): the bound only tells a hang.
    const bigSync = await terminal.run(`cd ${W} && node -e 'require("fs").readFileSync(0)' < big.txt`, 150_000);
    assert.notEqual(bigSync.status, 0, bigSync.stdout);
    assert.match(bigSync.stdout, /larger than \d+ MiB[\s\S]*process\.stdin/, `a whole-file sync read of a 48 MiB < file names the bound: ${bigSync.stdout.slice(-500)}`);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-runtime-code-stdin-file-workerd: a 48 MiB < file is handed within the read ahead and refused whole, under workerd');
