#!/usr/bin/env bun
// Double-quoted text where bash reads it, read by its rules: a here-document's
// body (parameters, $( ) and backquoted substitutions expanded; a backslash
// quotes only $, `, itself and a line's end; " and ' are text), and a "…"
// inside a ${…} operand (its \$, \`, \", \\ escapes and substitutions,
// backquoted too). Inside double quotes an operand's plain text is quoted:
// "${x:-~}" is ~. Before (ticket-lifo-backquotes-in-subscripts, its open
// half), a here-document's \$HOME expanded HOME after a kept backslash, a
// backquote in one stayed text, and "${x:-"`cmd`"}" gave the backquotes.
// Host bash is the oracle (stdout, status, stderr without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const LINES = [
  'unset x; echo "${x:-~}" ${x:-~} "${x:-"~"}"',
  'unset x; H=h; cat <<EOF\n${x:-"a b"} ${x:-\'s\'} "q" \\" \\$H \\` \\\\ \\x `echo bq` $(echo "x y") $H\nEOF',
  'unset x; echo "${x:-"a\\$b"}" "${x:-"`echo hi`"}" "${x:-"\\`no\\`"}" "${x:-"a\\"b"}"',
  'unset x; echo ${x:-"a\\$b"} ${x:-"`echo hi`"} ${x:-"\\`no\\`"}',
  'unset x; y="p  q"; echo "${x:-"$y"}" ${x:-"$y"} ${x:-$y}',
  'cat <<EOF\n~ ~/a\nEOF',
  'unset x; echo "${x:-""}|" "${x:-"a""b"}"',
  'cat <<EOF\nline one \\\njoined\nEOF',
  'v=val; cat <<"EOF"\n$v `x` \\$v\nEOF',
  'cat <<EOF\n`echo "x y"` "q" \'s\'\nEOF',
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, a script's `./s.sh: line 1: `, and in a function 5.2's `environment: line 1: `. */
const plainStderr = (text) => text.replace(/^(?:bash|environment|\.\/s\.sh): (?:-c: )?(?:line \d+: )?/gm, '');

const CASES = LINES.map((c) => (typeof c === 'string' ? { line: c, script: null } : c));

const want = [];
for (const { line, script } of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-heredoc-quoting-'));
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

console.log(`shell-heredoc-quoting-bash: ${CASES.length - failed.length} of ${CASES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
