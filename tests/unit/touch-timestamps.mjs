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
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
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
const box = await Sandbox.create({ persist: false });
box.kernel.vfs.mount('/tmp', new SqliteVFSProvider(rawVfs, 'tmp'));
registerUnixCommands(box.commands.registry, rawVfs);

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
async function same(args, { files = ['f'], now = false } = {}) {
  reset();
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
  console.log(`touch-timestamps: ${checks} invocations match GNU touch`);
} finally {
  box.destroy();
}
