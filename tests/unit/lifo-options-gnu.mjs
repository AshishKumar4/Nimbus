#!/usr/bin/env bun
// cat, tee, head, cut, cksum, md5sum, sum and grep read their options as GNU
// getopt_long does, checked against the host's GNU tools under bash: a long
// option may be any unambiguous prefix of its name (`--numb`, `--lin=1`), an
// ambiguous one names its possibilities, an option given an argument it does
// not take or missing one it needs is refused with getopt's words, and each
// command's own forms (head -N, grep -NUM) keep working. grep's -A and -B
// win over -C and -NUM, whichever comes first.
//
// Red before: each of these commands scanned its own options: exact long
// names only (cat, head, cut, cksum, tee), and messages of their own.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const FILES = { f: 'one\ttwo,three\n\nfour,five\n', g: 'alpha\nbeta\ngamma\n' };
const CASES = [
  // cat
  'cat --numb f', 'cat --number-n f', 'cat --num f', 'cat --show-e f', 'cat --number=1 f', 'cat -X f', 'cat --bogus f', 'cat -vET f',
  // tee
  'echo x | tee --app o >/dev/null; cat o', 'echo x | tee --bogus', 'echo x | tee -X', 'echo x | tee --ignore-i o; cat o',
  // head
  'head --lin=1 g', 'head --line 2 g', 'head --verb g', 'head -n', 'head --lines', 'head -X g', 'head -2 g', 'head --quiet=1 g', 'head --by=3 g',
  // cut
  'cut --fie=1 -d, f', 'cut --del=, -f2 f', 'cut -f', 'cut --compl -c1 g', 'cut -X f', 'cut --fields', 'cut --only -d, -f1 f',
  // cksum, md5sum, sum
  'cksum --alg=crc32b g', 'cksum --unt -a md5 g', 'cksum -a', 'cksum --algorithm', 'md5sum --ta g', 'md5sum -X g', 'sum -r g', 'sum -X g', 'sum --sysv g',
  // grep
  'grep --ign ALPHA g', 'grep --co a g', 'grep -e', 'grep --regexp', 'grep -1 beta g', 'grep --max=1 a g', 'grep --cou a g',
  'grep -10 beta g', 'grep -1 -0 beta g', 'grep -1n beta g', 'grep -A 0 -1 beta g', 'grep -1 -A 0 beta g', 'grep -C 0 -B 1 gamma g',
  'grep --fixed a g', 'grep --col=never a g',
];

const run = (line) => `${line}; echo "status=$?"`;
const dir = mkdtempSync(join(tmpdir(), 'lifo-options-'));
const gnu = {};
try {
  for (const [name, text] of Object.entries(FILES)) writeFileSync(join(dir, name), text);
  for (const line of CASES) {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', run(line)], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' } });
    gnu[line] = { stdout: r.stdout, stderr: r.stderr };
    rmSync(join(dir, 'o'), { force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const [name, text] of Object.entries(FILES)) await ws.fs.writeFile(`/home/user/${name}`, text);
  for (const line of CASES) {
    const r = await ws.exec(run(line), { cwd: '/home/user' });
    await ws.exec('rm -f o', { cwd: '/home/user' });
    const ours = { stdout: r.stdout, stderr: r.stderr };
    try {
      assert.deepEqual(ours, gnu[line]);
    } catch {
      failed.push(`${line}\n  gnu:  ${JSON.stringify(gnu[line])}\n  ours: ${JSON.stringify(ours)}`);
    }
  }
} finally {
  await ws.close();
}
console.log(`  ${CASES.length - failed.length} of ${CASES.length} as GNU`);
assert.deepEqual(failed, [], `as GNU:\n${failed.join('\n')}`);
console.log('lifo-options-gnu: ok');
