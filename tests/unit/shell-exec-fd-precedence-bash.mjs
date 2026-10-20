#!/usr/bin/env bun
// A redirection on a compound command or a function call, as bash 5.2 makes
// it: over the shell's descriptor table as it is, `exec`'s among it, for the
// command's run, then undone. Inside, `exec` changes the table, until the
// enclosing redirection is undone. A pipeline element's pipe, and a
// substitution's capture, are its own fd 1 over `exec`'s. A diagnostic the
// shell writes goes where its fd 2 is then. Before
// (ticket-lifo-exec-fd-precedence), `exec`'s descriptors overrode every
// enclosing redirection: `exec 2>outer; f 2>inner` wrote f's stderr to outer.
// Host bash is the oracle (stdout, status, stderr without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const show = 'for f in FILES; do printf "%s:" $f; tr "\\n" " " <$f; echo; done';
const LINES = [
  `exec 2>outer; f() { echo x >&2; }; f 2>inner; { echo y >&2; } 2>inner2; exec 2>&-; ${show.replace('FILES', 'outer inner inner2')}`,
  `exec 2>outer; g() { exec 2>new; echo z >&2; }; g 2>inner; echo after >&2; exec 2>&-; ${show.replace('FILES', 'outer new inner')}`,
  `exec 3>o3; f() { echo a >&3; }; f 3>i3; echo b >&3; { exec 3>n3; echo c >&3; } 3>i4; echo d >&3; exec 3>&-; ${show.replace('FILES', 'o3 i3 n3 i4')}`,
  'exec 4>&1; exec >file; echo a | tr a b >&4; echo direct; exec >&4 4>&-; cat file',
  'exec 2>e; x=$(echo s >&2; echo out); echo "[$x]"; exec 2>&-; cat e',
  `exec 2>outer; while true; do echo w >&2; break; done 2>inner; if true; then echo i >&2; fi 2>inner2; exec 2>&-; ${show.replace('FILES', 'outer inner inner2')}`,
  `exec 3>o; f() { exec 3>&-; }; f 3>i; echo after >&3; exec 3>&-; ${show.replace('FILES', 'o i')}`,
  'exec 2>outer; f() { echo $((08)); }; f 2>inner\nexec 2>&-; grep -c "value too great" inner outer',
  `exec 2>outer; ( echo sub >&2 ) 2>inner; echo plain >&2 2>inner2; exec 2>&-; ${show.replace('FILES', 'outer inner inner2')}`,
  `exec 2>outer; eval 'echo e >&2' 2>inner; printf 'echo s >&2\\n' > s.sh; . ./s.sh 2>inner2; exec 2>&-; ${show.replace('FILES', 'outer inner inner2')}`,
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, a script's `./s.sh: line 1: `, and in a function 5.2's `environment: line 1: `. */
const plainStderr = (text) => text.replace(/^(?:bash|environment|\.\/s\.sh): (?:-c: )?(?:line \d+: )?/gm, '');

const CASES = LINES.map((c) => (typeof c === 'string' ? { line: c, script: null } : c));

const want = [];
for (const { line, script } of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-exec-fd-precedence-'));
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

console.log(`shell-exec-fd-precedence-bash: ${CASES.length - failed.length} of ${CASES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
