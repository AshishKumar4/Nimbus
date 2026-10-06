// @serial
// @tier slow — drives a local workerd; CI median 27 s wall, 30 s CPU, 1.9 GiB peak (6 runs, 2026-10-06)
// A process's filesystem errors carry their POSIX code across the real
// workerd RPC hops between the process and its session (process isolate →
// SupervisorRPC → session Durable Object and back). Nothing on either side
// recovers the code from the message: workerd carries the error's own
// `code` property because both isolates run with enhanced_error_serialization
// (on by compatibility date from 2026-04-21; the session at apps/probe's
// date, the process at CF_COMPAT_DATE). With the session on
// `legacy_error_serialization` (and the composition guard bypassed), every
// failure below that is an error rather than an absent answer reached the
// program as EIO / "I/O error".
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

console.log('fs-error-codes-cross-workerd-rpc: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe);
  try {
    const setup = await terminal.run('mkdir -p /home/user/full && echo x > /home/user/full/f && echo y > /home/user/file');
    assert.equal(setup.status, 0, `setup: ${setup.stdout}`);

    // Node: each failure below is answered by the session's filesystem.
    const script = "const fs = require('fs').promises; const ops = ["
      + "() => fs.rmdir('/home/user/full'), "
      + "() => fs.unlink('/home/user/full'), "
      + "() => fs.readdir('/home/user/file'), "
      + "() => fs.access('/home/user/nope'), "
      + "() => fs.mkdir('/home/user/file/sub'), "
      + "() => fs.truncate('/home/user/nope')]; "
      + "(async () => { const codes = []; for (const op of ops) { try { await op(); codes.push('ok'); } "
      + "catch (e) { codes.push(e.code); } } console.log('CODES ' + codes.join(' ')); })();";
    const node = await terminal.run(`node -e "${script}"`);
    assert.match(node.stdout, /CODES ENOTEMPTY EISDIR ENOTDIR ENOENT ENOTDIR ENOENT\n/, node.stdout);

    // Bash: its WASI syscalls reach the same filesystem through the same hop.
    const bash = await terminal.run("bash -c 'mkdir /home/user/full; rmdir /home/user/full; cat < /home/user/file/child'");
    assert.match(bash.stdout, /mkdir: .*File exists/, bash.stdout);
    assert.match(bash.stdout, /rmdir: .*Directory not empty/, bash.stdout);
    assert.match(bash.stdout, /child: Not a directory/, bash.stdout);
    assert.doesNotMatch(bash.stdout, /I\/O error/, bash.stdout);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('fs-error-codes-cross-workerd-rpc: filesystem error codes cross workerd RPC intact');
