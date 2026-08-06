#!/usr/bin/env bun
// A synchronous read the resident view cannot serve must not end in silence.
//
// A facet has no synchronous I/O primitive, so a sync read of a file whose
// content was never staged into the process cannot be served. The error it
// raises, EAGAIN, is the honest one — the file exists, so ENOENT would be a
// fabrication — but it is a code no program branches on, because it cannot
// arise from reading a real POSIX regular file. Whatever catch block receives
// it was written for a missing file, so the reader takes that branch and
// carries on with an answer built for a different condition.
//
// So throwing cannot be the whole behaviour. What has to hold:
//
//   1. the miss is RECORDED, by name, so the run can be failed on the way out
//      instead of reporting a success that rests on a read that did not
//      happen;
//   2. the miss FAULTS THE CONTENT IN, so the next touch of the same path is
//      not refused a second time for a reason that was repairable after the
//      first;
//   3. the record clears only when the PROGRAM is handed the bytes — residency
//      repaired behind its back does not un-answer the read that failed;
//   4. a path that genuinely does not exist is still ENOENT, and is not
//      recorded, because a missing file is not a residency failure.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/worker/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const enc = new TextEncoder();
const dec = new TextDecoder();

const dir = '/home/user/app';
const resident = `${dir}/resident.json`;
const staged = `${dir}/lib.data.d.ts`;
const alsoStaged = `${dir}/second.data`;
const asyncOnly = `${dir}/third.data`;
const absent = `${dir}/never-written.txt`;

const RESIDENT_BODY = '{"resident":true}';
const STAGED_BODY = 'the bytes only an async read can reach at first';
const SECOND_BODY = 'a second data file, refused three times';
const THIRD_BODY = 'answered only through the async form';

vfs.mkdir(dir, { recursive: true });
vfs.writeFile(resident, enc.encode(RESIDENT_BODY));
vfs.writeFile(staged, enc.encode(STAGED_BODY));
vfs.writeFile(alsoStaged, enc.encode(SECOND_BODY));
vfs.writeFile(asyncOnly, enc.encode(THIRD_BODY));

const supervisor = {
  readFile: async (path) => {
    const bytes = await bridge.readFile(path);
    return bytes ? dec.decode(bytes) : null;
  },
  stat: (path) => bridge.stat(path),
  lstat: (path) => bridge.stat(path, { followSymlinks: false }),
  readdir: (path) => bridge.readdir(path),
  exists: async (path) => (await bridge.stat(path)) !== null,
  fsReadRange: (path, offset, length) => bridge.readRange(path, offset, length),
};

const statOf = (path, size) => ({ type: 'file', size, mode: 0o644, uid: 1000, gid: 1000 });

// The bundle carries `resident.json` and NOT the two data files. That is the
// condition under test: the existence views know all three, the content view
// knows one.
const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
    '\n;return { fs: __fsMod };',
);
const { fs } = factory(
  { 'home/user/app/resident.json': RESIDENT_BODY },
  {
    'home/user/app': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 },
    'home/user/app/resident.json': statOf(resident, RESIDENT_BODY.length),
    'home/user/app/lib.data.d.ts': statOf(staged, STAGED_BODY.length),
    'home/user/app/second.data': statOf(alsoStaged, SECOND_BODY.length),
    'home/user/app/third.data': statOf(asyncOnly, THIRD_BODY.length),
  },
  {},
  {
    'home/user': ['app'],
    'home/user/app': ['resident.json', 'lib.data.d.ts', 'second.data', 'third.data'],
  },
  supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  dir,
  [], {},
  `${dir}/entry.js`,
  dir,
);

/** The ledger the runner reads at exit to decide whether the run was honest. */
const missed = () => [...(globalThis.__nimbusVfsResidencyMisses || [])];

const settle = async (times = 8) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

// ── 1. A resident read is not a miss ────────────────────────────────────────
assert.equal(fs.readFileSync(resident, 'utf8'), RESIDENT_BODY);
assert.deepEqual(missed(), [], 'a read the bundle served must not be recorded as a miss');

// ── 2. An absent path stays ENOENT and is not recorded ──────────────────────
// The previous behaviour answered EVERY unserved read with ENOENT, and that is
// why the honest code exists. It must not have cost the honest ENOENT.
let absentError = null;
try { fs.readFileSync(absent, 'utf8'); } catch (error) { absentError = error; }
assert.ok(absentError, 'reading a file that does not exist must throw');
assert.equal(absentError.code, 'ENOENT', 'a file that is genuinely gone is ENOENT, not EAGAIN');
assert.deepEqual(missed(), [], 'a missing file is not a residency failure');

// ── 3. A non-resident read: EAGAIN, named, and recorded ─────────────────────
let missError = null;
try { fs.readFileSync(staged, 'utf8'); } catch (error) { missError = error; }
assert.ok(missError, 'a read of non-resident content must throw');
assert.equal(missError.code, 'EAGAIN', 'a file that exists must not be reported missing');
assert.equal(missError.path, staged);
assert.ok(
  missError.message.includes(staged),
  `the error must name the file it could not read: ${missError.message}`,
);
assert.deepEqual(
  missed(), ['home/user/app/lib.data.d.ts'],
  'the miss must be recorded so the run can be failed by name instead of ending quietly',
);

// ── 4. The miss faults the content in ───────────────────────────────────────
// The access that missed cannot be served. The next one can, and a program
// that reads the same file twice — or a later phase that reaches it for the
// first time — must not be refused for a reason already repaired.
await settle();
assert.equal(
  fs.readFileSync(staged, 'utf8'), STAGED_BODY,
  'the miss must have made the content resident for the next read',
);
assert.deepEqual(
  missed(), [],
  'handing the program the bytes is what clears the record',
);

// ── 5. Repeated misses cost one fetch per path, not one per read ────────────
let rangeCalls = 0;
const countingReadRange = supervisor.fsReadRange;
supervisor.fsReadRange = (path, offset, length) => {
  rangeCalls++;
  return countingReadRange(path, offset, length);
};
for (let i = 0; i < 3; i++) {
  try { fs.readFileSync(alsoStaged, 'utf8'); } catch { /* the miss under test */ }
}
assert.deepEqual(
  missed(), ['home/user/app/second.data'],
  'three refused reads of one path are one unanswered path',
);
await settle();
assert.equal(
  rangeCalls, 1,
  `a repeated miss must not re-fetch: the ledger is the dedupe (saw ${rangeCalls} fetches)`,
);

// ── 6. Repair behind the program's back does not clear the record ───────────
// `second.data` is resident now — the fault-in fetched it — but the program
// was never handed those bytes. It read three times and got nothing three
// times, so the run is not honest and must not be allowed to end quietly.
assert.deepEqual(
  missed(), ['home/user/app/second.data'],
  'residency repaired after the fact does not un-answer the reads that failed',
);

// ── 7. An async read answers the program, and clears the record ─────────────
// A third file, non-resident from the start, whose only answer is the async
// form the error message points the reader at.
let thirdError = null;
try { fs.readFileSync(asyncOnly, 'utf8'); } catch (error) { thirdError = error; }
assert.ok(thirdError, 'a path outside the bundle must not read synchronously');
assert.equal(
  thirdError.code, 'EAGAIN',
  'a path the supervisor can see is present, not missing',
);
assert.deepEqual(
  missed(), ['home/user/app/second.data', 'home/user/app/third.data'],
  'each unanswered path is listed once, in the order the program hit them',
);
assert.equal(await fs.promises.readFile(asyncOnly, 'utf8'), THIRD_BODY);
assert.deepEqual(
  missed(), ['home/user/app/second.data'],
  'the async form is the documented remedy, so taking it must settle that miss',
);
assert.equal(fs.readFileSync(alsoStaged, 'utf8'), SECOND_BODY);
assert.deepEqual(missed(), [], 'a retried sync read that succeeds settles its own miss');

// ── 8. The miss count is reported alongside the other coherence numbers ─────
// Whether residency is working is a measurement, not an opinion, and it rides
// the ledger the fills and invalidations already ride.
assert.ok(
  globalThis.__nimbusVfsCoherence.misses >= 3,
  'every recorded miss must also be counted',
);

console.log('node-shims-sync-residency: all tests passed');
