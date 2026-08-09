#!/usr/bin/env bun
// sync-fs/first-sync-read-untouched — THE invariant, on real infrastructure.
//
// "Any process shall have the view of the latest coherent global file system
// state… whether using sync or async APIs." Concretely: a node process's FIRST
// synchronous read of a data file it has never touched must succeed. Before
// the resident store it raised EAGAIN — or ENOENT, which is worse, because an
// error that names the wrong cause is one a user debugs in the wrong place.
//
// Every wasm runtime (ruby / clang / bash / CPython) already satisfies this
// through a suspending JSPI syscall against the live VFS. Node cannot suspend
// a JS stack, so it is the one runtime that needed the bytes to be somewhere a
// synchronous call could already reach: the process facet's own SQLite.
//
// WHAT MAKES THIS PROBE NON-VACUOUS — learned the hard way
//   Being outside the working tree is NOT enough, and asserting it would have
//   been wrong. The first version of this probe used a 4 KiB file under /opt
//   and PASSED against `origin/main`, where the store does not exist — because
//   a path this session has already written is a path the bundler knows about,
//   and at 4 KiB it simply staged it. The probe was measuring the prefetch
//   bundle, not the store.
//
//   The fixture is therefore sized past VFS_BUNDLE_MAX_BYTES (24 MiB), which
//   is the one thing no heuristic can route around: the bundler truncates
//   there and says so — "They still exist and async reads still return them;
//   synchronous reads raise EAGAIN." That is precisely the failure this store
//   exists to delete, so it is the fixture that can tell the two builds apart.
//
//   The program's first contact with the file is the synchronous read: no
//   stat, no exists, no require, nothing that could have paged it in. And the
//   process is RESIDENT, because that is the only substrate the store lives
//   on: a one-shot `exec` runs in a stateless loaded worker with no facet
//   storage at all.
//
//   The negative control is not a flag inside this file — it is running this
//   same probe against a deployment built from `origin/main`, where the read
//   must FAIL. A probe with only a passing arm is the failure mode that has
//   bitten this project repeatedly, and it bit this probe on its first run.

import { mintSession, Terminal, sleep, BASE, makeAsserter, deleteSession } from '../_driver.mjs';

/** Outside /home/user, and past the bundle's byte cap. */
const DIR = '/opt/appdata/locale/deep';
const UNTOUCHED = `${DIR}/never-required.dat`;
/** 25 MiB — over VFS_BUNDLE_MAX_BYTES, so the bundler must evict it. */
const SIZE = 25 * 1024 * 1024;
const FILL = 'N';

const a = makeAsserter('sync-fs/first-sync-read-untouched');
const sid = await mintSession();
console.log(`[sync-fs first-sync-read] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

// ── Put the file where nothing will stage it ────────────────────────────────
await t.run(`mkdir -p ${DIR}`, 20_000);
// Generated in the session rather than shipped through the socket: 25 MiB does
// not belong in a shell command line.
await t.run(
  `node -e "require('fs').writeFileSync('${UNTOUCHED}', '${FILL}'.repeat(${SIZE}))"`,
  180_000,
);
const listed = (await t.run(`ls -l ${UNTOUCHED}`, 30_000)).output;
a.check(
  `the ${SIZE}-byte fixture exists in the session filesystem`,
  listed.includes('never-required.dat') && listed.includes(String(SIZE)),
  listed.trim().slice(-200),
);

// ── A RESIDENT node process whose FIRST contact is the synchronous read ─────
//
// It listens, because listening is what makes it resident. The read happens
// before the listen, so nothing about serving can have paged the file in.
const PROGRAM = `
const fs = require('fs');
const http = require('http');
let line;
try {
  const body = fs.readFileSync(${JSON.stringify(UNTOUCHED)}, 'utf8');
  line = 'SYNC_READ_OK len=' + body.length + ' head=' + body.slice(0, 8);
} catch (e) {
  line = 'SYNC_READ_FAILED ' + ((e && e.code) || '') + ' ' + ((e && e.message) || e);
}
console.log(line);
http.createServer((_q, s) => { s.setHeader('content-type','text/plain'); s.end(line); }).listen(3000);
`;

await t.run(
  `node -e "require('fs').writeFileSync('/home/user/reader.js', Buffer.from('${Buffer.from(PROGRAM, 'utf8').toString('base64')}','base64').toString('utf8'))"`,
  30_000,
);

const out = (await t.run('node /home/user/reader.js', 120_000)).output;
console.log(`  program said: ${out.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`);

const ok = out.includes('SYNC_READ_OK');
const failed = out.includes('SYNC_READ_FAILED');

a.check(
  'the program reported an outcome at all',
  ok || failed,
  `neither marker present — the process may not have started: ${out.trim().slice(-240)}`,
);
a.check(
  'a FIRST synchronous read of an untouched data file succeeds',
  ok,
  failed ? out.slice(out.indexOf('SYNC_READ_FAILED')).split('\n')[0].slice(0, 200) : '',
);
a.check(
  'it returned every byte, not a truncated cell',
  out.includes(`len=${SIZE}`) && out.includes(`head=${FILL.repeat(8)}`),
  `expected len=${SIZE} head=${FILL.repeat(8)}`,
);

// The error a regression would produce, named explicitly so a future failure
// says which one came back rather than only that something did.
a.check(
  'no EAGAIN — the resident-set miss this store exists to delete',
  !out.includes('EAGAIN'),
  'EAGAIN means the bytes were not resident when the sync read ran',
);
a.check(
  'no ENOENT — the silently-wrong case, a real file reported absent',
  !(failed && out.includes('ENOENT')),
  'ENOENT on an existing file means the facet had no metadata for the path',
);

const { fail } = a.summary();
try { await deleteSession(sid, 'sync-fs-probe-cleanup'); } catch { /* anon sessions 401 and reap on TTL */ }
process.exit(fail === 0 ? 0 : 1);
