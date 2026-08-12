#!/usr/bin/env bun
/**
 * shell-install-scripts — what a real `curl … | bash` installer needs.
 *
 * The owner's command,
 *
 *     curl -fsSL 'https://proteus.ashishkumarsingh.com/install.sh' | bash
 *
 * cleared its platform gate and then stopped, in order, on: `unzip -oqd`
 * (clustered short flags rejected outright), `mv` (every rename inside a
 * mounted filesystem reported "cannot rename across mount boundaries", and
 * there was no cross-device fallback at all), `x="$(cmd)"` swallowing cmd's
 * exit status so `|| die` never fired, a missing `local`, and missing arrays.
 * None of those are specific to that installer — they are the ordinary
 * vocabulary of shell scripts.
 *
 * Every expectation was produced by running the identical snippet under real
 * GNU bash, and everything runs through the command registry a session
 * resolves through: registerUnixCommands + registerShellEntrypointCommands +
 * installPathExecResolver, driven as `bash script`, never a directly
 * constructed interpreter.
 */

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { registerShellEntrypointCommands } from '../../packages/worker/src/shell/shell-entrypoints.ts';
import { installPathExecResolver } from '../../packages/worker/src/shell/exec-dispatch.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('home', { mode: 0o755 });
root.mkdir('home/user', { mode: 0o755 });
root.chown('home/user', 1000, 1000);
root.mkdir('tmp', { mode: 0o777 });
root.chown('tmp', 1000, 1000);

const box = await Sandbox.create({ persist: false });
box.kernel.vfs.mount('/home', new SqliteVFSProvider(rawVfs, 'home'));
box.kernel.vfs.mount('/tmp', new SqliteVFSProvider(rawVfs, 'tmp'));
installPathExecResolver(box.commands.registry, root, () => box.shell.getCwd?.() ?? '/home/user');
registerUnixCommands(box.commands.registry, rawVfs);
registerShellEntrypointCommands(
  box.commands.registry,
  { execute: (cmd, options) => box.shell.execute(cmd, options) },
  box.kernel.vfs,
);

const failures = [];
let caseNo = 0;

/** Run a script the way a user does: `bash script.sh`. */
async function check(name, script, expected) {
  const path = `tmp/case${caseNo++}.sh`;
  root.writeFile(path, script, { mode: 0o755 });
  const result = await box.shell.execute(`bash /${path}`, {});
  const actual = {
    stdout: result.stdout ?? '',
    exitCode: result.exitCode,
    ...(expected.stderr === undefined ? {} : { stderr: result.stderr ?? '' }),
  };
  const want = {
    stdout: expected.stdout,
    exitCode: expected.exitCode ?? 0,
    ...(expected.stderr === undefined ? {} : { stderr: expected.stderr }),
  };
  try {
    assert.deepEqual(actual, want);
    console.log(`  ok   ${name}`);
  } catch {
    failures.push(name);
    console.log(`  FAIL ${name}\n         want ${JSON.stringify(want)}\n         got  ${JSON.stringify(actual)}`);
  }
}

// ── clustered short flags ──────────────────────────────────────────────────
// POSIX Utility Syntax Guideline 5: `-oqd` is `-o -q -d`. Rejecting the
// cluster is what stopped the bun installer's `unzip -oqd "$bin_dir" …`.

await check('unzip accepts a cluster ending in an option that takes a value',
  `cd /tmp\nmkdir -p src out\nprintf payload > src/f.txt\nzip -q a.zip src/f.txt\n` +
  `unzip -oqd out a.zip\necho "rc=$?"\ncat out/src/f.txt\necho\n`,
  { stdout: 'rc=0\npayload\n' });

await check('unzip -q suppresses the extraction listing',
  `cd /tmp\nmkdir -p q\nprintf payload > q/f.txt\nzip -q q.zip q/f.txt\nrm -rf q\nunzip -oq q.zip\n`,
  { stdout: '' });

await check('unzip without -q names each entry it extracted',
  `cd /tmp\nmkdir -p v\nprintf payload > v/f.txt\nzip -q v.zip v/f.txt\nrm -rf v\n` +
  `unzip -o v.zip | grep -c v/f.txt\n`,
  { stdout: '1\n' });

await check('unzip -d creates the destination directory',
  `cd /tmp\nprintf p > d1.txt\nzip -q d1.zip d1.txt\nunzip -q -d made/deeper d1.zip\ncat made/deeper/d1.txt\necho\n`,
  { stdout: 'p\n' });

await check('an option the command does not have is still an error',
  `cd /tmp\nprintf p > e.txt\nzip -q e.zip e.txt\nunzip -oZ e.zip\necho "rc=$?"\n`,
  { stdout: 'rc=1\n', stderr: 'unzip: invalid option: -Z\n' });

// gzip/gunzip run their bytes through CompressionStream, which the Workers
// runtime has and this test host does not, so assert on the argument parse:
// a cluster must reach the file, not bounce off the option table.
await check('gzip reads -dk as -d -k rather than rejecting the cluster',
  `cd /tmp\nif gzip -dk absent.gz 2>&1 | grep -q 'invalid option'; then echo rejected; else echo parsed; fi\n`,
  { stdout: 'parsed\n' });

await check('gzip accepts a compression level and ignores it',
  `cd /tmp\nif gzip -9 absent.txt 2>&1 | grep -q 'invalid option'; then echo rejected; else echo parsed; fi\n`,
  { stdout: 'parsed\n' });

await check('gunzip still rejects an option it does not have',
  `cd /tmp\ngunzip -Z absent.gz\necho "rc=$?"\n`,
  { stdout: 'rc=1\n', stderr: "gunzip: invalid option -- 'Z'\n" });

box.destroy();

if (failures.length > 0) {
  console.error(`shell install scripts: ${failures.length} failed`);
  process.exit(1);
}
console.log('shell install scripts: ok');
