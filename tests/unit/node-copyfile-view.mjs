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
// copy's name stayed absent to sync reads until a barrier.
import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, runScenarios, residentDataPlan, until } from './lib/resident-body.mjs';

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
      writeBatchStream: async (...args) => {
        if (!hold) return forward('writeBatchStream', args);
        hold = false;
        await box.authority.peer.writeFile('home/user/app/src', 'B');
        const answer = await forward('writeBatchStream', args);
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
    await until(() => globalThis.__nimbusVfsCursor.rev >= reported, 'the barrier applied the peer\'s change');
    assert.equal(await fs.promises.readFile(`${A}/src`, 'utf8'), 'B', 'the source refilled');
    release.resolve();
    await resumed;
    await copied;
    assert.equal(fs.readFileSync(`${A}/dst`, 'utf8'), 'B');
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
