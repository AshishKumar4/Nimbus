#!/usr/bin/env bun
// stat and grep keep GNU's contracts, checked against the host's GNU tools
// under bash:
//
//   - stat says each operand it cannot stat with its own error (No such
//     file or directory, Permission denied, Too many levels of symbolic
//     links), stats the rest, and ends with status 1;
//     -f says one whose file system it cannot read; %n names the operand as
//     it was given; a link is reported itself, and what it names with -L;
//   - grep --exclude-from=FILE excludes the globs FILE's lines name (their
//     trailing blanks gone, blank lines none), on the command line and in a
//     recursion; FILE '-' is stdin, which GNU's grep reads for a recursion
//     and finds at its end for the command line; one it cannot read ends it
//     with 2. -f and --exclude-from files are read in command-line order
//     (stdin taken by the first; the first unreadable one said); a line's
//     trailing blanks are C's isspace bytes, a no-break space kept.
//
// Red before: stat stopped at the first operand it could not stat, called
// every failure "No such file or directory", named operands by their
// absolute path and followed every link; grep refused --exclude-from as an
// invalid option.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const FILES = { f: 'one\ntwo\n', g: 'alpha\nbeta\ngamma\n', n: 'needle\n', 'ex-nbsp': 'g\u00a0\n', 'tree/a.log': 'a log\n', 'tree/b.txt': 'a text\n', 'tree/sub/c.txt': 'a sub\n' };
const CASES = [
  // stat
  'stat -c %n f nope g',
  'stat -c "%n %s" g f',
  'ln -s loop loop; stat -c "%n %F" loop f; stat -L -c %n loop f; rm -f loop',
  'ln -s g lg; stat -c "%n %F %s" lg; stat -L -c "%n %F %s" lg; rm -f lg',
  'mkdir -p d && chmod 000 d && stat -c %n d/x f; chmod 755 d; rmdir d',
  'stat -c %N f',
  'stat -f -c ok f nope g',
  'stat nope',
  // grep
  'printf "*.log\\n  \\nsub*  \\n" > ex; grep -r --exclude-from=ex a tree | sort; rm -f ex',
  'printf "g\\n" | grep --exclude-from=- -H a f g',
  'printf "*.log\\n" | grep -r --exclude-from=- a tree | sort',
  'printf "*.txt\\n" > ex; grep -r --exclude-from=ex --exclude=*.log a tree | sort; rm -f ex',
  'grep --exclude-from=nope a g',
  // Pattern and exclusion files are read in command-line order: the first takes stdin.
  'printf "needle\\n" | grep --exclude-from=- -f - n',
  'printf "needle\\n" | grep -f - --exclude-from=- -H needle n',
  'grep -f nope --exclude-from=nope2 a g; grep --exclude-from=nope2 -f nope a g',
  // Only the byte blanks C's isspace names are trimmed: a no-break space stays in the glob.
  'grep --exclude-from=ex-nbsp -c a g',
  'printf "g\\n" > ex; grep --exclude-f=ex -c a g f; rm -f ex',
];

const run = (line) => `${line}; echo "status=$?"`;
const dir = mkdtempSync(join(tmpdir(), 'shell-parity-'));
const gnu = {};
try {
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  for (const line of CASES) {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', run(line)], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' } });
    gnu[line] = { stdout: r.stdout, stderr: r.stderr };
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const [name, text] of Object.entries(FILES)) {
    await ws.fs.mkdir(`/home/user/${name}/..`, { recursive: true });
    await ws.fs.writeFile(`/home/user/${name}`, text);
  }
  for (const line of CASES) {
    const r = await ws.exec(run(line), { cwd: '/home/user' });
    const ours = { stdout: r.stdout, stderr: r.stderr };
    try {
      assert.deepEqual(ours, gnu[line]);
      console.log(`  ✓ ${line}`);
    } catch {
      failed.push(`${line}\n  gnu:  ${JSON.stringify(gnu[line])}\n  ours: ${JSON.stringify(ours)}`);
      console.log(`  ✗ ${line}`);
    }
  }
} finally {
  await ws.close();
}
assert.deepEqual(failed, [], `as GNU:\n${failed.join('\n')}`);
console.log('shell-parity-gnu: ok');
