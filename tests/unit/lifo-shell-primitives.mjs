#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { PipeChannel } from '../../packages/core/src/substrate/lifo/shell/pipe.ts';
import { TerminalStdin } from '../../packages/core/src/substrate/lifo/shell/terminal-stdin.ts';

const box = await Sandbox.create({ persist: false });

try {
  registerShellEntrypointCommands(
    box.commands.registry,
    { execute: (cmd, options) => box.shell.execute(cmd, options) },
    box.kernel.vfs,
  );

  box.kernel.portRegistry.set(8123, (req, res) => {
    if (req.url === '/redirect') {
      res.statusCode = 307;
      res.headers.Location = '/ok';
      res.body = 'REDIRECT_BODY';
      return;
    }
    if (req.url === '/missing') {
      res.statusCode = 404;
      res.body = 'MISSING_BODY';
      return;
    }
    res.statusCode = 200;
    res.body = 'OK_BODY';
  });

  await assertRun('quoted double-bracket delimiter is expression data',
    'if [[ "x" == "]]" ]]; then echo BAD; else echo QUOTED_DELIM_OK; fi',
    { stdout: 'QUOTED_DELIM_OK\n', stderr: '', exitCode: 0 });

  await assertRun('quoted double-bracket RHS compares literally',
    'pat="f*"; if [[ foo == "$pat" ]]; then echo BAD; else echo QUOTED_PATTERN_OK; fi',
    { stdout: 'QUOTED_PATTERN_OK\n', stderr: '', exitCode: 0 });

  await assertRun('unquoted double-bracket RHS remains a pattern',
    'pat="f*"; if [[ foo == $pat ]]; then echo UNQUOTED_PATTERN_OK; fi',
    { stdout: 'UNQUOTED_PATTERN_OK\n', stderr: '', exitCode: 0 });

  await assertRun('exit inside pipeline does not terminate the parent script',
    'exit 3 | cat; echo AFTER:$?',
    { stdout: 'AFTER:0\n', stderr: '', exitCode: 0 });

  await assertRun('sed replacement handles escaped ampersand literally',
    'printf "abc\\n" | sed "s/b/\\\\&/"',
    { stdout: 'a&c\n', stderr: '', exitCode: 0 });

  await assertRun('sed replacement keeps literal dollars',
    'printf "abc\\n" | sed "s/a/\\$1/"',
    { stdout: '$1bc\n', stderr: '', exitCode: 0 });

  await assertRun('virtual curl -f suppresses failed response bodies',
    'curl -fsS http://127.0.0.1:8123/missing; echo STATUS:$?',
    {
      stdout: 'STATUS:22\n',
      stderr: 'curl: (22) The requested URL returned error: 404\n',
      exitCode: 0,
    });

  await assertRun('virtual curl without -f still prints HTTP error bodies',
    'curl -s http://127.0.0.1:8123/missing; echo STATUS:$?',
    { stdout: 'MISSING_BODY\nSTATUS:0\n', stderr: '', exitCode: 0 });

  await assertRun('virtual curl -I and -f share failure handling',
    'curl -fIsS http://127.0.0.1:8123/missing; echo STATUS:$?',
    {
      stdout: 'STATUS:22\n',
      stderr: 'curl: (22) The requested URL returned error: 404\n',
      exitCode: 0,
    });

  await assertRun('virtual curl follows local redirects',
    'curl -fsSL http://127.0.0.1:8123/redirect; echo STATUS:$?',
    { stdout: 'OK_BODY\nSTATUS:0\n', stderr: '', exitCode: 0 });

  await assertRun('virtual curl reports the redirected URL via %{url_effective}',
    "curl -fsSLo /dev/null -w '%{url_effective}\\n' http://127.0.0.1:8123/redirect; echo STATUS:$?",
    { stdout: 'http://127.0.0.1:8123/ok\nSTATUS:0\n', stderr: '', exitCode: 0 });

  await assertRun('empty -D target attempts the resolved path and exits 23',
    "curl -sS -D '' -o /dev/null http://127.0.0.1:8123/dump-target; echo STATUS:$?",
    {
      stdout: 'STATUS:23\n',
      stderr: "curl: (23) Failed create dump-header file '': EISDIR: '/home/user': is a directory\n",
      exitCode: 0,
    });

  // Input redirection opens and authorizes the target before the command
  // runs, so even a command that never reads sees open(2) semantics.
  await assertRun('input redirection fails a command that never reads',
    'true < /missing/file; echo STATUS:$?',
    { stdout: 'STATUS:1\n', stderr: 'sh: /missing/file: No such file or directory\n', exitCode: 0 });

  await assertRun('input redirection refuses directories',
    'true < /home/user; echo STATUS:$?',
    { stdout: 'STATUS:1\n', stderr: 'sh: /home/user: Is a directory\n', exitCode: 0 });

  box.kernel.vfs.writeFile('/tmp/locked.bin', 'secret');
  box.kernel.vfs.chmod('/tmp/locked.bin', 0o000);
  await assertRun('input redirection honors read authorization',
    'true < /tmp/locked.bin; echo STATUS:$?',
    { stdout: 'STATUS:1\n', stderr: 'sh: /tmp/locked.bin: Permission denied\n', exitCode: 0 });

  // A bounded byte read returns what a live producer already delivered;
  // it must not wait for maxLength bytes to fill or for the writer to close.
  {
    const encoder = new TextEncoder();
    const channel = new PipeChannel();
    let delivered = null;
    const parked = channel.reader.readBytes(4096).then((bytes) => { delivered = bytes; return bytes; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    channel.writer.writeBytes(encoder.encode('ab'));
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('readBytes waited for fill')), 2000);
    });
    await Promise.race([parked, guard]);
    clearTimeout(timer);
    assert.deepEqual(delivered, encoder.encode('ab'));
    channel.writer.writeBytes(encoder.encode('cdef'));
    assert.deepEqual(await channel.reader.readBytes(3), encoder.encode('cde'));
    assert.deepEqual(await channel.reader.readBytes(4096), encoder.encode('f'));
    channel.close();
    assert.equal(await channel.reader.readBytes(4096), null);

    const term = new TerminalStdin();
    term.feed('x');
    assert.deepEqual(await term.readBytes(4096), encoder.encode('x'));
    term.feed('yz');
    assert.deepEqual(await term.readBytes(1), encoder.encode('y'));
    assert.deepEqual(await term.readBytes(4096), encoder.encode('z'));
    term.close();
    assert.equal(await term.readBytes(4096), null);
  }
} finally {
  box.destroy();
}

console.log('lifo-shell-primitives: ok');

async function assertRun(name, command, expected) {
  const result = await box.commands.run(command, { timeout: 60_000 });
  assert.equal(result.exitCode, expected.exitCode, `${name}: exitCode`);
  assert.equal(result.stdout, expected.stdout, `${name}: stdout`);
  assert.equal(result.stderr, expected.stderr, `${name}: stderr`);
}
