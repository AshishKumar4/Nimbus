#!/usr/bin/env bun
// Behavior test: /dev/fd/N, /proc/self/fd/N and /dev/std{in,out,err} name the
// process's own descriptors in the wasm bash, as on Linux.
//
// bash is configured with bash_cv_dev_fd=standard and bash_cv_dev_stdin=present
// (packages/worker/wasm/bash/cross.cache): it hands process substitution's
// pipe to a command as /dev/fd/N and opens /dev/stdin itself, trusting the OS
// to resolve both. Driven through REAL bash on the REAL staged wasm, with
// busybox for the commands, so each case is what a script observes. Every
// expectation is native Linux bash's answer to the same script.

import assert from 'node:assert/strict';
import { runScript } from './lib/bash-preamble.mjs';

const fs = { dirs: ['tmp'], modes: { tmp: 7 } };
const cases = [
  // Process substitution: bash opens /dev/fd/63 itself (source, a redirection)
  // or hands the path to a command.
  { script: "source <(echo 'echo sourced')", stdout: 'sourced\n', exitCode: 0 },
  { script: "while read -r l; do echo \"[$l]\"; done < <(printf 'a\\nb\\n')", stdout: '[a]\n[b]\n', exitCode: 0 },
  { script: 'cat <(echo x) <(echo y)', stdout: 'x\ny\n', exitCode: 0 },
  { script: 'diff <(echo a) <(echo a) && echo same', stdout: 'same\n', exitCode: 0 },
  { script: 'echo data > >(cat > /tmp/o); wait $!; cat /tmp/o', stdout: 'data\n', exitCode: 0 },
  // A descriptor the script opened, by its number.
  { script: "exec 4<<<'four'; read -r y < /dev/fd/4; echo \"$y\"", stdout: 'four\n', exitCode: 0 },
  { script: "exec 4<<<'four'; read -r y < /proc/self/fd/4; echo \"$y\"", stdout: 'four\n', exitCode: 0 },
  { script: '[ -e /dev/fd/0 ] && echo yes; [ -e /dev/fd/9 ] || echo no', stdout: 'yes\nno\n', exitCode: 0 },
  { script: 'cat /dev/fd/9', stdout: '', exitCode: 1 },
  // A file a descriptor names is opened again, with the new open's flags: its
  // own offset (the original's stays where it was), O_TRUNC honored.
  { script: '{ printf old; printf new >/dev/stdout; } >/tmp/o; cat /tmp/o', stdout: 'new', exitCode: 0 },
  { script: 'printf abc >/tmp/a; exec 5>>/tmp/a; printf x >/dev/fd/5; cat /tmp/a', stdout: 'x', exitCode: 0 },
  { script: 'printf data >/tmp/f; exec 4</tmp/f; read -r -n 2 c <&4; cat /dev/fd/4; echo; read -r rest <&4; echo "rest=$rest"', stdout: 'data\nrest=ta\n', exitCode: 0 },
  // The file itself, never its old name: renamed, the descriptor's file is written and the new one at the name is not;
  // unlinked, it is still read.
  { script: 'printf old >/tmp/a; exec 4<>/tmp/a; mv /tmp/a /tmp/b; printf new >/tmp/a; printf changed >/dev/fd/4; cat /tmp/a; printf :; cat /tmp/b', stdout: 'new:changed', exitCode: 0 },
  { script: 'printf old >/tmp/c; exec 4</tmp/c; rm /tmp/c; cat /dev/fd/4', stdout: 'old', exitCode: 0 },
  { script: 'printf old >/tmp/d; exec 4</tmp/d; mv /tmp/d /tmp/e; printf new >/tmp/d; cat /dev/fd/4; printf :; cat /tmp/d', stdout: 'old:new', exitCode: 0 },
  // Stat'd, it is that file's: its mode, by an absolute name or one relative to the cwd.
  { script: 'printf data >/tmp/p; chmod 400 /tmp/p; exec 4</tmp/p; stat -Lc %a /dev/fd/4', stdout: '400\n', exitCode: 0 },
  { script: 'cd /; printf d >/tmp/g; chmod 640 /tmp/g; exec 4</tmp/g; stat -Lc %a ./dev/fd/4', stdout: '640\n', exitCode: 0 },
  // The standard streams by name.
  { script: 'read -r x < /dev/stdin; echo "got $x"', stdin: 'line\n', stdout: 'got line\n', exitCode: 0 },
  { script: 'cat /dev/stdin', stdin: 'piped\n', stdout: 'piped\n', exitCode: 0 },
  { script: 'echo out > /dev/stdout', stdout: 'out\n', exitCode: 0 },
  { script: '{ echo err > /dev/stderr; } 2>&1', stdout: 'err\n', exitCode: 0 },
  { script: 'echo to-err > /dev/stderr', stdout: '', stderr: 'to-err\n', exitCode: 0 },
];

const failures = [];
for (const c of cases) {
  const r = await runScript(c.script, { ...fs, stdin: c.stdin });
  const got = { stdout: r.stdout, exitCode: r.exitCode, ...(c.stderr === undefined ? {} : { stderr: r.stderr }) };
  const want = { stdout: c.stdout, exitCode: c.exitCode, ...(c.stderr === undefined ? {} : { stderr: c.stderr }) };
  try { assert.deepEqual(got, want); console.log(`  ✓ ${c.script}`); }
  catch { failures.push(`${c.script}: got ${JSON.stringify({ ...got, stderr: r.stderr, error: r.error })}, want ${JSON.stringify(want)}`); console.log(`  ✗ ${c.script}`); }
}
assert.deepEqual(failures, []);
console.log(`bash-dev-fd: ${cases.length} cases answer as Linux bash does`);
