#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';
import { registerShellEntrypointCommands } from '../../packages/worker/src/shell/shell-entrypoints.ts';

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
      stderr: 'curl: (404) The requested URL returned error: 404\n',
      exitCode: 0,
    });

  await assertRun('virtual curl without -f still prints HTTP error bodies',
    'curl -s http://127.0.0.1:8123/missing; echo STATUS:$?',
    { stdout: 'MISSING_BODY\nSTATUS:0\n', stderr: '', exitCode: 0 });

  await assertRun('virtual curl -I and -f share failure handling',
    'curl -fIsS http://127.0.0.1:8123/missing; echo STATUS:$?',
    {
      stdout: 'STATUS:22\n',
      stderr: 'curl: (404) The requested URL returned error: 404\n',
      exitCode: 0,
    });

  await assertRun('virtual curl follows local redirects',
    'curl -fsSL http://127.0.0.1:8123/redirect; echo STATUS:$?',
    { stdout: 'OK_BODY\nSTATUS:0\n', stderr: '', exitCode: 0 });
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
