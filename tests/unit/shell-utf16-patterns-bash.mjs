#!/usr/bin/env bun
// Patterns, trims, substitutions, lengths and IFS count characters, as bash
// does in a UTF-8 locale, not UTF-16 units: `?` matches 😀 whole, `${x%?}`
// of 😀 leaves nothing (not a lone surrogate), `${#x}` is 1, and IFS=😀 joins
// by 😀 and never splits 😁, whose first unit is 😀's. Each line runs as a
// session's line and as host bash's `bash -c` under C.UTF-8, in a directory
// holding `ab` and `a😀`. Host bash is the oracle (stdout, status, stderr
// without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const CASES = [
  `x=😀; printf '<%s>' "\${x%?}" "\${x#?}" "\${x%%?}" "\${x##?}" "\${x/%?/}" "\${x/#?/}" "\${x:0:1}" "\${#x}"; echo`,
  `x=😀😀a; printf '<%s>' "\${x/?/X}" "\${x//?/X}" "\${x#??}" "\${x%??}" "\${x^^}" "\${x^}" "\${#x}"; echo`,
  `x='é😀'; printf '<%s>' "\${x:1}" "\${x: -1}" "\${x/[😀]/Y}" "\${x//[!é]/Z}" "\${x%[😀]}"; echo`,
  `IFS=😀; set -- a b; echo "$*"; printf '<%s>' "\${*}"; echo`,
  `x=a😁b; IFS=😀; set -- $x; echo $#; x=a😀b; set -- $x; echo $# "$1" "$2"`,
  `case 😀 in ?) echo one;; *) echo many;; esac; [[ 😀 == ? ]] && echo one; [[ 😀😀 == ?? ]] && echo two`,
  `case é in [é]) echo m;; *) echo n;; esac; case 😁 in [😀-😂]) echo range;; *) echo none;; esac`,
  `printf '<%s>' a?; echo`,
  `a=(😀 b); printf '<%s>' "\${a[0]:0:1}" "\${#a[0]}" "\${a[@]%?}"; echo`,
];

const FILES = ['ab', 'a😀'];
/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `. */
const plainStderr = (text) => text.replace(/^bash: (?:-c: )?(?:line \d+: )?/gm, '');

const want = [];
for (const line of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-utf16-'));
  try {
    for (const file of FILES) writeFileSync(join(dir, file), '');
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', line], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const [i, line] of CASES.entries()) {
    const dir = `/home/user/u${i}`;
    await ws.exec(`mkdir -p ${dir}`, { cwd: '/home/user' });
    for (const file of FILES) await ws.fs.writeFile(`${dir}/${file}`, '');
    const r = await ws.exec(line, { cwd: dir });
    const ours = { stdout: r.stdout, stderr: r.stderr, status: r.exitCode };
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}
console.log(`shell-utf16-patterns-bash: ${CASES.length - failed.length} of ${CASES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
