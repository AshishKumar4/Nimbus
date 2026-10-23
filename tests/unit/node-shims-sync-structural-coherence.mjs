#!/usr/bin/env bun
// A synchronous structural mutation — mkdirSync, rmdirSync, unlinkSync,
// renameSync — has no channel to the authority: a sync syscall cannot make
// an RPC. So node-tar's per-entry sequence, `mkdirSync(dir)` then
// `fs.promises.open(dir + '/file', 'w')`, asked the authority to open a file
// under a directory it had never heard of, and was answered ENOENT. That is
// create-astro's template copy.
//
// The process's structural decisions reach the session in program order: each
// mkdir, rename, unlink and write is a record in a wave, ordered behind every
// earlier change of the path's ancestors, and every async entry point that
// reaches the session waits for those first. This pins that ORDER as the
// session receives it (the wave records), and the outcomes the process sees.

import assert from 'node:assert/strict';
import { decodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createAuthority, sleep } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const home = '/home/user';

// Every change the session receives, in the order it receives it.
const received = [];
const seen = (op, path, extra = {}) => received.push({ op, path, ...extra });

// While `writeGate` is set, each wave waits before reaching the session.
let writeGate = null;

const authority = createAuthority();
authority.kfs.mkdir(home, { recursive: true });
// Case 9's source with a file and an empty destination, both listed.
authority.kfs.mkdir(`${home}/listed_src`);
authority.kfs.writeFile(`${home}/listed_src/f.txt`, 'old source');
authority.kfs.mkdir(`${home}/listed_dest`);
authority.kfs.mkdir(`${home}/later_src`);
authority.kfs.mkdir(`${home}/later_dest`);
// Case 8's existing log files, which the process lists but never holds.
for (const name of ['logs_parked', 'logs_in_flight']) {
  authority.kfs.mkdir(`${home}/${name}`);
  authority.kfs.writeFile(`${home}/${name}/app.log`, 'prefix\n');
}

const { fs } = shimsOnSession({
  authority,
  cwd: home,
  overrides: (forward) => ({
    writeBatchStream: async (stream, fence, owner) => {
      const [read, sent] = stream.tee();
      const decoded = await decodeWriteBatchStream(read);
      const reading = (async () => {
        for await (const record of decoded.records) {
          if (record.type === 'call') seen(record.call.call, `/${record.call.path}`);
          else if (record.type === 'rename') seen('rename', `/${record.from}`, { to: `/${record.to}` });
          else if (record.type === 'delete') seen('unlink', `/${record.path}`);
          else if (record.type === 'directory') seen('mkdir', `/${record.inode.path}`);
          else if (record.type === 'file-end') seen('file', `/${record.path}`);
        }
      })();
      if (writeGate !== null) await writeGate.promise;
      const answer = await forward('writeBatchStream', [sent, fence, owner]);
      await reading;
      return answer;
    },
  }),
});
const drain = () => globalThis.__nimbusProcessFs.flush();
const indexOf = (op, path) => received.findIndex((c) => c.op === op && c.path === path);
const at = (p) => (authority.kfs.exists(p) ? authority.kfs.readFileString(p) : null);
const kindAt = (p) => (authority.kfs.exists(p) ? authority.kfs.stat(p).type : null);
const rejectsWith = async (promise, code) => {
  let got = null;
  try { await promise; } catch (error) { got = error.code; }
  assert.equal(got, code, `expected ${code}, got ${got}`);
};

// 1. mkdirSync then fs.promises.open under it, the node-tar sequence.
{
  fs.mkdirSync(`${home}/d`, { recursive: true });
  const handle = await fs.promises.open(`${home}/d/f`, 'w');
  await handle.write('hello');
  await handle.close();
  await drain();
  const mkdirAt = indexOf('mkdir', `${home}/d`);
  const firstTouch = received.findIndex((c) => c.path === `${home}/d/f`);
  assert.ok(mkdirAt >= 0, 'the authority received the mkdir');
  assert.ok(firstTouch > mkdirAt, `mkdir(d) at ${mkdirAt} must precede the first touch of d/f at ${firstTouch}`);
  assert.equal(at(`${home}/d/f`), 'hello', 'the file content reached the authority');
}

// 2. Nested mkdirSync lands parent before child at the authority.
{
  fs.mkdirSync(`${home}/a`);
  fs.mkdirSync(`${home}/a/b`);
  await fs.promises.access(`${home}/a/b`);
  await drain();
  const parent = indexOf('mkdir', `${home}/a`);
  const child = indexOf('mkdir', `${home}/a/b`);
  assert.ok(parent >= 0 && child >= 0, 'both directories reached the authority');
  assert.ok(parent < child, `mkdir(a) at ${parent} must precede mkdir(a/b) at ${child}`);
  assert.equal(kindAt(`${home}/a/b`), 'directory');
}

// 3. mkdirSync then an async readdir of it answers [] rather than ENOENT.
{
  fs.mkdirSync(`${home}/x`);
  assert.deepEqual(await fs.promises.readdir(`${home}/x`), []);
}

// 4. writeFileSync then unlinkSync: the authority never ends with the file.
// Once for a file that only ever existed as a pending write, and once for a
// file the authority already held — the unlink must reach it.
{
  fs.writeFileSync(`${home}/g`, '1');
  fs.unlinkSync(`${home}/g`);
  await rejectsWith(fs.promises.access(`${home}/g`), 'ENOENT');
  assert.equal(at(`${home}/g`), null, 'the authority does not hold g');
  await sleep(50);
  assert.equal(at(`${home}/g`), null, 'and no later write-back resurrects it');

  authority.kfs.writeFile(`${home}/h`, 'held');
  fs.unlinkSync(`${home}/h`);
  await rejectsWith(fs.promises.access(`${home}/h`), 'ENOENT');
  assert.equal(at(`${home}/h`), null, 'a sync unlink of an authority-held file lands');
  await drain();
  assert.ok(indexOf('unlink', `${home}/h`) >= 0, 'the authority received the unlink');
}

// 5. mkdirSync then renameSync of the directory: the new name is a directory.
{
  fs.mkdirSync(`${home}/r`);
  fs.renameSync(`${home}/r`, `${home}/s`);
  assert.ok((await fs.promises.stat(`${home}/s`)).isDirectory(), 's is a directory at the authority');
  await rejectsWith(fs.promises.stat(`${home}/r`), 'ENOENT');
}

// 7. Files written synchronously into a directory that is then renamed move
// with it, as Vite's optimizer does: it writes deps_temp_<hash>/ and renames
// it to deps/. They are written back under the old name ahead of the move, which carries them.
for (const rename of [
  (from, to) => fs.renameSync(from, to),
  (from, to) => fs.promises.rename(from, to),
]) {
  const from = `${home}/deps_temp_${received.length}`;
  const to = `${home}/deps_${received.length}`;
  fs.mkdirSync(`${from}/chunks`, { recursive: true });
  fs.writeFileSync(`${from}/package.json`, '{"type":"module"}');
  fs.writeFileSync(`${from}/chunks/react.js`, 'export default 1;');
  await rename(from, to);
  assert.equal(fs.readFileSync(`${to}/package.json`, 'utf8'), '{"type":"module"}', 'the moved file reads back under its new name at once');
  assert.equal(fs.statSync(`${to}/chunks/react.js`).size, 'export default 1;'.length, 'and stats at its size');
  assert.equal(fs.existsSync(`${from}/package.json`), false, 'the file is gone under the old name');
  assert.throws(() => fs.readFileSync(`${from}/package.json`), { code: 'ENOENT' }, 'and does not read there');
  assert.equal(await fs.promises.readFile(`${to}/package.json`, 'utf8'), '{"type":"module"}', 'it reads back from the authority');
  await drain();
  assert.throws(() => fs.readFileSync(`${from}/package.json`), { code: 'ENOENT' }, 'the old name stays gone once its write lands');
  assert.equal(at(`${to}/package.json`), '{"type":"module"}', 'the authority holds the file under the new name');
  assert.equal(at(`${to}/chunks/react.js`), 'export default 1;', 'and the nested one');
  assert.equal(at(from), null, 'the old name is gone at the authority');
}

// 8. An append to a file inside a renamed directory stays an append. The
// process never held the file, so its cell is only the appended bytes:
// moved as a whole write, it replaced the file with them. Once with the
// append pending, and once with its write-back already in flight when the
// directory moves.
for (const inFlight of [false, true]) {
  const from = `${home}/${inFlight ? 'logs_in_flight' : 'logs_parked'}`;
  const to = `${from}_moved`;
  fs.appendFileSync(`${from}/app.log`, 'first\n');
  if (inFlight) {
    writeGate = Promise.withResolvers();
    const issued = received.length;
    // The debounced write-back issues the append, which the gate holds.
    for (let i = 0; i < 50 && !received.slice(issued).some((c) => c.path === `${from}/app.log`); i++) await sleep(5);
    fs.appendFileSync(`${from}/app.log`, 'second\n');
  }
  fs.renameSync(from, to);
  if (writeGate !== null) { writeGate.resolve(); writeGate = null; }
  await drain();
  const expected = inFlight ? 'prefix\nfirst\nsecond\n' : 'prefix\nfirst\n';
  assert.equal(at(`${to}/app.log`), expected, `the authority keeps the prefix and every append (in flight: ${inFlight})`);
  assert.equal(at(from), null, 'the old name is gone at the authority');
}

// 9. A rename rename(2) refuses changes nothing, and the writes pending
// beneath its source land under the source: a directory renamed to itself,
// into its own subtree, or onto a directory that is not empty, whether this
// process lists the destination or only the authority does.
{
  const dir = `${home}/refused_${received.length}`;
  const pending = (name) => { fs.mkdirSync(`${dir}/${name}`, { recursive: true }); fs.writeFileSync(`${dir}/${name}/f.txt`, name); };
  pending('self');
  fs.renameSync(`${dir}/self`, `${dir}/self`);
  assert.throws(() => fs.renameSync(`${dir}/absent`, `${dir}/absent`), { code: 'ENOENT' }, 'a missing name renamed to itself is ENOENT');
  pending('sub');
  assert.throws(() => fs.renameSync(`${dir}/sub`, `${dir}/sub/inner`), { code: 'EINVAL' }, 'into its own subtree is EINVAL');
  fs.mkdirSync(`${dir}/full`);
  fs.writeFileSync(`${dir}/full/keep.txt`, 'keep');
  pending('known');
  assert.throws(() => fs.renameSync(`${dir}/known`, `${dir}/full`), { code: 'ENOTEMPTY' }, 'onto a listed non-empty directory is ENOTEMPTY');
  await drain();
  // A destination only the authority holds: the authority refuses the move.
  authority.kfs.mkdir(`${dir}/theirs`);
  authority.kfs.writeFile(`${dir}/theirs/keep.txt`, 'theirs');
  pending('unknown');
  await rejectsWith(fs.promises.rename(`${dir}/unknown`, `${dir}/theirs`), 'ENOTEMPTY');
  await drain();
  // A destination listed empty that only the authority has filled since:
  // the move it refuses leaves nothing of the source's under its name.
  authority.kfs.writeFile(`${home}/listed_dest/f.txt`, 'theirs');
  // Bytes, which a resident store holds as a copy of the pending cell.
  fs.writeFileSync(`${home}/listed_src/f.txt`, 'new pending source');
  await rejectsWith(fs.promises.rename(`${home}/listed_src`, `${home}/listed_dest`), 'ENOTEMPTY');
  await drain();
  assert.equal(at(`${home}/listed_dest/f.txt`), 'theirs', 'the destination keeps its file');
  assert.equal(at(`${home}/listed_src/f.txt`), 'new pending source', 'the source gets its pending write');
  let destRead;
  try { destRead = fs.readFileSync(`${home}/listed_dest/f.txt`, 'utf8'); } catch (error) { destRead = error.code; }
  assert.notEqual(destRead, 'new pending source', 'the sync view does not show the source under the destination');
  // A write to the moved name while the refused move is in flight is its
  // own: the refusal leaves its bytes and its record alone.
  authority.kfs.writeFile(`${home}/later_dest/f.txt`, 'theirs');
  fs.writeFileSync(`${home}/later_src/f.txt`, 'source');
  writeGate = Promise.withResolvers();
  const refusedLater = fs.promises.rename(`${home}/later_src`, `${home}/later_dest`).then(() => 'moved', (error) => error.code);
  fs.writeFileSync(`${home}/later_dest/f.txt`, 'later');
  writeGate.resolve();
  writeGate = null;
  assert.equal(await refusedLater, 'ENOTEMPTY');
  assert.equal(fs.readFileSync(`${home}/later_dest/f.txt`, 'utf8'), 'later', 'the later write reads back while it is held');
  assert.equal(fs.statSync(`${home}/later_dest/f.txt`).size, 'later'.length, 'and stats');
  await drain();
  assert.equal(at(`${home}/later_dest/f.txt`), 'later', 'and lands');
  for (const name of ['self', 'sub', 'known', 'unknown']) {
    assert.equal(at(`${dir}/${name}/f.txt`), name, `a refused rename's source keeps its pending write (${name})`);
  }
  assert.equal(at(`${dir}/sub/inner`), null, 'nothing was moved into the subtree');
  assert.equal(at(`${dir}/full/f.txt`), null, 'nothing was written into the listed destination');
  assert.equal(at(`${dir}/full/keep.txt`), 'keep', 'which keeps its own file');
  assert.equal(at(`${dir}/theirs/f.txt`), null, 'nothing was written into the authority\'s destination');
  assert.equal(at(`${dir}/theirs/keep.txt`), 'theirs', 'which keeps its own file');
}

// 10. An asynchronous write still in progress when its directory is renamed
// resolves only once the bytes are at the authority, under the new name once
// the move lands.
{
  const from = `${home}/inflight_${received.length}`;
  const to = `${from}_moved`;
  fs.mkdirSync(from);
  const writing = fs.promises.writeFile(`${from}/f.txt`, 'streamed in');
  fs.renameSync(from, to);
  await writing;
  assert.equal(at(`${from}/f.txt`) ?? at(`${to}/f.txt`), 'streamed in', 'the awaited write is at the authority');
  await drain();
  assert.equal(at(`${to}/f.txt`), 'streamed in', 'and moves with the directory');
  assert.equal(fs.statSync(`${to}/f.txt`).size, 'streamed in'.length, 'the sync view stats it at its size');
}

// 6. A program that only mkdirSync's and returns: the exit drain lands it.
{
  fs.mkdirSync(`${home}/only`);
  await drain();
  assert.equal(kindAt(`${home}/only`), 'directory', 'the exit drain carried the directory across');
}

console.log('node-shims-sync-structural-coherence: all assertions passed');
