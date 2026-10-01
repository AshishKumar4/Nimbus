#!/usr/bin/env bun
// Bytes read or written through a symlink are the bytes of the file it names.
//
// open(2) follows every symlink on a path, the last one too, so a node
// program writing `link.txt -> target.txt` writes target.txt, and the link
// stays a link. The sync view held such a write under the link's own name:
// once it flushed, lstat saw a regular file where the link is, realpath named
// the link, and a later write to target.txt by anyone never reached it.

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, runScenarios, residentDataPlan, until } from './lib/resident-body.mjs';

const APP = '/home/user/app';
const LINK = `${APP}/link.txt`;
const TARGET = `${APP}/target.txt`;

// `resume`: a timer, whose resumption takes a barrier before it runs.
const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
const resume = () => new Promise((resolve) => setTimeout(resolve, 0));
globalThis.__probe = { fs, read, resume };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

async function boot(seed) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/target.txt', 'old');
  authority.kfs.symlink('target.txt', 'home/user/app/link.txt');
  seed?.(authority);
  authority.kfs.writeFile('home/user/app/f.txt', 'f');
  const handle = facetSupervisor(authority);
  await launchResident({
    authority,
    program: PROGRAM,
    env: { SUPERVISOR: handle.supervisor },
    dataPlan: await residentDataPlan(authority, APP),
    cursor: authority.cursor(),
  });
  return { authority, probe: globalThis.__probe };
}

/** The link is still the link it was, and names the target. */
function assertLink(probe, when) {
  assert.equal(probe.fs.lstatSync(LINK).isSymbolicLink(), true, `${when}: lstat still sees the link`);
  assert.equal(probe.fs.realpathSync(LINK), TARGET, `${when}: and it resolves to the target`);
}

/** A peer writes the target, and a barrier reports it. */
async function peerWrites(authority, probe, content) {
  authority.kfs.writeFile('home/user/app/target.txt', content);
  const written = authority.rawVfs.revision();
  await probe.resume();
  await until(() => globalThis.__nimbusVfsCursor.rev >= written, 'the barrier applied the peer write');
}

await runScenarios(import.meta.path, {
  async 'a sync write through a symlink is the target\'s, at once and after it lands'() {
    const { authority, probe } = await boot();
    probe.fs.writeFileSync(LINK, 'mine');
    assert.equal(probe.read(TARGET), 'mine', 'the target holds the write at once');
    assert.equal(probe.read(LINK), 'mine');
    assertLink(probe, 'parked');
    await probe.fs.promises.writeFile(LINK, 'mine2');
    assert.equal(authority.read('home/user/app/target.txt'), 'mine2', 'the authority wrote the target');
    assertLink(probe, 'flushed');
    await probe.resume();
    assertLink(probe, 'after a barrier');
    await peerWrites(authority, probe, 'peer');
    assert.equal(probe.read(LINK), 'peer', 'a later write to the target is what the link reads');
    assert.equal(probe.read(TARGET), 'peer');
  },

  async 'an append through a symlink appends to the target'() {
    const { authority, probe } = await boot();
    assert.equal(probe.read(TARGET), 'old', 'the boot fill holds the target');
    probe.fs.appendFileSync(LINK, '+1');
    assert.equal(probe.read(TARGET), 'old+1');
    await probe.fs.promises.appendFile(LINK, '+2');
    assert.equal(authority.read('home/user/app/target.txt'), 'old+1+2');
    assertLink(probe, 'appended');
  },

  async 'a write through a dangling symlink creates the file it names'() {
    const { authority, probe } = await boot((seeded) => seeded.kfs.symlink('missing.txt', 'home/user/app/dangling.txt'));
    await probe.fs.promises.writeFile(`${APP}/dangling.txt`, 'made');
    assert.equal(authority.read('home/user/app/missing.txt'), 'made');
    assert.equal(probe.read(`${APP}/missing.txt`), 'made', 'the sync view holds it under the name it was made at');
    assert.equal(probe.fs.lstatSync(`${APP}/dangling.txt`).isSymbolicLink(), true);
  },

  async 'a write through a linked directory lands in the directory it names'() {
    const { authority, probe } = await boot((seeded) => {
      seeded.kfs.mkdir('home/user/app/real', { recursive: true, mode: 0o755 });
      seeded.kfs.symlink('real', 'home/user/app/alias');
    });
    probe.fs.writeFileSync(`${APP}/alias/x.txt`, 'x');
    assert.equal(probe.read(`${APP}/real/x.txt`), 'x', 'the real directory holds it at once');
    await probe.fs.promises.writeFile(`${APP}/alias/x.txt`, 'x2');
    assert.equal(authority.read('home/user/app/real/x.txt'), 'x2');
    assert.equal(probe.fs.lstatSync(`${APP}/alias`).isSymbolicLink(), true);
  },

  async 'an async read through a symlink holds bytes a later write to the target replaces'() {
    const { authority, probe } = await boot();
    assert.equal(await probe.fs.promises.readFile(LINK, 'utf8'), 'old');
    await peerWrites(authority, probe, 'peer');
    assert.equal(probe.read(LINK), 'peer');
    assertLink(probe, 'after the read');
  },

  async 'a descriptor opened through a symlink writes the target'() {
    const { authority, probe } = await boot((seeded) => seeded.kfs.symlink('missing.txt', 'home/user/app/dangling.txt'));
    const fd = probe.fs.openSync(LINK, 'w');
    probe.fs.writeSync(fd, 'by fd');
    probe.fs.closeSync(fd);
    assert.equal(probe.read(TARGET), 'by fd');
    const handle = await probe.fs.promises.open(LINK, 'w');
    await handle.writeFile('by handle');
    await handle.close();
    assert.equal(authority.read('home/user/app/target.txt'), 'by handle');
    assertLink(probe, 'after the handle');
    assert.throws(() => probe.fs.openSync(`${APP}/dangling.txt`, 'wx'), { code: 'EEXIST' }, 'O_EXCL does not follow a dangling link');
  },

  async 'a write through a symlink loop is ELOOP'() {
    const { probe } = await boot((seeded) => {
      seeded.kfs.symlink('loop-b', 'home/user/app/loop-a');
      seeded.kfs.symlink('loop-a', 'home/user/app/loop-b');
    });
    assert.throws(() => probe.fs.writeFileSync(`${APP}/loop-a`, 'x'), { code: 'ELOOP' });
  },
});
