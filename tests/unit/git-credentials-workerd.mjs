#!/usr/bin/env bun
// @tier slow — a workerd probe session with the git runtime installed.
// Credential-store's own umask, through installed real git and the shell,
// protects the persistent file and does not change the caller's mask.
import assert from 'node:assert/strict';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const probe = await startLocalProbe({ runtimes: ['bash', 'git'] });
try {
  const terminal = await localTerminal(probe, { install: ['git'] });
  try {
    const run = async (command) => {
      const result = await terminal.run(command, 300_000);
      assert.equal(result.status, 0, `${command}: ${result.stdout.slice(-800)}`);
      return result.stdout;
    };
    const credential = 'protocol=https\\nhost=credentials.example\\nusername=ada\\npassword=secret\\n\\n';
    await run(`umask 022; printf '${credential}' | git credential-store store`);
    assert.equal((await run('stat -c %a ~/.git-credentials')).trim(), '600', 'only the owner can read credentials');
    assert.equal(await run('cat ~/.git-credentials'), 'https://ada:secret@credentials.example\n');
    assert.equal((await run('umask')).trim(), '0022', 'git does not change its parent shell mask');
    await run(`printf '${credential}' | git credential-store store`);
    assert.equal((await run('stat -c %a ~/.git-credentials')).trim(), '600', 'replacing the credential store stays private');
    assert.equal(await run("printf 'protocol=https\\nhost=credentials.example\\n\\n' | git credential-store get"), 'username=ada\npassword=secret\n', 'stored credentials can be retrieved');
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('git-credentials-workerd: installed git keeps its credential store private');
process.exit(0);
