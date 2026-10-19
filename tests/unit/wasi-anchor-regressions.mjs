#!/usr/bin/env bun
// Focused source-level reproductions of the stage-3 descriptor regressions.
import assert from 'node:assert/strict';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { session } from './lib/holder-session.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const failures = [];
const check = async (name, run) => {
  try { await run(); console.log(`ok ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}`, error); }
};
async function write(fs, path, text) {
  const fd = await fs.open(path, { write: true, create: true, truncate: true, mode: 0o644 });
  await fs.write(fd.id, null, enc.encode(text));
  await fs.close(fd.id);
}
async function hold(s, dir) {
  for (let i = 0; i < 16 && s.filesystem.delegations.size === 0; i++) await write(s.fs, `${dir}/.warm${i}`, 'w');
  assert.ok(s.filesystem.delegations.size > 0);
  await s.fs.flush();
  await s.fs.stat(dir);
}

await check('a read-only descriptor does not borrow a write-only anchor for reads', async () => {
  const s = session({ view: {} });
  const path = '/home/user/a.txt';
  await write(s.fs, path, 'anchor bytes');
  await s.fs.readdir('/home/user');
  const writer = s.fs.synchronous.open(path, { write: true });
  const reader = s.fs.synchronous.open(path, { read: true, create: true });
  await s.fs.flush();
  s.fs.inbound();
  await s.fs.stat(path);
  assert.equal(dec.decode(await s.fs.read(reader.id, 0, 64)), 'anchor bytes');
  await assert.rejects(async () => s.fs.read(writer.id, 0, 64), { code: 'EBADF' });
  await s.fs.close(reader.id);
  await s.fs.close(writer.id);
  await s.fs.settle();
});

for (const readable of [false, true]) for (const retained of [false, true]) await check(`a read-only open keeps its access after chmod and unlink (${retained ? 'retained' : 'live'} ${readable ? 'readable' : 'write-only'} anchor)`, async () => {
  const s = session({ view: {} });
  const path = '/home/user/access.txt';
  await write(s.fs, path, 'authorized bytes');
  await s.fs.readdir('/home/user');
  const writer = s.fs.synchronous.open(path, { read: readable, write: true });
  const reader = s.fs.synchronous.open(path, { read: true });
  await s.fs.flush();
  assert.equal(dec.decode(await s.fs.read(reader.id, 0, 64)), 'authorized bytes');
  if (retained) await s.fs.close(writer.id);
  await s.fs.chmod(path, 0o200);
  await s.fs.unlink(path);
  s.fs.inbound();
  await s.fs.stat('/home/user');
  assert.equal(dec.decode(await s.fs.read(reader.id, 0, 64)), 'authorized bytes');
  await s.fs.close(reader.id);
  if (!retained) await s.fs.close(writer.id);
  await s.fs.settle();
});

await check('an anchored descriptor and its held inode have one set of attributes', async () => {
  const s = session({ view: {} });
  const path = '/home/user/proj/d0/orphan.txt';
  await hold(s, '/home/user/proj/d0');
  await write(s.fs, path, 'O');
  const fd = await s.fs.open(path, { write: true });
  await s.fs.unlink(path);
  await write(s.fs, path, 'TAKEN');
  await withRecall(() => s.kernel.stat(path.slice(1)));
  await s.fs.fchmod(fd.id, 0o600);
  await s.fs.fchown(fd.id, 1000, 1000);
  await s.fs.futimes(fd.id, 5_000, 7_000);
  const own = await s.fs.fstat(fd.id);
  assert.deepEqual([own.mode & 0o7777, own.mtime], [0o600, 7_000]);
  await s.fs.close(fd.id);
  await s.fs.settle();
});

await check('a renamed lock file can be created exclusively at its old name again', async () => {
  const s = session({ view: {} });
  const path = '/home/user/proj/d0/config';
  await hold(s, '/home/user/proj/d0');
  for (let i = 0; i < 4; i++) {
    const fd = await s.fs.open(`${path}.lock`, { write: true, create: true, exclusive: true, mode: 0o666 });
    await s.fs.write(fd.id, 0, enc.encode(`config ${i}`));
    await s.fs.fchmod(fd.id, 0o644);
    await s.fs.close(fd.id);
    await s.fs.rename(`${path}.lock`, path);
    assert.equal(dec.decode(await s.fs.readFile(path)), `config ${i}`);
  }
  await s.fs.settle();
});

assert.deepEqual(failures, []);
