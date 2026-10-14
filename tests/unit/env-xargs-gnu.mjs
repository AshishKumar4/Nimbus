#!/usr/bin/env bun
// env runs its command, and xargs takes each of GNU's spellings of its
// replace string, in the session's shell. Each expectation is what GNU
// coreutils 9.7 env and findutils 4.10.0 xargs print and end with for the
// same line under bash on armada (reference runs nimbus-20261014104215-5e06b3e1
// and nimbus-20261014105046-02add956). The commands env runs are ones a core
// workspace has: `sh` is the hosted session's.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });

// [line, stdout, stderr]; each line ends 0.
const CASES = [
  // env runs COMMAND with the environment its options and assignments make.
  [`env FOO=1 env | grep '^FOO='`, 'FOO=1\n', ''],
  [`env -i X=1 env`, 'X=1\n', ''],
  [`env -i env`, '', ''],
  [`env -u HOME env | grep -c '^HOME='; echo "rc=$?"`, '0\nrc=1\n', ''],
  [`env -uHOME env | grep -c '^HOME=' || true`, '0\n', ''],
  [`env --unset=HOME env | grep -c '^HOME=' || true`, '0\n', ''],
  [`env A_N=1 B_N=2 env | grep '^[AB]_N='`, 'A_N=1\nB_N=2\n', ''],
  [`env -- echo hi`, 'hi\n', ''],
  [`env FOO=1 | grep '^FOO='`, 'FOO=1\n', ''],
  [`env -0 -i A=1 B=2 | tr '\\0' ';'`, 'A=1;B=2;', ''],
  // Its statuses: COMMAND's own, 127 not found, 126 not runnable, 125 a bad option.
  [`env false; echo "rc=$?"`, 'rc=1\n', ''],
  [`env no-such-cmd; echo "rc=$?"`, 'rc=127\n', "env: 'no-such-cmd': No such file or directory\n"],
  [`env /tmp; echo "rc=$?"`, 'rc=126\n', "env: '/tmp': Permission denied\n"],
  [`env -x; echo "rc=$?"`, 'rc=125\n', "env: invalid option -- 'x'\nTry 'env --help' for more information.\n"],
  [`env --bogus; echo "rc=$?"`, 'rc=125\n', "env: unrecognized option '--bogus'\nTry 'env --help' for more information.\n"],
  [`env -u; echo "rc=$?"`, 'rc=125\n', "env: option requires an argument -- 'u'\nTry 'env --help' for more information.\n"],
  [`env -0 echo x; echo "rc=$?"`, 'rc=125\n', "env: cannot specify --null (-0) with command\nTry 'env --help' for more information.\n"],
  // xargs's replace string: -I R, -IR, -i, --replace=R; an item is a line, its leading blanks dropped.
  [`printf 'a b\\nc\\n' | xargs -I{} echo '[{}]'`, '[a b]\n[c]\n', ''],
  [`printf 'a\\nb\\n' | xargs -I {} echo '[{}]'`, '[a]\n[b]\n', ''],
  [`printf 'a\\n' | xargs -I% echo 'x%y'`, 'xay\n', ''],
  [`printf '  a b  \\n' | xargs -I{} echo '[{}]'`, '[a b  ]\n', ''],
  [`printf 'a\\n\\nb\\n' | xargs -I{} echo '[{}]'`, '[a]\n[b]\n', ''],
  [`printf 'a\\nb\\n' | xargs -i echo '[{}]'`, '[a]\n[b]\n', ''],
  [`printf 'a\\n' | xargs --replace=@ echo '[@]'`, '[a]\n', ''],
  [`printf 'a\\n' | xargs -I{} echo {} {}x 'y{}z'`, 'a ax yaz\n', ''],
];

const failures = [];
try {
  for (const [line, stdout, stderr] of CASES) {
    const r = await ws.exec(line, { timeout: 10_000 });
    try {
      assert.deepEqual({ code: r.exitCode, stdout: r.stdout, stderr: r.stderr }, { code: 0, stdout, stderr });
      console.log(`  ✓ ${line}`);
    } catch {
      failures.push(line);
      console.log(`  ✗ ${line}\n      got ${JSON.stringify({ code: r.exitCode, stdout: r.stdout, stderr: r.stderr })}`);
    }
  }
} finally {
  await ws.close();
}
assert.deepEqual(failures, []);
console.log('env and xargs as GNU: ok');
