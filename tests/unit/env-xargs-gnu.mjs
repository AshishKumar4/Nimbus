#!/usr/bin/env bun
// env runs its command, and xargs takes each of GNU's spellings of its
// replace string, in the session's shell. Each expectation is what GNU
// coreutils 9.7 env and findutils 4.10.0 xargs print and end with for the
// same line under bash on armada (reference runs nimbus-20261014104215-5e06b3e1,
// nimbus-20261014105046-02add956, nimbus-20261014122746-b68b5480,
// nimbus-20261014123725-f2839fb8, nimbus-20261014123932-9f785e09 and
// nimbus-20261014132917-b48dd611). The commands env runs are ones a core
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
  // GNU's getopt: clusters, prefixes, and the first operand ends the options.
  [`env -i0 A=1 | tr '\\0' ';'`, 'A=1;', ''],
  [`env -iuHOME A=1 env`, 'A=1\n', ''],
  [`env - A=1 env`, 'A=1\n', ''],
  [`env -u HOME -i A=1 env`, 'A=1\n', ''],
  [`env --ign A=1 env; echo "rc=$?"`, 'rc=125\n', "env: option '--ign' is ambiguous; possibilities: '--ignore-environment' '--ignore-signal'\nTry 'env --help' for more information.\n"],
  [`env A=1 -i env; echo "rc=$?"`, 'rc=127\n', "env: '-i': No such file or directory\n"],
  // -u NAME follows unsetenv's rule for a name, which -i makes moot.
  [`env -u 'A=B' true; echo "rc=$?"`, 'rc=125\n', "env: cannot unset 'A=B': Invalid argument\n"],
  [`env -u '' true; echo "rc=$?"`, 'rc=125\n', "env: cannot unset '': Invalid argument\n"],
  [`env -i -u 'A=B' env; echo "rc=$?"`, 'rc=0\n', ''],
  [`env --unset; echo "rc=$?"`, 'rc=125\n', "env: option '--unset' requires an argument\nTry 'env --help' for more information.\n"],
  // An option is one env has, not a name every object has.
  [`env --constructor; echo "rc=$?"`, 'rc=125\n', "env: unrecognized option '--constructor'\nTry 'env --help' for more information.\n"],
  [`env --__proto__; echo "rc=$?"`, 'rc=125\n', "env: unrecognized option '--__proto__'\nTry 'env --help' for more information.\n"],
  // A lone `-` after the options, `--` included, is -i; what follows it is the command's.
  [`env - -i; echo "rc=$?"`, 'rc=127\n', "env: '-i': No such file or directory\n"],
  [`env -- -`, '', ''],
  // Any operand with an `=` is an assignment, as putenv takes it; any name is a name.
  [`env -i '=value'`, '=value\n', ''],
  [`env =x env | grep -c '^=x$'`, '1\n', ''],
  [`env -i __proto__=x constructor=y env`, '__proto__=x\nconstructor=y\n', ''],
  // xargs's replace string: -I R, -IR, -i, --replace=R; an item is a line, its leading blanks dropped.
  [`printf 'a b\\nc\\n' | xargs -I{} echo '[{}]'`, '[a b]\n[c]\n', ''],
  [`printf 'a\\nb\\n' | xargs -I {} echo '[{}]'`, '[a]\n[b]\n', ''],
  [`printf 'a\\n' | xargs -I% echo 'x%y'`, 'xay\n', ''],
  [`printf '  a b  \\n' | xargs -I{} echo '[{}]'`, '[a b  ]\n', ''],
  [`printf 'a\\n\\nb\\n' | xargs -I{} echo '[{}]'`, '[a]\n[b]\n', ''],
  [`printf 'a\\nb\\n' | xargs -i echo '[{}]'`, '[a]\n[b]\n', ''],
  [`printf 'a\\n' | xargs --replace=@ echo '[@]'`, '[a]\n', ''],
  [`printf 'a\\n' | xargs -I{} echo {} {}x 'y{}z'`, 'a ax yaz\n', ''],
  [`printf '\\r\\nx\\n' | xargs -I {} echo '[{}]'`, '[x]\n', ''],
  [`printf '\\v\\f x\\n' | xargs -I {} echo '[{}]'`, '[x]\n', ''],
  [`printf 'a\\r\\n' | xargs -I {} echo '[{}]' | tr '\\r' R`, '[aR]\n', ''],
  // GNU's reading: quotes and backslashes decoded, in both modes; an open quote is an error after what was read.
  [`printf '"a b"\\n' | xargs -I{} echo '[{}]'`, '[a b]\n', ''],
  [`printf "'a b' c\\n" | xargs -I{} echo '[{}]'`, '[a b c]\n', ''],
  [`printf 'a\\\\ b\\n' | xargs -I{} echo '[{}]'`, '[a b]\n', ''],
  [`printf '""\\n' | xargs -I{} echo '[{}]'`, '[]\n', ''],
  [`printf '"a b" c\\n' | xargs -n1 echo`, 'a b\nc\n', ''],
  [`printf 'a"b c"d\\n' | xargs -n1 echo`, 'ab cd\n', ''],
  [`printf '"a\\n' | xargs -I{} echo '[{}]'; echo "rc=$?"`, 'rc=1\n', 'xargs: unmatched double quote; by default quotes are special to xargs unless you use the -0 option\n'],
  [`printf 'x\\ny\\n"z\\n' | xargs -I{} echo '[{}]'; echo "rc=$?"`, '[x]\n[y]\nrc=1\n', 'xargs: unmatched double quote; by default quotes are special to xargs unless you use the -0 option\n'],
  [`printf 'x y "z\\n' | xargs -n1 echo; echo "rc=$?"`, 'x\ny\nrc=1\n', 'xargs: unmatched double quote; by default quotes are special to xargs unless you use the -0 option\n'],
  [`printf "it's\\n" | xargs -n1 echo; echo "rc=$?"`, 'rc=1\n', 'xargs: unmatched single quote; by default quotes are special to xargs unless you use the -0 option\n'],
  // -n and a replace string exclude each other, the later winning; -n1 keeps the replace string.
  [`printf 'a\\nb\\nc\\n' | xargs -I{} -n2 echo '[{}]'`, '[{}] a b\n[{}] c\n', 'xargs: warning: options --replace and --max-args/-n are mutually exclusive, ignoring previous --replace value\n'],
  [`printf 'a\\nb\\nc\\n' | xargs --replace -n2 echo '[{}]'`, '[{}] a b\n[{}] c\n', 'xargs: warning: options --replace and --max-args/-n are mutually exclusive, ignoring previous --replace value\n'],
  [`printf 'a\\nb\\nc\\n' | xargs -n2 -I{} echo '[{}]'`, '[a]\n[b]\n[c]\n', 'xargs: warning: options --max-args and --replace/-I/-i are mutually exclusive, ignoring previous --max-args value\n'],
  [`printf 'a\\nb\\n' | xargs -I{} -n1 echo '[{}]'`, '[a]\n[b]\n', ''],
  [`printf 'x\\n' | xargs -I{} -n1 -I% echo '[%]'`, '[x]\n', ''],
  // At the end of input, what decodes to nothing is no item, an open quote included.
  [`printf '""' | xargs -I{} echo '[{}]'; echo "rc=$?"`, 'rc=0\n', ''],
  [`printf '"' | xargs -I{} echo '[{}]'; echo "rc=$?"`, 'rc=0\n', ''],
  [`printf '\\\\' | xargs -I{} echo '[{}]'; echo "rc=$?"`, 'rc=0\n', ''],
  [`printf 'x\\n"' | xargs -I{} echo '[{}]'; echo "rc=$?"`, '[x]\nrc=0\n', ''],
  [`printf 'x ""' | xargs -n1 echo '['; echo "rc=$?"`, '[ x\nrc=0\n', ''],
  [`printf '"a' | xargs -I{} echo '[{}]'; echo "rc=$?"`, 'rc=1\n', 'xargs: unmatched double quote; by default quotes are special to xargs unless you use the -0 option\n'],
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
