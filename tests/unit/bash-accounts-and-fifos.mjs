#!/usr/bin/env bun
// @tier slow — boots real bash and BusyBox off local disk.
// Real bash and BusyBox, in a workspace, see its accounts and its pipes as
// Linux programs do.
//
//   - Accounts are the session's /etc/passwd and /etc/group, read at each
//     lookup (nimbus-libc/nimbus-accounts.c): `~user` is the user's home and
//     `~root` root's, a name no account has stays as written, and `ls -l`
//     names each file's owner and group. An account added while bash runs
//     is found by its next lookup, and a renamed one by BusyBox's. An id
//     above 0x7fffffff names its account, and chown's -1 (`chown :group`)
//     keeps the owner.
//   - A pipe on stdin is a FIFO, as Linux says: bash's `test -p` on
//     /dev/stdin and /dev/fd/0, and BusyBox's `stat -c %F`.
//
// Red before: bash answered every name with one fixed account (home /root),
// BusyBox named every owner "user" and refused `chown :group` (its -1 uid
// reached the host signed: EINVAL); and preview1, which has no FIFO type,
// left a piped stdin untyped for both.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { missingRuntimeFile, RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { readText } from '../../packages/core/src/vfs/vfs.ts';

const missing = missingRuntimeFile();
if (missing !== null) {
  console.log(`bash-accounts-and-fifos: SKIPPED (${missing} not built)`);
  process.exit(0);
}

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const open = (options) => NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, cwd: '/home/user', ...options });
const seeded = await open({});
seedRuntime(seeded.vfs, RUNTIMES.find((runtime) => runtime.name === 'bash'));
const ws = await open({ facets: localFacetHost(ISOLATE_NETWORK) });

const failed = [];
const check = (what, actual, expected) => {
  try { assert.deepEqual(actual, expected); console.log(`  ✓ ${what}`); }
  catch { failed.push(`${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); console.log(`  ✗ ${what}`); }
};
const run = async (line) => {
  const result = await ws.exec(line);
  return { stdout: result.stdout, exitCode: result.exitCode, ...(result.exitCode === 0 ? {} : { stderr: result.stderr }) };
};

try {
  const kernel = ws.vfs.as(CRED_KERNEL);
  const home = (await readText(kernel, 'etc/passwd')).split('\n').find((line) => line.startsWith('user:')).split(':')[5];

  check('~user is the user\'s home, ~root root\'s, and an unknown name stays as written',
    await run(`bash -c 'printf "%s\\n" ~user ~root ~nosuch'`), { stdout: `${home}\n/root\n~nosuch\n`, exitCode: 0 });

  check('ls -l names each owner and group from the session\'s accounts',
    await run(`bash -c 'ls -ld /etc ${home} | while read -r mode links owner group rest; do echo "$owner:$group"; done'`),
    { stdout: 'root:root\nuser:user\n', exitCode: 0 });

  // uid_t and gid_t are unsigned: an id above 0x7fffffff (as a container's
  // subordinate ranges give) names its account, and chown's -1 keeps a side.
  kernel.writeFile('etc/passwd', `${await readText(kernel, 'etc/passwd')}wide:x:3000000000:3000000001::/home/wide:/bin/sh\n`);
  kernel.writeFile('etc/group', `${await readText(kernel, 'etc/group')}widegroup:x:3000000001:\n`);
  kernel.writeFile('tmp/wide', '');
  kernel.chown('tmp/wide', 3000000000, 3000000001);
  check('an owner and group above 0x7fffffff are named',
    await run(`bash -c 'stat -c %U:%G /tmp/wide; ls -l /tmp/wide | { read -r mode links owner group rest; echo "$owner:$group"; }'`),
    { stdout: 'wide:widegroup\nwide:widegroup\n', exitCode: 0 });
  check('chown :group keeps the owner (chown -1)',
    await run(`bash -c 'touch g; chown :user g && stat -c %U:%G g'`),
    { stdout: 'user:user\n', exitCode: 0 });

  // The user may edit the account files here, as root could: bash itself adds the account.
  kernel.chown('etc/passwd', 1000, 1000);
  kernel.chown('etc/group', 1000, 1000);
  check('an account added while bash runs is found by its next lookup',
    await run(`bash -c 'echo ~newuser; echo "newuser:x:1001:1001::/home/newuser:/bin/sh" >> /etc/passwd; echo ~newuser'`),
    { stdout: '~newuser\n/home/newuser\n', exitCode: 0 });
  check('and a renamed account and group by BusyBox\'s',
    await run(`bash -c 'sed s/^user:/renamed:/ /etc/passwd > /tmp/p; cat /tmp/p > /etc/passwd; sed s/^user:/crew:/ /etc/group > /tmp/g; cat /tmp/g > /etc/group; stat -c %U:%G ${home}'`),
    { stdout: 'renamed:crew\n', exitCode: 0 });

  check('a piped stdin is a FIFO to bash\'s test -p and to BusyBox\'s stat',
    await run(`echo x | bash -c '[ -p /dev/stdin ] && echo stdin; [ -p /dev/fd/0 ] && echo fd0; stat -c %F /dev/stdin'`),
    { stdout: 'stdin\nfd0\nfifo\n', exitCode: 0 });
} finally {
  await ws.close();
  await seeded.close();
}
assert.deepEqual(failed, [], `as Linux:\n${failed.join('\n')}`);
console.log('bash-accounts-and-fifos: ok');
