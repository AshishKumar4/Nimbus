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
//   3. the record clears only when the program takes the remedy the error
//      names, an asynchronous read — residency repaired behind its back does
//      not un-answer the read that failed, and neither does a later
//      synchronous read that succeeds, a stat or an existence check: the
//      program may already have built on the refusal (vite's resolver does);
//   4. a path that genuinely does not exist is still ENOENT, and is not
//      recorded, because a missing file is not a residency failure.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { sessionShims } from './lib/session-shims.mjs';

const dir = '/home/user/example-app';
const resident = `${dir}/resident.json`;
const staged = `${dir}/lib.data.d.ts`;
const alsoStaged = `${dir}/second.data`;
const asyncOnly = `${dir}/third.data`;
const absent = `${dir}/never-written.txt`;

const RESIDENT_BODY = '{"resident":true}';
const STAGED_BODY = 'the bytes only an async read can reach at first';
const SECOND_BODY = 'a second data file, refused three times';
const THIRD_BODY = 'answered only through the async form';

const key = (path) => path.replace(/^\/+/, '');

const authority = createAuthority();
authority.kfs.mkdir(dir.slice(1), { recursive: true, mode: 0o755 });
authority.kfs.writeFile(key(resident), RESIDENT_BODY);
authority.kfs.writeFile(key(staged), STAGED_BODY);
authority.kfs.writeFile(key(alsoStaged), SECOND_BODY);
authority.kfs.writeFile(key(asyncOnly), THIRD_BODY);

// The fetches the session is asked for, by file: each fault-in's ranged reads.
const fetched = new Map();

// The bundle carries `resident.json` and NOT the two data files. That is the
// condition under test: the existence views know all three, the content view
// knows one.
const { fs, rf } = sessionShims(authority, {
  bundle: { [key(resident)]: RESIDENT_BODY },
  cwd: dir,
  overrides: (call) => ({
    fsReadBatch: (requests) => {
      for (const request of requests) {
        if (request.lstat === true) continue;
        const path = key(request.path);
        fetched.set(path, (fetched.get(path) ?? 0) + 1);
      }
      return call('fsReadBatch', [requests]);
    },
  }),
  tail: ';return { fs: __fsMod };',
});

// ── 1. A resident read is not a miss ────────────────────────────────────────
assert.equal(fs.readFileSync(resident, 'utf8'), RESIDENT_BODY);
assert.deepEqual(await rf.misses(), [], 'a read the bundle served must not be recorded as a miss');

// ── 2. An absent path stays ENOENT and is not recorded ──────────────────────
// The previous behaviour answered EVERY unserved read with ENOENT, and that is
// why the honest code exists. It must not have cost the honest ENOENT.
let absentError = null;
try { fs.readFileSync(absent, 'utf8'); } catch (error) { absentError = error; }
assert.ok(absentError, 'reading a file that does not exist must throw');
assert.equal(absentError.code, 'ENOENT', 'a file that is genuinely gone is ENOENT, not EAGAIN');
assert.deepEqual(await rf.misses(), [], 'a missing file is not a residency failure');

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
  await rf.misses(), [key(staged)],
  'the miss must be recorded so the run can be failed by name instead of ending quietly',
);

// ── 4. The miss faults the content in ───────────────────────────────────────
// The access that missed cannot be served. The next one can, and a program
// that reads the same file twice — or a later phase that reaches it for the
// first time — must not be refused for a reason already repaired. But the
// first refusal stands: what the program did with it is not undone.
assert.equal(
  fs.readFileSync(staged, 'utf8'), STAGED_BODY,
  'the miss must have made the content resident for the next read',
);
assert.equal(fs.existsSync(staged), true);
assert.equal(fs.statSync(staged).size, STAGED_BODY.length);
assert.deepEqual(
  await rf.misses(), [key(staged)],
  'a later synchronous answer does not clear the refusal the program may have built on',
);

// ── 5. Repeated misses cost one fetch per path, not one per read ────────────
for (let i = 0; i < 3; i++) {
  try { fs.readFileSync(alsoStaged, 'utf8'); } catch { /* the miss under test */ }
}
assert.deepEqual(
  await rf.misses(), [key(staged), key(alsoStaged)],
  'three refused reads of one path are one unanswered path',
);
assert.equal(
  fetched.get(key(alsoStaged)), 1,
  `a repeated miss must not re-fetch: the ledger is the dedupe (saw ${fetched.get(key(alsoStaged)) ?? 0} fetches)`,
);

// ── 6. Repair behind the program's back does not clear the record ───────────
// `second.data` is resident now — the fault-in fetched it — but the program
// was never handed those bytes. It read three times and got nothing three
// times, so the run is not honest and must not be allowed to end quietly.
assert.deepEqual(
  await rf.misses(), [key(staged), key(alsoStaged)],
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
  await rf.misses(), [key(staged), key(alsoStaged), key(asyncOnly)],
  'each unanswered path is listed once, in the order the program hit them',
);
assert.equal(await fs.promises.readFile(asyncOnly, 'utf8'), THIRD_BODY);
assert.deepEqual(
  await rf.misses(), [key(staged), key(alsoStaged)],
  'the async form is the documented remedy, so taking it must settle that miss',
);
assert.equal(fs.readFileSync(alsoStaged, 'utf8'), SECOND_BODY);
assert.deepEqual(
  await rf.misses(), [key(staged), key(alsoStaged)],
  'a retried sync read that succeeds does not settle the read that was refused',
);
assert.equal(await fs.promises.readFile(staged, 'utf8'), STAGED_BODY);
assert.equal(await fs.promises.readFile(alsoStaged, 'utf8'), SECOND_BODY);
assert.deepEqual(await rf.misses(), [], 'the async form settles each of them');

// ── 8. The refusals are counted alongside the other filesystem numbers ──────
// Whether residency is working is a measurement, not an opinion, and it rides
// the counters the filesystem keeps (ResidentFilesystem.stats).
assert.ok(
  rf.stats().notResident >= 3,
  'every refused read must also be counted',
);

console.log('node-shims-sync-residency: all tests passed');
