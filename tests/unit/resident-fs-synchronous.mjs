#!/usr/bin/env bun
// The resident filesystem's synchronous view (ResidentFilesystem.synchronous,
// VFS-9 B stage 3): every call answers now, from what the process holds, or
// is refused before it begins anything. A refusal is EAGAIN (not resident)
// or the name's own state where the view knows it; never a promise; and it
// leaves nothing: no session call made or begun, no wave, no log entry, no
// barrier, nothing held.
//
// Red before: the synchronous view was the session's own (the authority's),
// which reads past what this process holds, and a call that needed the
// session began it.

import assert from 'node:assert/strict';
import { runScenarios } from './lib/resident-body.mjs';
import { APP, bootEngine } from './lib/guest-engines.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A holder engine over a session that holds `APP/seed.txt` (not read yet) and `APP/dir/`. */
const boot = () => bootEngine('holder', {
  seed(authority) {
    authority.kfs.writeFile('home/user/app/seed.txt', 'SEED');
    authority.kfs.mkdir('home/user/app/dir', { mode: 0o755 });
    authority.kfs.writeFile('home/user/app/dir/inner.txt', 'INNER');
  },
});

/** What a refused call must leave as it was. */
async function footprint(e) {
  const stats = await e.fs.stats();
  return {
    calls: { ...e.log.calls },
    waves: e.waves(),
    logged: e.journal().entries().length,
    sessionCalls: stats.sessionCalls,
    barriers: stats.barriers,
    holding: await e.fs.holding(),
  };
}

/** `call` answers now: a value, or a refusal whose code is `code`, leaving nothing. */
async function answersNow(e, label, call, code) {
  const before = await footprint(e);
  let value;
  let refused;
  try { value = call(); } catch (error) { refused = error; }
  assert.ok(!(value instanceof Promise), `${label}: a promise`);
  if (code === undefined) assert.equal(refused, undefined, `${label}: refused ${refused?.code} ${refused?.message}`);
  else assert.equal(refused?.code, code, `${label}: ${refused === undefined ? 'answered' : `${refused.code} ${refused.message}`}`);
  // Nothing it began may finish after it either.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await footprint(e), before, `${label}: left something`);
  return value;
}

await runScenarios(import.meta.path, {
  async 'a call that needs the session is refused before it begins anything'(e = undefined) {
    e = await boot();
    const sync = e.sync;
    const seed = `${APP}/seed.txt`;
    // The view knows nothing of these yet: each is the session's to answer.
    await answersNow(e, 'stat of an unknown name', () => sync.stat(`${APP}/nowhere.txt`), 'EAGAIN');
    await answersNow(e, 'readFile of an unknown name', () => sync.readFile(seed), 'EAGAIN');
    await answersNow(e, 'readdir of an unlisted directory', () => sync.readdir(`${APP}/dir`), 'EAGAIN');
    await answersNow(e, 'readlink', () => sync.readlink(seed), 'EAGAIN');
    await answersNow(e, 'realpath', () => sync.realpath(seed), 'EAGAIN');
    await answersNow(e, 'access', () => sync.access(seed, 4), 'EAGAIN');
    await answersNow(e, 'a read-only open', () => sync.open(seed, { read: true }), 'EAGAIN');
    // Known, its bytes not: the name answers, its content is not resident.
    assert.equal((await e.fs.stat(seed)).size, 4);
    assert.equal(stat(await answersNow(e, 'stat of a known name', () => sync.stat(seed))), 4);
    await answersNow(e, 'readFile of bytes not resident', () => sync.readFile(seed), 'EAGAIN');
    // A directory is the name's own state where the view knows it.
    assert.equal((await e.fs.stat(`${APP}/dir`)).type, 'directory');
    await answersNow(e, 'readFile of a directory', () => sync.readFile(`${APP}/dir`), 'EISDIR');
  },

  async 'what the process holds is answered now, the barrier it owes not taken'(e = undefined) {
    e = await boot();
    const sync = e.sync;
    const seed = `${APP}/seed.txt`;
    assert.equal(dec.decode(await e.fs.readFile(seed)), 'SEED');
    await e.fs.readdir(`${APP}/dir`);
    assert.equal(dec.decode(await answersNow(e, 'readFile of resident bytes', () => sync.readFile(seed))), 'SEED');
    assert.deepEqual((await answersNow(e, 'readdir of a listed directory', () => sync.readdir(`${APP}/dir`))).map((entry) => entry.name), ['inner.txt']);
    // A change the session made it owe a barrier: a call that answers now
    // answers from the view as it stands, and the next awaited one takes it.
    await e.fs.writeFile(`${APP}/other.txt`, enc.encode('O'));
    assert.equal(stat(await answersNow(e, 'stat with a barrier owed', () => sync.stat(seed))), 4);
    const { barriers } = await e.fs.stats();
    await e.fs.stat(seed);
    assert.equal((await e.fs.stats()).barriers, barriers + 1, 'the awaited call did not take the barrier owed');
  },
});

function stat(value) {
  return value === null ? null : Number(value.size);
}
