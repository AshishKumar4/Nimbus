#!/usr/bin/env bun
// node/cwd-data-file-session-survival — a large data file sitting in the
// working directory must not kill the session that made it.
//
// The prefetch bundle a one-shot `node` facet is built with includes a
// snapshot of the working tree (facets/manager.ts addCwdProjectFiles), and
// that snapshot admits a single file up to the whole VFS_BUNDLE_MAX_BYTES
// budget. Once one is in, every later invocation carries it: the cached
// bundle stays resident while the next build makes a second copy, and the
// encoded-size guard then JSON-stringifies and UTF-8-encodes the lot. Live on
// a deployed Worker that is enough to reset the supervisor DO — and a reset
// drops the shell WebSocket server-side WITHOUT closing it, so the user's
// terminal stays open, accepts input, and answers nothing, forever.
//
// This is the cheap form of the `pi --help` hang in
// scratchpad/pi-help-lost-exit-hang.md: same signature (empty buffer, no echo,
// socket open, second terminal healthy), seconds instead of a 90s npm install.
// Measured 4/4 on a deployed Worker: 20 MiB alone is fine, 24 MiB alone is
// fine, and a trivial `node -e` run twice AFTER a 20 MiB file lands in
// /home/user wedges. Writing the same bytes outside the cwd never does.

import {
  deleteSession,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('node/cwd-data-file-session-survival');

const write20MiB = (path) =>
  `node -e 'const fs=require("fs");const fd=fs.openSync("${path}","w");` +
  `const c=Buffer.alloc(65536,65);for(let i=0;i<320;i++)fs.writeSync(fd,c);` +
  `fs.closeSync(fd);console.log("WROTE "+fs.statSync("${path}").size);'`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  const wrote = stripAnsi((await t.run(write20MiB('/home/user/data.bin'), 120_000)).output);
  a.check('a 20 MiB data file lands in the working directory',
    /WROTE 20971520/.test(wrote),
    JSON.stringify(wrote.slice(-300)));

  // Two runs, because one is not enough: the first build populates the
  // prefetch-bundle cache, the second has to hold the cached copy AND build
  // the next one alongside it. That doubling is the ordering discriminator
  // the pi hang showed as `--version` then `--help`.
  for (const n of [1, 2]) {
    const out = stripAnsi((await t.run(`node -e 'console.log("TRIVIAL${n}")'`, 45_000)).output);
    a.check(`a trivial node run still answers with a 20 MiB file in the cwd (run ${n})`,
      new RegExp(`TRIVIAL${n}`).test(out),
      JSON.stringify(out.slice(-300)));
  }

  // The terminal must still be a terminal. A wedged connection swallows this
  // silently — no echo, no prompt, socket open.
  const alive = stripAnsi((await t.run('echo SHELL_STILL_ANSWERS', 30_000)).output);
  a.check('the shell still answers after the run',
    /SHELL_STILL_ANSWERS/.test(alive),
    JSON.stringify(alive.slice(-300)));
} catch (e) {
  a.check('the session survived the run', false, e?.message || String(e));
} finally {
  await t.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
