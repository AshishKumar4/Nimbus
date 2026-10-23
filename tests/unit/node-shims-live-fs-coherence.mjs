#!/usr/bin/env bun
// A long-running Node facet must treat its spawn-time VFS state as a cache,
// never as authority for async I/O after another process mutates SQLite VFS.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const dir = '/home/user/coherence';
const resident = `${dir}/resident.txt`;
const late = `${dir}/late.txt`;
const current = 'v2-longer-content';

// The barrier of a read is held by the test until released, to observe that
// the read counts as an operation in flight while it waits.
const barrierGate = { held: false, gate: null };

const authority = createAuthority();
authority.kfs.mkdir(dir, { recursive: true });
authority.kfs.writeFile(resident, 'v1');
const { fs } = shimsOnSession({
  authority,
  cwd: dir,
  bundle: { 'home/user/coherence/resident.txt': 'v1' },
  overrides: (forward) => ({
    fsAcquire: async (position, options) => {
      if (barrierGate.held) await barrierGate.gate.promise;
      return forward('fsAcquire', [position, options]);
    },
  }),
});
const fsp = fs.promises;

// A sibling process mutates the authoritative VFS after this facet spawned.
await authority.peer.writeFile(resident, current);
await authority.peer.writeFile(late, 'created-after-spawn');

const observed = {
  readFile: await fsp.readFile(resident, 'utf8'),
  statSize: (await fsp.stat(resident)).size,
  names: await fsp.readdir(dir),
  late: await fsp.readFile(late, 'utf8'),
  syncLateAfterAsync: null,
  handle: null,
  ranged: null,
  stream: '',
};
try {
  observed.syncLateAfterAsync = fs.readFileSync(late, 'utf8');
} catch (error) {
  observed.syncLateAfterAsync = error.code;
}

{
  const opened = await fsp.open(resident, 'r');
  observed.handle = await opened.readFile('utf8');
  await opened.close();
}

{
  const opened = await fsp.open(resident, 'r');
  const buffer = new Uint8Array(current.length);
  const { bytesRead } = await opened.read(buffer, 0, buffer.length, 0);
  observed.ranged = new TextDecoder().decode(buffer.subarray(0, bytesRead));
  await opened.close();
}

{
  for await (const chunk of fs.createReadStream(resident, { encoding: 'utf8' })) {
    observed.stream += chunk;
  }
}

assert.deepEqual(observed, {
  readFile: current,
  statSize: current.length,
  names: ['late.txt', 'resident.txt'],
  late: 'created-after-spawn',
  // The async read has ALREADY fetched these bytes, so the sync read of the
  // same path serves them: refusing bytes the process holds is not honesty
  // about a limit.
  syncLateAfterAsync: 'created-after-spawn',
  handle: current,
  ranged: current,
  stream: current,
});

// A path this process has never observed cannot be served synchronously, and
// that refusal has to be actionable on its own: name the file, say why it
// could not be served, and name the call that will serve it.
const neverTouched = `${dir}/never-touched.txt`;
await authority.peer.writeFile(neverTouched, 'only-in-the-authority');
// The namespace learned the name from the async readdir above, so the sync
// existence view knows the path while the content view does not — which is
// exactly the case EAGAIN exists to distinguish from a genuine ENOENT.
await fsp.readdir(dir);
let untouchedError = null;
try {
  fs.readFileSync(neverTouched, 'utf8');
} catch (error) {
  untouchedError = error;
}
assert.ok(untouchedError, 'a never-observed path cannot be served synchronously');
assert.equal(untouchedError.code, 'EAGAIN');
assert.match(untouchedError.message, /never-touched\.txt/);
assert.match(untouchedError.message, /not resident/);
assert.match(untouchedError.message, /fs\.promises\.readFile/);
assert.equal(untouchedError.path, neverTouched);
assert.equal(untouchedError.syscall, 'open');

// ...and once it IS read asynchronously, the sync path serves it. The bytes
// were paid for; a second round trip to re-fetch them would be waste.
assert.equal(await fsp.readFile(neverTouched, 'utf8'), 'only-in-the-authority');
assert.equal(fs.readFileSync(neverTouched, 'utf8'), 'only-in-the-authority');

// existsSync and readFileSync must agree about the same path. Reporting the
// file as present while the read reports it as absent is incoherent whatever
// else is true.
assert.equal(fs.existsSync(late), true);

// A path nothing has ever observed is still a plain ENOENT — the distinction
// only means something if genuine absence keeps its own code.
const absent = `${dir}/never-existed.txt`;
assert.equal(fs.existsSync(absent), false);
assert.throws(() => fs.readFileSync(absent, 'utf8'), (error) => {
  assert.equal(error.code, 'ENOENT');
  return true;
});

// Pending sync mutations are newer than the session until flushed. An async
// observation must preserve them by making them authoritative first.
fs.writeFileSync(resident, 'same-facet-open-pending');
{
  const opened = await fsp.open(resident, 'r');
  assert.equal(
    await authority.peer.readFileString(resident),
    'same-facet-open-pending',
    'async open flushes pending sync content before observing authority metadata',
  );
  await opened.close();
}

fs.writeFileSync(resident, 'same-facet-pending');
assert.equal(await fsp.readFile(resident, 'utf8'), 'same-facet-pending');
assert.equal(await authority.peer.readFileString(resident), 'same-facet-pending');

const accessCreated = `${dir}/access-created.txt`;
fs.writeFileSync(accessCreated, 'created-before-access');
await fsp.access(accessCreated);
assert.equal(await authority.peer.readFileString(accessCreated), 'created-before-access');

fs.mkdirSync(`${dir}/same-facet-dir`);
assert.deepEqual(
  await fsp.readdir(`${dir}/same-facet-dir`),
  [],
  'async readdir flushes the exact pending directory before listing it',
);
assert.deepEqual(
  await fsp.readdir(dir),
  ['access-created.txt', 'late.txt', 'never-touched.txt', 'resident.txt', 'same-facet-dir'],
);
assert.equal((await authority.peer.stat(`${dir}/same-facet-dir`)).type, 'directory');

// Removal has to retract the path from the sync existence view too. The
// spawn-time metadata snapshot outlives the file it describes, so without
// that retraction a deleted file keeps reporting as present — and the read
// path would call it merely non-resident instead of gone.
assert.equal(fs.existsSync(resident), true);
fs.unlinkSync(resident);
assert.equal(fs.existsSync(resident), false);
assert.throws(() => fs.readFileSync(resident, 'utf8'), (error) => {
  assert.equal(error.code, 'ENOENT');
  return true;
});

// A directory is not "non-resident content" — reading one is EISDIR, the
// answer Node gives, not a suggestion to retry the read asynchronously.
assert.throws(() => fs.readFileSync(dir, 'utf8'), (error) => {
  assert.equal(error.code, 'EISDIR');
  return true;
});

// An async read holds the program open for the WHOLE read, barrier included.
//
// A one-shot facet's event loop exits when no handle is live, and an in-flight
// supervisor RPC is one of the three kinds of handle it counts. The ACQUIRE
// barrier is the first thing an async read issues, so it must count as an
// operation in flight from the start of the read. Otherwise the loop ends
// there: an fs.promises.readFile whose .then never runs — no error, no
// output, intermittently. create-next-app copied its template that way and
// wrote the directories but none of the files.
{
  await authority.peer.writeFile(`${dir}/held.txt`, 'held');
  barrierGate.gate = Promise.withResolvers();
  barrierGate.held = true;
  const read = fsp.readFile(`${dir}/held.txt`, 'utf8');
  // Let the read reach its barrier and park there.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.ok(
    globalThis.__nimbusPendingOps > 0,
    'the barrier a read is waiting on must count as an operation in flight',
  );
  barrierGate.held = false;
  barrierGate.gate.resolve();
  assert.equal(await read, 'held');
}

console.log('node-shims-live-fs-coherence: all assertions passed');
