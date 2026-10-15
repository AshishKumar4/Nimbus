#!/usr/bin/env bun
// stat's identity directives are the file's own (ProcessStat): %i its inode,
// %h its link count, %d and %D its device (decimal, hex), as GNU stat prints
// them. So %i is the same for f and ./f, stays with the file across mv, and
// differs between two files.
//
// Red before: %i hashed the path as written, %h was 1 and the device 0.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const view = ws.filesystem.view({ pid: 4242, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
const run = async (line) => {
  const r = await ws.exec(line, { cwd: '/home/user' });
  assert.equal(r.exitCode, 0, `${line}: ${r.stderr}`);
  return r.stdout.trim();
};
try {
  await run('echo x > f; echo y > other; mkdir d');
  const before = await run("stat -c '%i' f");
  const [same, dotted, other] = (await run("stat -c '%i' f ./f other")).split('\n');
  await run('mv f g');
  const after = await run("stat -c '%i' g");
  assert.deepEqual([same, dotted, after], [before, before, before], '%i is the file\'s: f and ./f agree, and it moves with the file');
  assert.notEqual(other, before, 'another file has another inode');
  console.log('  ✓ %i is the file\'s inode: the same however it is named, across mv, and its own');

  for (const name of ['g', 'd']) {
    const st = await view.stat(`/home/user/${name}`);
    assert.equal(await run(`stat -c '%i %h %d %D' ${name}`), `${st.ino} ${st.nlink} ${st.dev} ${st.dev.toString(16)}`, `${name}: inode, links and device are stat's`);
  }
  console.log('  ✓ %i, %h, %d and %D are the inode, link count and device stat reports');
} finally {
  await ws.close();
}
console.log('shell-stat-identity: ok');
