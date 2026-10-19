#!/usr/bin/env bun
// The shell reads a text a line at a time, as bash's reader does, and
// expands an alias as it reads: a line is read whole before any of it runs
// (a syntax error in it runs none of it, one in a later line leaves the
// earlier ones run); an alias defined on a line is expanded only from the
// next; an alias's text is read in place of its word, before reserved
// words, so it may open what the line closes (`begin echo in; fi`) and a
// comment in it takes the rest of the line; a function keeps the aliases it
// was read with. Before, the whole text was parsed first and an alias was
// expanded when its command ran. Each line runs as a session's line and as
// host bash's `bash -O expand_aliases -c`. Host bash is the oracle (stdout,
// status, and stderr without bash's line prefix; a syntax error's stdout
// and status alone, bash's second line quoting the line being its own).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const CASES = [
  { line: "alias p='printf \"<%s>\\n\" kept #'\np ignored; echo after\necho next", compare: "all" },
  { line: "alias begin='if true; then'\nbegin echo in; fi", compare: "all" },
  { line: "alias p=echo; p same\np next", compare: "all" },
  { line: "alias if=echo\nif true; then echo t; fi\necho never", compare: "out" },
  { line: "echo first\nif then\necho never", compare: "out" },
  { line: "echo ok; if then\necho never", compare: "out" },
  { line: "alias x='echo a '\nalias y='b'\nx y", compare: "all" },
  { line: "alias c='{ :; }'\nx=1 c\necho \"x=[$x]\"", compare: "out" },
  { line: "alias p=echo\nf() { p fn; }\nunalias p\nf", compare: "all" },
  { line: "alias q='echo q;'\nq echo r", compare: "all" },
  { line: "alias s=s\ns; echo \"st=$?\"", compare: "all" },
  { line: "alias a=b\nalias b='echo B'\na hi", compare: "all" },
  { line: "alias e=''\ne echo x", compare: "all" },
  { line: "alias p='echo a # c'\np b; echo c\necho d", compare: "all" },
  { line: "alias p='printf hi #'\n>/dev/null p ignored\necho after", compare: "all" },
  { line: "alias n='echo n'\nx=$(n)\necho \"$x\"; eval 'alias m=\"echo m\"\nm'", compare: "all" },
  { line: "cat <<EOF; echo after\nbody\nEOF\necho next", compare: "all" },
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `. */
const plainStderr = (text) => text.replace(/^bash: (?:-c: )?(?:line \d+: )?/gm, '');
const compared = (result, compare) => (compare === 'out' ? { stdout: result.stdout, status: result.status } : result);

const want = [];
for (const { line, compare } of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-alias-read-'));
  try {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-O', 'expand_aliases', '-c', line], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push(compared({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status }, compare));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const failed = [];
for (const [i, { line, compare }] of CASES.entries()) {
  // Each line in a session of its own: no alias of one is another's.
  const { sql, transactions } = await hostSqlite();
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
  try {
    const r = await ws.exec(line, { cwd: '/home/user' });
    const ours = compared({ stdout: r.stdout, stderr: r.stderr, status: r.exitCode }, compare);
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  } finally {
    await ws.close();
  }
}
console.log(`shell-alias-read-bash: ${CASES.length - failed.length} of ${CASES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
