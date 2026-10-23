#!/usr/bin/env bun
// What a program's view holds of a file fs.promises.copyFile made, once the
// copy is answered: the bytes the session copied, never older ones it held
// of the source; its own bytes, which no write to the source changes; at
// once readable when the view held the whole source (a file the program
// never wrote included); and there, to existsSync, statSync and require.
//
// Red before: the view dated the source's bytes it held by the source's
// cell when the answer came, not when it took them, so a source refilled
// in between stamped old bytes as the copy's; it kept the source's own
// buffer as the copy's, so appends to both overwrote each other; a source
// the program never wrote was not whole, so its copy was unreadable; and the
// copy's name stayed absent to sync reads until a barrier, in a directory the
// program made just now too.
import assert from 'node:assert/strict';
import { appliedCursor, createAuthority, facetSupervisor, launchResident, runScenarios, residentDataPlan, until } from './lib/resident-body.mjs';

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = { fs, require, resume: () => new Promise((resolve) => setTimeout(resolve, 0)) };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

/** `overrides` may be a function of the session's own answer to an op (facetSupervisor's `forward`). */
async function boot(overrides = {}, seed = () => {}) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.chown?.('home/user/app', 1000, 1000);
  seed(authority);
  let forward;
  const handle = facetSupervisor(authority, typeof overrides === 'function' ? overrides((name, args) => forward(name, args)) : overrides);
  forward = handle.forward;
  await launchResident({
    authority,
    program: PROGRAM,
    env: { SUPERVISOR: handle.supervisor },
    dataPlan: await residentDataPlan(authority, '/home/user/app'),
    cursor: authority.cursor(),
  });
  return { authority, probe: globalThis.__probe };
}
const A = '/home/user/app';

await runScenarios(import.meta.path, {
  async 'a source a peer changes before the copy, refilled while the answer is on its way: the copy is what the session copied'() {
    // The copy's wave reaches the session after the peer's change; while its
    // answer is held, a barrier tells the view of the change and the program
    // reads the source again, so the view holds the peer's bytes, dated past
    // what the copy's answer names.
    let hold = false;
    const answered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let box;
    box = await boot((forward) => ({
      fsCopyFile: async (...args) => {
        if (!hold) return forward('fsCopyFile', args);
        hold = false;
        await box.authority.peer.writeFile('home/user/app/src', 'B');
        const answer = await forward('fsCopyFile', args);
        answered.resolve();
        await release.promise;
        return answer;
      },
    }), (authority) => authority.kfs.writeFile('home/user/app/src', 'A'));
    const { fs } = box.probe;
    assert.equal(fs.readFileSync(`${A}/src`, 'utf8'), 'A');
    hold = true;
    const copied = fs.promises.copyFile(`${A}/src`, `${A}/dst`);
    await answered.promise;
    const reported = box.authority.rawVfs.revision();
    const resumed = box.probe.resume();
    await until(() => appliedCursor() >= reported, 'the barrier applied the peer\'s change');
    assert.equal(await fs.promises.readFile(`${A}/src`, 'utf8'), 'B', 'the source refilled');
    release.resolve();
    await resumed;
    await copied;
    assert.equal(fs.readFileSync(`${A}/dst`, 'utf8'), 'B');
  },

  async 'a destination link retargeted while the copy is on its way: the old target keeps its bytes'() {
    // The session follows the destination's link when it copies: a peer has pointed it elsewhere by then.
    let hold = false;
    let box;
    box = await boot((forward) => ({
      fsCopyFile: async (...args) => {
        if (hold) {
          hold = false;
          await box.authority.peer.unlink('home/user/app/d');
          await box.authority.peer.symlink('B', 'home/user/app/d');
        }
        return forward('fsCopyFile', args);
      },
    }), (authority) => {
      authority.kfs.writeFile('home/user/app/src', 'S');
      authority.kfs.writeFile('home/user/app/A', 'A-orig');
      authority.kfs.writeFile('home/user/app/B', 'B-orig');
      authority.kfs.symlink('A', 'home/user/app/d');
    });
    const { fs } = box.probe;
    assert.deepEqual([fs.readFileSync(`${A}/src`, 'utf8'), fs.readFileSync(`${A}/A`, 'utf8')], ['S', 'A-orig']);
    hold = true;
    await fs.promises.copyFile(`${A}/src`, `${A}/d`);
    // The peer's change recalled the process's hold, so the view may have to fetch A again (EAGAIN), but never answers the copy's bytes for it.
    let syncA;
    try { syncA = fs.readFileSync(`${A}/A`, 'utf8'); } catch (error) { syncA = error.code; }
    assert.ok(syncA === 'A-orig' || syncA === 'EAGAIN', `the view never answers the copy's bytes for the old target (${syncA})`);
    assert.equal(await fs.promises.readFile(`${A}/A`, 'utf8'), 'A-orig', 'the old target is untouched');
    assert.equal(await fs.promises.readFile(`${A}/B`, 'utf8'), 'S', 'the copy landed where the link pointed when it was made');
  },

  async 'a write to the copy\'s name while the copy is on its way is the later one'() {
    // The copy's wave is held; the program writes the copy's name meanwhile, logged after the copy.
    let hold = false;
    const held = Promise.withResolvers();
    const release = Promise.withResolvers();
    const box = await boot((forward) => ({
      writeBatchStream: async (...args) => {
        if (hold) { hold = false; held.resolve(); await release.promise; }
        return forward('writeBatchStream', args);
      },
    }));
    const { fs } = box.probe;
    fs.writeFileSync(`${A}/s1`, 'S');
    await fs.promises.readFile(`${A}/s1`, 'utf8');
    hold = true;
    const copied = fs.promises.copyFile(`${A}/s1`, `${A}/d1`);
    await held.promise;
    fs.writeFileSync(`${A}/d1`, 'new');
    release.resolve();
    await copied;
    assert.equal(fs.readFileSync(`${A}/d1`, 'utf8'), 'new', 'the view keeps the later write');
    assert.equal(await fs.promises.readFile(`${A}/d1`, 'utf8'), 'new', 'and so does the session');
  },

  async 'a chmod and utimes of the copy\'s name before the copy are superseded by it'() {
    // A source the program never read: the copy is the session's alone, nothing read back after it.
    const box = await boot({}, (authority) => authority.kfs.writeFile('home/user/app/s2', 'S', { mode: 0o644 }));
    const { fs } = box.probe;
    fs.writeFileSync(`${A}/d2`, 'old');
    fs.chmodSync(`${A}/d2`, 0o600);
    fs.utimesSync(`${A}/d2`, 1, 1);
    await fs.promises.copyFile(`${A}/s2`, `${A}/d2`);
    const local = fs.statSync(`${A}/d2`);
    const session = await fs.promises.stat(`${A}/d2`);
    assert.deepEqual([local.mode & 0o777, local.mtimeMs === 1000], [0o644, false], 'the copy\'s mode and times, not the overlays before it');
    assert.deepEqual([local.mode, local.mtimeMs], [session.mode, session.mtimeMs], 'statSync answers as the session does');
  },

  async 'a file made in a directory made just now, copied over: its stat is the copy\'s'() {
    const box = await boot({}, (authority) => authority.kfs.writeFile('home/user/app/s3', 'S3', { mode: 0o644 }));
    const { fs } = box.probe;
    fs.mkdirSync(`${A}/fresh`);
    fs.writeFileSync(`${A}/fresh/d3`, 'old', { mode: 0o600 });
    await fs.promises.copyFile(`${A}/s3`, `${A}/fresh/d3`);
    const local = fs.statSync(`${A}/fresh/d3`);
    const session = await fs.promises.stat(`${A}/fresh/d3`);
    assert.deepEqual([local.mode & 0o777, local.size], [0o644, 2], 'the copy\'s mode and size, not the made file\'s');
    assert.deepEqual([local.mode, local.size, local.mtimeMs], [session.mode, session.size, session.mtimeMs], 'statSync answers as the session does');
  },

  async 'a file made in a directory made just now, copied over, then its directory renamed: its stat is still the copy\'s'() {
    const box = await boot({}, (authority) => authority.kfs.writeFile('home/user/app/s4', 'S4', { mode: 0o644 }));
    const { fs } = box.probe;
    fs.mkdirSync(`${A}/fresh4`);
    fs.writeFileSync(`${A}/fresh4/d4`, 'old', { mode: 0o600 });
    await fs.promises.copyFile(`${A}/s4`, `${A}/fresh4/d4`);
    fs.renameSync(`${A}/fresh4`, `${A}/moved4`);
    const local = fs.statSync(`${A}/moved4/d4`);
    const session = await fs.promises.stat(`${A}/moved4/d4`);
    assert.deepEqual([local.mode & 0o777, local.size], [0o644, 2], 'the copy\'s mode and size, under the new name');
    assert.deepEqual([local.mode, local.size, local.mtimeMs], [session.mode, session.size, session.mtimeMs], 'statSync answers as the session does');
  },

  async 'a new file copied into a directory made just now is there to sync reads the moment it is answered'() {
    const box = await boot({}, (authority) => authority.kfs.writeFile('home/user/app/s9', 'S9', { mode: 0o640 }));
    const { fs } = box.probe;
    await fs.promises.mkdir(`${A}/fresh9/deep`, { recursive: true });
    await fs.promises.copyFile(`${A}/s9`, `${A}/fresh9/deep/c9`);
    assert.equal(fs.existsSync(`${A}/fresh9/deep/c9`), true, 'existsSync');
    const local = fs.statSync(`${A}/fresh9/deep/c9`);
    assert.deepEqual([local.mode & 0o777, local.size], [0o640, 2], 'the copy\'s mode and size');
    assert.deepEqual(fs.readdirSync(`${A}/fresh9/deep`), ['c9']);
    const session = await fs.promises.stat(`${A}/fresh9/deep/c9`);
    assert.deepEqual([local.mode, local.size, local.mtimeMs], [session.mode, session.size, session.mtimeMs], 'statSync answers as the session does');
  },

  async 'a copied made file renamed itself: its stat is still the copy\'s'() {
    const box = await boot({}, (authority) => authority.kfs.writeFile('home/user/app/s5', 'S5', { mode: 0o644 }));
    const { fs } = box.probe;
    fs.mkdirSync(`${A}/fresh5`);
    fs.writeFileSync(`${A}/fresh5/d5`, 'old', { mode: 0o600 });
    await fs.promises.copyFile(`${A}/s5`, `${A}/fresh5/d5`);
    fs.renameSync(`${A}/fresh5/d5`, `${A}/fresh5/e5`);
    const local = fs.statSync(`${A}/fresh5/e5`);
    const session = await fs.promises.stat(`${A}/fresh5/e5`);
    assert.deepEqual([local.mode & 0o777, local.size], [0o644, 2]);
    assert.deepEqual([local.mode, local.size, local.mtimeMs], [session.mode, session.size, session.mtimeMs]);
  },

  async 'a copied made file removed and made again: the new file is its own, nothing of the copy'() {
    const box = await boot({}, (authority) => authority.kfs.writeFile('home/user/app/s6', 'S6', { mode: 0o644 }));
    const { fs } = box.probe;
    fs.mkdirSync(`${A}/fresh6`);
    fs.writeFileSync(`${A}/fresh6/d6`, 'old', { mode: 0o600 });
    await fs.promises.copyFile(`${A}/s6`, `${A}/fresh6/d6`);
    fs.rmSync(`${A}/fresh6/d6`);
    assert.equal(fs.existsSync(`${A}/fresh6/d6`), false);
    fs.writeFileSync(`${A}/fresh6/d6`, 'again', { mode: 0o640 });
    const local = fs.statSync(`${A}/fresh6/d6`);
    const session = await fs.promises.stat(`${A}/fresh6/d6`);
    assert.deepEqual([local.mode & 0o777, local.size], [0o640, 5]);
    assert.deepEqual([local.mode, local.size], [session.mode, session.size]);
  },

  async 'a made file\'s chmod and utimes travel with its directory\'s rename'() {
    const box = await boot();
    const { fs } = box.probe;
    fs.mkdirSync(`${A}/fresh7`);
    fs.writeFileSync(`${A}/fresh7/d7`, 'x');
    fs.chmodSync(`${A}/fresh7/d7`, 0o604);
    fs.utimesSync(`${A}/fresh7/d7`, 7, 7);
    fs.renameSync(`${A}/fresh7`, `${A}/moved7`);
    const local = fs.statSync(`${A}/moved7/d7`);
    const session = await fs.promises.stat(`${A}/moved7/d7`);
    assert.deepEqual([local.mode & 0o777, local.mtimeMs], [0o604, 7000]);
    assert.deepEqual([local.mode, local.mtimeMs], [session.mode, session.mtimeMs]);
  },

  async 'a copy and its source are each their own: appends to both keep each'() {
    const box = await boot();
    const { fs } = box.probe;
    fs.writeFileSync(`${A}/bin`, Buffer.from([1, 2, 3, 4]));
    fs.appendFileSync(`${A}/bin`, Buffer.from([5, 6]));
    await fs.promises.copyFile(`${A}/bin`, `${A}/bin2`);
    fs.appendFileSync(`${A}/bin`, Buffer.from([7]));
    fs.appendFileSync(`${A}/bin2`, Buffer.from([9]));
    assert.deepEqual([[...fs.readFileSync(`${A}/bin`)], [...fs.readFileSync(`${A}/bin2`)]], [[1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 9]]);
  },

  async 'a source the program only read: its copy is readable at once'() {
    const box = await boot({}, (authority) => authority.kfs.writeFile('home/user/app/seed.txt', 'seeded'));
    const { fs } = box.probe;
    assert.equal(fs.readFileSync(`${A}/seed.txt`, 'utf8'), 'seeded');
    await fs.promises.copyFile(`${A}/seed.txt`, `${A}/seed-copy.txt`);
    assert.equal(fs.readFileSync(`${A}/seed-copy.txt`, 'utf8'), 'seeded');
  },

  async 'a copy is there to sync reads and require the moment it is answered'() {
    const box = await boot({}, (authority) => authority.kfs.writeFile('home/user/app/mod.js', 'module.exports = 42;'));
    const { fs, require } = box.probe;
    assert.equal(fs.readFileSync(`${A}/mod.js`, 'utf8'), 'module.exports = 42;');
    await fs.promises.copyFile(`${A}/mod.js`, `${A}/mod-copy.js`);
    assert.deepEqual([fs.existsSync(`${A}/mod-copy.js`), fs.statSync(`${A}/mod-copy.js`).size, require(`${A}/mod-copy.js`)], [true, 20, 42]);
  },
});
