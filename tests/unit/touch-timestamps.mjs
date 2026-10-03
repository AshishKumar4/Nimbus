#!/usr/bin/env bun
// touch sets atime and mtime the way GNU touch does: to now, to a -d date
// (including @<epoch>), a -t stamp or a -r reference file's; only atime with
// -a, only mtime with -m (or --time); -c creates nothing; a missing parent
// is an error, not a directory made. `touch -d "2020-01-01 00:00:00" f`
// used to exit 0 with mtime unchanged and a file named after the date.
//
// The oracle is GNU touch (coreutils 9.7, `gnutouch` here) under TZ=UTC and
// LC_ALL=C, over the same files on disk; seconds of atime and mtime, exit
// status and stderr are compared.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { testBox } from './lib/test-box.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const GNU_TOUCH = ['gnutouch', 'touch'].find((bin) => /GNU coreutils/.test(spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout ?? ''));
assert.ok(GNU_TOUCH, 'GNU touch is required as the oracle (gnutouch or touch from GNU coreutils)');
const ENV = { ...process.env, TZ: 'UTC', LC_ALL: 'C' };

const disk = mkdtempSync(join(tmpdir(), 'nimbus-touch-'));
process.on('exit', () => rmSync(disk, { recursive: true, force: true }));

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('tmp', { mode: 0o777 });
root.mkdir('tmp/w', { mode: 0o777 });
// The shell runs as the session user: it owns the files it touches.
root.chown('tmp', 1000, 1000);
root.chown('tmp/w', 1000, 1000);
const box = await testBox({ harness, vfs: rawVfs });

const OLD = 1_000_000_000;
/** `f` and `ref` in both places: f at OLD, ref at 2019-05-06 07:08:09. */
function reset() {
  for (const [name, seconds] of [['f', OLD], ['ref', 1557126489]]) {
    writeFileSync(join(disk, name), 'x\n');
    spawnSync(GNU_TOUCH, ['-d', `@${seconds}`, name], { cwd: disk, env: ENV });
    root.writeFile(`tmp/w/${name}`, 'x\n');
    root.chown(`tmp/w/${name}`, 1000, 1000);
    root.utimes(`tmp/w/${name}`, seconds * 1000, seconds * 1000);
  }
  for (const name of ['new', 'nofile']) {
    rmSync(join(disk, name), { force: true });
    if (root.exists(`tmp/w/${name}`)) root.unlink(`tmp/w/${name}`);
  }
}
const diskTimes = (name) => {
  if (!existsSync(join(disk, name))) return null;
  const st = statSync(join(disk, name));
  return [Math.floor(st.atimeMs / 1000), Math.floor(st.mtimeMs / 1000)];
};
const vfsTimes = (name) => {
  if (!root.exists(`tmp/w/${name}`)) return null;
  const st = root.stat(`tmp/w/${name}`);
  return [Math.floor(st.atime / 1000), Math.floor(st.mtime / 1000)];
};

let checks = 0;
/** GNU touch and ours run `args` (shell words) over the same files. `now`: compare to the clock instead. */
async function same(args, { files = ['f'], now = false, near = false, setup } = {}) {
  reset();
  setup?.();
  const shellArgs = args.map((a) => `'${a}'`).join(' ');
  const expected = spawnSync('sh', ['-c', `${GNU_TOUCH} ${shellArgs}`], { cwd: disk, env: ENV, encoding: 'utf8' });
  const actual = await box.shell.execute(`cd /tmp/w && touch ${shellArgs}`, {});
  const label = `touch ${args.join(' ')}`;
  assert.equal(actual.exitCode, expected.status, `${label}: exit (stderr ${JSON.stringify(actual.stderr)})`);
  assert.equal(actual.stderr, expected.stderr.replaceAll(GNU_TOUCH, 'touch'), `${label}: stderr`);
  for (const name of files) {
    const want = diskTimes(name);
    const got = vfsTimes(name);
    if (now && want) {
      const t = Math.floor(Date.now() / 1000);
      assert.ok(got && got.every((s, i) => want[i] === OLD ? s === OLD : Math.abs(s - t) <= 2), `${label}: ${name} ${JSON.stringify(got)} is now`);
    } else if (near && want && got) {
      // A date relative to now: the two runs are milliseconds apart, and may straddle a second.
      assert.ok(got.every((s, i) => Math.abs(s - want[i]) <= 2), `${label}: ${name} ${JSON.stringify(got)} near ${JSON.stringify(want)}`);
    } else {
      assert.deepEqual(got, want, `${label}: ${name} atime, mtime`);
    }
  }
  checks++;
}

try {
  await same(['-d', '2020-01-01 00:00:00', 'f']);
  await same(['-d', '2020-01-01', 'f']);
  await same(['-d', '2020-01-01T10:20:30', 'f']);
  await same(['-d', '2020-01-01 10:20:30Z', 'f']);
  await same(['-d', '2020-01-01 10:20:30 +0200', 'f']);
  await same(['-d', '2020-01-01 10:20:30.25', 'f']);
  await same(['-d', '@1600000000', 'f']);
  await same(['-d', '@1600000000.5', 'f']);
  await same(['--date=@1700000000', 'f']);
  await same(['--date', '@1700000000', 'f']);
  await same(['-t', '202001010000', 'f']);
  await same(['-t', '2001010000.30', 'f']);
  await same(['-t', '1901010000', 'f']);
  await same(['-r', 'ref', 'f']);
  await same(['--reference=ref', 'f']);
  await same(['-a', '-d', '@1500000000', 'f']);
  await same(['-m', '-d', '@1400000000', 'f']);
  await same(['-am', '-d', '@1400000000', 'f']);
  await same(['--time=atime', '-d', '@1300000000', 'f']);
  await same(['--time=mtime', '-t', '202001010000', 'f']);
  await same(['-d', '@1600000000', 'f', 'new'], { files: ['f', 'new'] });
  await same(['-c', 'nofile'], { files: ['nofile'] });
  await same(['--no-create', '-d', '@1600000000', 'f', 'nofile'], { files: ['f', 'nofile'] });
  await same(['f'], { now: true });
  await same(['-a', 'f'], { now: true });
  await same(['-m', 'f'], { now: true });
  await same(['new'], { files: ['new'], now: true });
  await same(['x/y'], { files: [] });
  await same(['-t', '2020010100000', 'f']);
  await same(['-d', 'garbage', 'f']);
  await same(['-r', 'nope', 'f']);
  await same([]);
  await same(['-Q', 'f']);
  await same(['--bogus', 'f']);
  await same(['-d'], { files: [] });
  // GNU's date grammar: relative items, textual and US dates, date(1)'s own output, and a
  // bare time; impossible dates and times are refused, as are `noon`, `midnight` and
  // `@epoch` with anything after it.
  for (const d of ['1 hour ago', 'yesterday', '2 days ago', '+1 day', 'tomorrow', '3 weeks ago', '1 month ago',
    'next monday', 'last friday', 'now', 'today', '10:30', '10:30pm', 'Jan 1']) {
    await same(['-d', d, 'f'], { near: true });
  }
  for (const d of ['20200101', 'Jan 1 2020', 'January 1, 2020 10:00', '1 Jan 2020', '1/2/2020',
    'Wed, 01 Jan 2020 10:00:00 +0000', 'Wed Jan  1 10:00:00 UTC 2020', '2020-01-01 +2 hours',
    '2020-01-01T10:00:00+02:00', '2020-02-29']) {
    await same(['-d', d, 'f']);
  }
  for (const d of ['noon', 'midnight', '2020-02-31', '2021-02-29', '2020-01-01 25:00', '13:00pm', '@1600000000 +1 day', '1 hour']) {
    await same(['-d', d, 'f']);
  }
  // gnulib's ranges and its signed fractions: an epoch before 1970, a zone past 24 hours, a second
  // past 59, a field or a time that overflows, and no date at all (midnight).
  for (const d of ['@-1.5', '@-1,5', '@ 5', '', '2020-01-01 12:00 +2400', '2020-01-01 12:00 +9999', '@99999999999999999999',
    '2020-01-01 23:59:60', '3000000000 years', '9223372036854775807 seconds']) {
    await same(['-d', d, 'f']);
  }
  await same(['-t', '202002310000', 'f']);
  await same(['-t', '202002290000', 'f']);
  // -h: a link is never followed, and nothing is created (-h implies -c).
  const link = (name, target) => () => {
    rmSync(join(disk, name), { force: true });
    symlinkSync(target, join(disk, name));
    if (root.exists(`tmp/w/${name}`) || (() => { try { root.lstat(`tmp/w/${name}`); return true; } catch { return false; } })()) root.unlink(`tmp/w/${name}`);
    root.symlink(target, `tmp/w/${name}`);
    root.chown(`tmp/w/${name}`, 1000, 1000, { followSymlinks: false });
  };
  await same(['-h', '-d', '@1600000000', 'lnk'], { files: ['f'], setup: link('lnk', 'f') });
  await same(['-h', 'dang'], { files: ['nofile'], setup: link('dang', 'nofile') });
  await same(['-d', '@1600000000', 'dang'], { files: ['nofile'], setup: link('dang', 'nofile') });
  await same(['-h', '-d', '@1600000000', 'f']);
  await same(['-'], { files: [] });
  // Files the caller does not own. uid 1000 cannot make root-owned files on disk for GNU to
  // touch, so these expectations are GNU touch 9.7's own output, measured as uid 1000 on
  // root-owned /etc/hostname (0644) and /dev/null (0666): the open's errno when the open
  // failed, else the time-setting errno; -c on a missing path is silence.
  const pinned = async (label, args, want) => {
    root.writeFile('tmp/w/rootf', 'r'); root.chown('tmp/w/rootf', 0, 0); root.chmod('tmp/w/rootf', 0o644);
    root.writeFile('tmp/w/rootw', 'w'); root.chown('tmp/w/rootw', 0, 0); root.chmod('tmp/w/rootw', 0o666);
    const actual = await box.shell.execute(`cd /tmp/w && touch ${args.map((a) => `'${a}'`).join(' ')}`, {});
    assert.deepEqual({ exit: actual.exitCode, stderr: actual.stderr }, want, label);
    checks++;
  };
  await pinned('an explicit time on a root file the caller cannot write', ['-d', '@1600000000', 'rootf'],
    { exit: 1, stderr: "touch: cannot touch 'rootf': Permission denied\n" });
  await pinned('a root file the caller cannot write', ['rootf'],
    { exit: 1, stderr: "touch: cannot touch 'rootf': Permission denied\n" });
  await pinned('an explicit time on a root file the caller may write but not own', ['-d', '@1600000000', 'rootw'],
    { exit: 1, stderr: "touch: setting times of 'rootw': Operation not permitted\n" });
  await pinned('-c: no open, so the time-setting error', ['-c', '-d', '@1600000000', 'rootf'],
    { exit: 1, stderr: "touch: setting times of 'rootf': Operation not permitted\n" });
  await pinned('-c on a missing path under a missing directory', ['-c', '-d', '@1', 'nope/x'], { exit: 0, stderr: '' });

  console.log(`touch-timestamps: ${checks} invocations match GNU touch`);
} finally {
  box.destroy();
}
