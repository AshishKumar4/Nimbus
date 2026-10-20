#!/usr/bin/env bun
// A command's operand is walked as POSIX walks a path (Kinu ask 54): each
// `..` after the name before it is looked up, through a symbolic link to
// where it points, and a trailing slash on a file is "Not a directory". The
// shell joined an operand to its directory and reduced it lexically before
// any lookup, so `cat missing/../f` read f, `cat f/` read the file, and
// `cat link/../x` read the x beside the link rather than beside its target.
// Checked against the host's GNU tools under bash, over the same tree:
//   f, x: files; d/f2: a file in a directory; t/x, t/sub/: the link's side;
//   link -> t/sub.
// Ordinary spellings (`d/../f`, `./f`, `d/./f2`) answer as before.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const SETUP = 'printf F > f; printf X > x; mkdir -p d t/sub; printf D > d/f2; printf T > t/x; ln -s t/sub link';
const CASES = [
  'cat ./missing/../f',
  'cat f/',
  'cat link/../x',
  'cat d/../f ./f d/./f2 link/../sub/../x',
  'head -c1 link/../x; echo; head -c1 missing/../f',
  'wc -c link/../x missing/../f f/',
  'grep -H . link/../x missing/../f',
  'stat -c %s link/../x; stat -c %n missing/../f f/',
  'ls -1 link/..; ls -1 missing/..; ls -1 f/',
  'test -e missing/../f; echo "e=$?"; test -f f/; echo "f=$?"; test -f link/../x; echo "x=$?"',
  'cp link/../x c1; cat c1; cp missing/../f c2; cp f/ c3',
  'mkdir missing/../m; mkdir link/../m2; ls -1 t',
  'touch missing/../n f/; touch link/../n2; ls -1 t',
  'chmod 600 missing/../f f/; chmod 600 link/../x; stat -c %a t/x',
  'rm missing/../f f/; rm link/../x; ls -1 t',
  'mv missing/../f g; mv link/../x g2; ls -1 t; cat g2',
  'cd missing/.. && echo in; cd link/.. && ls -1',
  'cat f/../x f/. f//; cat missing/./../f; cat link/../x',
  'ln -s f filelink; ln -s missing dangling; cat filelink/../x dangling/../x',
  'mkdir -p missing/../m; test -d missing; echo "missing=$?"; test -d m; echo "m=$?"',
  'mkdir -p link/../m; ls -1 t; mkdir -p f/../bad',
  'cp f link/../copied; cat t/copied; mv x link/../moved; cat t/moved',
  'sort link/../x missing/../f f/; uniq link/../x; sed -n p link/../x',
  'cat < link/../x; cat < missing/../f; printf A > link/../written; cat t/written',
  'before=$PWD; cd d/..; test "$PWD" = "$before"; echo "d=$?"; cd link/..; test "$PWD" = "$before"; echo "link=$?"; cd f/..',
  // A trailing slash on an entry being removed or renamed names the entry, not a link's target.
  'mkdir -p d2/in; ln -s d2 l2; rm -r l2/; echo "rm=$?"; ls -1 d2 l2',
  'mkdir -p d3; ln -s d3 l3; rmdir l3/; echo "rmdir=$?"; ls -1d d3 l3',
  'mkdir -p d4; ln -s d4 l4; mv l4/ m4; echo "mv=$?"; ls -1d d4 l4',
  // cp's into-itself check is by where the names lead; mktemp's name is where it made the file; cd needs no search of what .. cancels.
  'mkdir -p o/sub o/dd; ln -s o/sub l5; cp -r l5/../dd .; echo "cp=$?"; ls -1d dd',
  'mkdir -p o/sub; ln -s o/sub l6; t=$(mktemp -p l6/..); test -f "$t"; echo "made=$?"; ls o | grep -c tmp',
  'mkdir locked; chmod 000 locked; cd locked/.. && echo in; chmod 755 locked',
];

const run = (line) => `${SETUP}; ${line}; echo "status=$?"`;
const complaint = (stderr) => stderr.replaceAll(/^(?:bash: line \d+: |sh: )/gm, '');
const dir = mkdtempSync(join(tmpdir(), 'operand-walk-gnu-'));
const gnu = {};
try {
  for (const line of CASES) {
    const at = join(dir, String(CASES.indexOf(line)));
    spawnSync('mkdir', ['-p', at]);
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', run(line)], { cwd: at, encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' } });
    gnu[line] = { stdout: r.stdout, stderr: complaint(r.stderr) };
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const line of CASES) {
    const at = `/home/user/${CASES.indexOf(line)}`;
    await ws.exec(`mkdir -p ${at}`);
    const r = await ws.exec(run(line), { cwd: at });
    const ours = { stdout: r.stdout, stderr: complaint(r.stderr) };
    try {
      assert.deepEqual(ours, gnu[line]);
      console.log(`  ✓ ${line.slice(0, 80)}`);
    } catch {
      failed.push(`${line}\n  gnu:  ${JSON.stringify(gnu[line])}\n  ours: ${JSON.stringify(ours)}`);
      console.log(`  ✗ ${line.slice(0, 80)}`);
    }
  }
} finally {
  await ws.close();
}
assert.deepEqual(failed, [], `as GNU:\n${failed.join('\n')}`);
console.log('operand-walk-gnu: ok');
