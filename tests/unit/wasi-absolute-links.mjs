#!/usr/bin/env bun
// A WASI guest resolves an absolute symlink through the namespace (Kinu's
// ask 15). Kinu's home is /home/main with /home/user -> /home/main, and every
// path through that link failed in a WASI guest with errno 76 ("Capabilities
// insufficient"): the walk beneath a preopen (walkBeneath, VFS-COMP-006)
// refused any absolute link target. Now an absolute target resolves from the
// namespace's `/`, as the unrestricted walk resolves it, and what the walk
// reaches must still lie at or under the preopen's root.
//
//   - Real bash and BusyBox over the runner's WASI layer: cd, pwd, cat (open),
//     ls (listdir), test -e (exists) and stat through the link, through a
//     chain of absolute links, and a dangling one (ENOENT, not ENOTCAPABLE).
//   - The walk itself, beneath a root other than `/`: an absolute link that
//     lands beneath the root resolves, one that lands outside is ENOTCAPABLE.

import assert from 'node:assert/strict';
import { runScript } from './lib/bash-preamble.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// ── A WASI guest through absolute links ─────────────────────────────────────
{
  const result = await runScript([
    'rm -r /home/user && mkdir -p /home/main/site && echo hello > /home/main/site/index.html',
    'ln -s /home/main /home/user && ln -s /home/user/site /tmp/chain && ln -s /home/main/nowhere /tmp/dangling',
    'cd /home/user/site && pwd && cat index.html && ls && test -e index.html && echo exists && stat -c %s index.html',
    'cat /tmp/chain/index.html && ls /tmp/chain && test -d /tmp/chain && echo chain-is-dir',
    'test -e /tmp/dangling || echo dangling-absent',
    'cd /tmp/dangling',
  ].join('\n'), { dirs: ['home'] });
  assert.equal(result.stdout, [
    '/home/user/site', 'hello', 'index.html', 'exists', '6',
    'hello', 'index.html', 'chain-is-dir',
    'dangling-absent', '',
  ].join('\n'), `stderr: ${result.stderr}`);
  assert.equal(result.stderr, 'bash: line 6: cd: /tmp/dangling: No such file or directory\n', 'a dangling absolute link is ENOENT');
  assert.equal(result.exitCode, 1);
}

// ── The walk beneath a root that is not `/` ─────────────────────────────────
{
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const root = raw.as(CRED_KERNEL);
  root.mkdir('home/main/site/assets', { recursive: true });
  root.writeFile('home/main/site/assets/a.css', 'a');
  root.writeFile('home/main/secret', 's');
  root.symlink('/home/main/site/assets', 'home/main/site/in');
  root.symlink('/home/main/secret', 'home/main/site/out');
  const files = new ProcessFiles(raw);
  for (const [pid, face] of [[7, 'synchronous'], [8, 'awaiting']]) {
    const bound = files.bind({ pid, cred: CRED_KERNEL });
    const fs = face === 'synchronous' ? bound.synchronous : bound;
    const beneath = (path) => ({ root: 'home/main/site', path, beneath: true });
    assert.equal((await fs.stat(beneath('in/a.css'))).size, 1, `${face}: an absolute link landing beneath the root resolves`);
    await assert.rejects(async () => fs.stat(beneath('out')), { code: 'ENOTCAPABLE' }, `${face}: one landing outside it does not`);
    await files.releaseProcess(pid);
  }
  harness.db.close();
}

console.log('wasi-absolute-links: ok');
