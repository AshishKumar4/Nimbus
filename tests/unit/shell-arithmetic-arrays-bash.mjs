#!/usr/bin/env bun
// Array elements and readonly names in shell arithmetic, as bash 5.2 has
// them: `a[subscript]` reads and assigns an element (its subscript itself
// arithmetic, read once where the name is, a negative one counted back from
// past the last value); `a` alone is its first element; an element of a
// scalar promotes it to an array; a subscript `@`, `*`, or one before the
// first is warned of (`bad array subscript`), the read 0 and the assignment
// not made, the command going on. An assignment to a readonly name is
// refused (`r: readonly variable`, the name's own diagnostic): `((…))` and
// `let` fail with 1, and in `$((…))` the line is discarded. `${t[-1]}` of a
// scalar is a bad subscript too. Before (ticket-lifo-arithmetic-arrays-
// readonly), `a[1]` read as `a`, and a readonly name was written. Host bash
// is the oracle (stdout, status, stderr without bash's line prefix). A
// subscript is read whole (quotes, substitutions), its quotes removed, and
// an error in it discards the line wherever it is; `$((…))`'s text is
// expanded (parameters, substitutions, quotes) before it is evaluated, so
// `$((2*$j))` with j=1+1 is 3, as bash's.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const LINES = [
  'a=(1 2 3); echo $((a[1] + a[-1])) $((a)); ((a[1] += 5)); ((a[i=2]++)); declare -p a i',
  's=4; ((s[1] = 2)); declare -p s; t=5; echo $((t[0])) $((t[-1])) $((t[1])); echo "${t[-1]}"',
  'readonly r=1; ((r = 2)); echo "st=$?"; let r++; echo "st=$?"\necho $((r += 1)); echo same\necho "next $?"',
  'readonly r=1; [[ $((r=2)) ]]; echo "st=$?"\nfor ((r=5;;)); do break; done; echo "for $?"\na=(1); readonly a; ((a[0]=3)); echo "arr $?"; declare -p a',
  'a=(1 2); echo $((a[-9]))\necho "st=$?"; echo "${a[-9]}" end',
  'a=(1 2); ((a[-9] = 1)); echo "st=$?"; echo $((a[-9]=3)); echo next; declare -p a',
  'a=(1 2); echo $((++a[0])) $((a[1]--)) ${a[@]}; i=0; echo $((a[i++] + a[i])) $i',
  'b=([1]="1+2"); echo $((b[1] * 2)); unset c; echo $((c[3] + 1)); ((c[3]++)); declare -p c',
  'x=1; echo $((0 && a[x=5])) $x',
  'a=(1 2); echo $((a[ 1 ]))',
  'a=(1 2); echo $((a[@])) $((a[*]))\necho next',
  'a=(5 6); i=1; echo $((a[$i])) $(( a[i] * 2 )); a[3]=x; echo $((a[3]))\necho next',
  'set -- 4 5; a=(7 8); echo $((a[$1-3])) $(($2 + a[1]))',
  'a=(1 2); [[ a[1] -eq 2 && a[-1] -gt 1 ]] && echo cond; [[ a[-9] -eq 0 ]] && echo zero; let "a[0] = a[1] * 3"; declare -p a',
  'n=(0 0 0); for ((k = 0; k < 3; k++)); do ((n[k] = k * k)); done; declare -p n',
  // A compound assignment's element is found once, before its right side; `=`'s after it.
  'a=(1 2); ((a[-1] += (a[2]=5))); declare -p a; i=0; b=(10 20); ((b[i]=(i=1,7))); declare -p b',
  // A blank subscript is 0; a quoted one's quotes are removed; a quoted ] is the subscript's.
  'a=(5 6); echo $((a[ ])); ((a[ ]=9)); declare -p a',
  "a=(10 20); echo $((a[\"1\"])); e='a[\"1\"]'; echo $((e)); x=0; let '0 && a[\"]\"], x=1'; echo \"$x\"",
  // A subscript's error is an expansion's: the line is discarded, in ((, let and [[ too, as a script
  // runs it (`bash -c` ends instead).
  { line: 'a=(1); ((a[1/0])); echo same\necho "next $?"; let "a[1/0]"; echo same\necho "next $?"; [[ a[1/0] -eq 1 ]]; echo same\necho "next $?"', script: 'bash' },
  { line: 'a=(1); readonly r=1; ((a[r=2])); echo same\necho "next $?"; f() { ((a[1/0])); echo in; }; f; echo after\necho "next $?"', script: 'bash' },
  '(a=(1); ((a[1/0])); echo in); echo "after $?"; x=$(a=(1); ((a[1/0])); echo in); echo "sub $? [$x]"',
  // Writing a scalar's element counts back from its one value.
  't=5; ((t[-1]=7)); declare -p t',
  // $((…))'s text is expanded before it is evaluated.
  'a=(1 2 3); echo $(( ${#a[@]} - 1 )) $(( $(echo 2) * 3 )); j=1+1; echo $((2*$j)) $((2*j))',
  // A read-then-write whose read index is bad binds its subscript again after the right side.
  'a=(1); ((a[-2] += (a[1]=5))); declare -p a; t=5; ((t[-1]++)); declare -p t',
  // As in double quotes: a single quote is the expression's, an operand error; double quotes are removed.
  { line: 'i=0; echo $(( \'i++\' ))\necho "i=$i"; echo $(( "1" + 2 )); a=(5 6); ((x = a["1"])); echo "$x"', script: 'bash' },
  // A value's subscript is expanded too; a name in it is read.
  'a=(10 20); i=1; e=\'a[$i]\'; echo $((e)); f=\'a["1"]\'; echo $((f))',
  // An operand that is not one, and text left after the expression, are errors.
  { line: 'echo $(( 1 + @ ))\necho $(( 2 3 ))\nx="1 2"; echo $((x))\necho end', script: 'bash' },
  'echo $((1 +\n2 \n)) $(( 3\t*\t2 ))',
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, a script's `./s.sh: line 1: `, and in a function 5.2's `environment: line 1: `. */
const plainStderr = (text) => text.replace(/^(?:bash|environment|\.\/s\.sh): (?:-c: )?(?:line \d+: )?/gm, '');

const CASES = LINES.map((c) => (typeof c === 'string' ? { line: c, script: null } : c));

const want = [];
for (const { line, script } of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-arithmetic-arrays-'));
  try {
    if (script !== null) writeFileSync(join(dir, 's.sh'), `${line}\n`);
    const argv = script === null ? ['--norc', '--noprofile', '-c', line] : ['./s.sh'];
    const r = spawnSync('bash', argv, { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8', HOME: '/home/user' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
// `bash s.sh` runs the script as the session's bash does.
registerShellEntrypointCommands(ws.registry, { execute: (cmd, options) => ws.shell.execute(cmd, options) });
const failed = [];
try {
  for (const [i, { line, script }] of CASES.entries()) {
    const dir = `/home/user/case${i}`;
    await ws.exec(`mkdir -p ${dir}`, { cwd: '/home/user' });
    if (script !== null) await ws.fs.writeFile(`${dir}/s.sh`, `${line}\n`);
    const r = await ws.exec(script === null ? line : `${script} ./s.sh`, { cwd: dir });
    const ours = { stdout: r.stdout, stderr: r.stderr, status: r.exitCode };
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}

console.log(`shell-arithmetic-arrays-bash: ${CASES.length - failed.length} of ${CASES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
