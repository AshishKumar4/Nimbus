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

/** \`overrides\` may be a function of the session's own answer to an op (facetSupervisor's \`forward\`). */
async function boot(seed, overrides = {}) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/target.txt', 'old');
  authority.kfs.symlink('target.txt', 'home/user/app/link.txt');
  seed?.(authority);
  authority.kfs.writeFile('home/user/app/f.txt', 'f');
  let forward;
  const handle = facetSupervisor(authority, typeof overrides === 'function' ? overrides((name, args) => forward(name, args)) : overrides);
  forward = handle.forward;
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

  async 'an async read through a link a peer retargeted reads the new target'() {
    const { authority, probe } = await boot((seeded) => seeded.kfs.writeFile('home/user/app/other.txt', 'other'));
    authority.kfs.unlink('home/user/app/link.txt');
    authority.kfs.symlink('other.txt', 'home/user/app/link.txt');
    assert.equal(await probe.fs.promises.readFile(LINK, 'utf8'), 'other', 'the authority resolves the link as it is now');
    assert.equal(probe.read(LINK), 'other');
    assert.equal(probe.read(TARGET), 'old', 'the old target keeps its own bytes');
  },

  async 'a link retargeted between a read\'s barrier and the read leaves the old target\'s bytes alone'() {
    let retarget = null;
    const { authority, probe } = await boot((seeded) => seeded.kfs.writeFile('home/user/app/other.txt', 'other'), (forward) => ({
      fsReadBatch: async (...args) => {
        retarget?.();
        retarget = null;
        return forward('fsReadBatch', args);
      },
    }));
    assert.equal(probe.read(TARGET), 'old', 'the boot fill holds the target');
    retarget = () => {
      authority.kfs.unlink('home/user/app/link.txt');
      authority.kfs.symlink('other.txt', 'home/user/app/link.txt');
    };
    assert.equal(await probe.fs.promises.readFile(LINK, 'utf8'), 'other', 'the read is the authority\'s');
    assert.equal(probe.read(LINK), 'other', 'the sync view through the link is as new as the read');
    assert.equal(probe.read(TARGET), 'old', 'the old target still holds its own bytes');
    await probe.resume();
    assert.equal(await probe.fs.promises.readFile(TARGET, 'utf8'), 'old');
    assert.equal(probe.read(TARGET), 'old');
  },

  async 'a session that does not name the file a read reached installs nothing read through a link'() {
    let retarget = null;
    const { authority, probe } = await boot((seeded) => seeded.kfs.writeFile('home/user/app/other.txt', 'other'), (forward) => ({
      fsReadBatch: async (...args) => {
        retarget?.();
        retarget = null;
        return (await forward('fsReadBatch', args)).map(({ path, ...entry }) => entry);
      },
    }));
    assert.equal(probe.read(TARGET), 'old', 'the boot fill holds the target');
    retarget = () => {
      authority.kfs.unlink('home/user/app/link.txt');
      authority.kfs.symlink('other.txt', 'home/user/app/link.txt');
    };
    assert.equal(await probe.fs.promises.readFile(LINK, 'utf8'), 'other');
    assert.equal(probe.read(TARGET), 'old', 'the old target keeps its own bytes');
  },

  async 'a target written between a read\'s barrier and the read is what the link reads after it'() {
    let write = null;
    const { authority, probe } = await boot(undefined, (forward) => ({
      fsReadBatch: async (...args) => {
        write?.();
        write = null;
        return forward('fsReadBatch', args);
      },
    }));
    assert.equal(probe.read(TARGET), 'old', 'the boot fill holds the target');
    write = () => authority.kfs.writeFile('home/user/app/target.txt', 'new');
    assert.equal(await probe.fs.promises.readFile(LINK, 'utf8'), 'new');
    assert.equal(probe.read(LINK), 'new', 'the sync view does not go back to the older bytes');
    assert.equal(probe.read(TARGET), 'new');
  },

  async 'a miss through a link is answered by a read of the link after the link changed'() {
    const { authority, probe } = await boot();
    authority.kfs.mkdir('home/user/elsewhere', { mode: 0o755 });
    authority.kfs.writeFile('home/user/elsewhere/a.txt', 'a');
    authority.kfs.writeFile('home/user/elsewhere/b.txt', 'b');
    authority.kfs.symlink('../elsewhere/a.txt', 'home/user/app/moving.txt');
    let made = authority.rawVfs.revision();
    await probe.resume();
    await until(() => globalThis.__nimbusVfsCursor.rev >= made, 'the barrier listed the link');
    assert.equal(probe.read(`${APP}/moving.txt`), 'ERR:EAGAIN', 'a.txt is not resident');
    authority.kfs.unlink('home/user/app/moving.txt');
    authority.kfs.symlink('../elsewhere/b.txt', 'home/user/app/moving.txt');
    made = authority.rawVfs.revision();
    await probe.resume();
    await until(() => globalThis.__nimbusVfsCursor.rev >= made, 'the barrier reported the new link');
    assert.equal(await probe.fs.promises.readFile(`${APP}/moving.txt`, 'utf8'), 'b');
    assert.deepEqual([...globalThis.__nimbusVfsResidencyMisses], [], 'the access that missed was answered');
  },

  async 'a pending mode through a link reaches the authority before a stat of it'() {
    const { authority, probe } = await boot();
    probe.fs.chmodSync(LINK, 0o444);
    assert.equal(probe.fs.statSync(LINK).mode & 0o777, 0o444, 'the sync view has it at once');
    assert.equal((await probe.fs.promises.stat(LINK)).mode & 0o777, 0o444, 'the authority has it before it answers');
    assert.equal(authority.kfs.stat('home/user/app/target.txt').mode & 0o777, 0o444);
  },

  async 'an lstat of a link does not send the write parked under its target'() {
    const { authority, probe } = await boot();
    probe.fs.writeFileSync(LINK, 'parked');
    authority.kfs.chmod('home/user/app/target.txt', 0o444);
    assert.equal((await probe.fs.promises.lstat(LINK)).isSymbolicLink(), true);
    assert.equal(authority.read('home/user/app/target.txt'), 'old', 'the write is still parked');
  },

  async 'a link renamed and not yet reported resolves to its target'() {
    const { probe } = await boot();
    probe.fs.renameSync(LINK, `${APP}/moved-link.txt`);
    assert.equal(probe.fs.realpathSync(`${APP}/moved-link.txt`), TARGET);
  },

  async 'a mode change through a link waits for the write parked under the target'() {
    const { authority, probe } = await boot();
    probe.fs.writeFileSync(LINK, 'new');
    await probe.fs.promises.chmod(LINK, 0o444);
    assert.equal(authority.read('home/user/app/target.txt'), 'new', 'the write landed before the mode that forbids it');
    assert.equal(authority.kfs.stat('home/user/app/target.txt').mode & 0o777, 0o444);
    assert.equal(probe.fs.statSync(LINK).mode & 0o777, 0o444, 'the link stats with the target\'s mode');
    assertLink(probe, 'after the chmod');
  },

  async 'a stream through a link reads the write parked under the target'() {
    const { probe } = await boot();
    probe.fs.writeFileSync(LINK, 'streamed');
    const chunks = [];
    for await (const chunk of probe.fs.createReadStream(LINK)) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'streamed');
  },

  async 'a file made through a dangling link is there through the link at once'() {
    const { probe } = await boot((seeded) => {
      seeded.kfs.symlink('missing.txt', 'home/user/app/dangling.txt');
      seeded.kfs.symlink('missing2.txt', 'home/user/app/dangling2.txt');
    });
    probe.fs.writeFileSync(`${APP}/dangling.txt`, 'made');
    assert.equal(probe.read(`${APP}/dangling.txt`), 'made', 'read through the link');
    assert.equal(probe.fs.existsSync(`${APP}/dangling.txt`), true);
    assert.equal(probe.fs.statSync(`${APP}/dangling.txt`).size, 4);
    assert.equal(probe.fs.realpathSync(`${APP}/dangling.txt`), `${APP}/missing.txt`);
    const fd = probe.fs.openSync(`${APP}/dangling2.txt`, 'w', 0o600);
    probe.fs.closeSync(fd);
    assert.equal(probe.fs.statSync(`${APP}/dangling2.txt`).mode & 0o777, 0o600, 'open applies its mode through the link');
  },

  async 'a descriptor\'s miss through a link is answered by a read of the link'() {
    // The target is outside the process's tree, whose files a barrier brings.
    const { authority, probe } = await boot();
    authority.kfs.mkdir('home/user/elsewhere', { mode: 0o755 });
    authority.kfs.writeFile('home/user/elsewhere/late.txt', 'late');
    authority.kfs.symlink('../elsewhere/late.txt', 'home/user/app/late-link.txt');
    const made = authority.rawVfs.revision();
    await probe.resume();
    await until(() => globalThis.__nimbusVfsCursor.rev >= made, 'the barrier listed the late file and link');
    const fd = probe.fs.openSync(`${APP}/late-link.txt`, 'r');
    assert.throws(() => probe.fs.readSync(fd, Buffer.alloc(4), 0, 4, 0), { code: 'EAGAIN' }, 'the late file is not resident');
    probe.fs.closeSync(fd);
    assert.equal(await probe.fs.promises.readFile(`${APP}/late-link.txt`, 'utf8'), 'late');
    assert.deepEqual([...globalThis.__nimbusVfsResidencyMisses], [], 'no miss is left to fail the run');
  },

  async 'a write through a symlink loop is ELOOP'() {
    const { probe } = await boot((seeded) => {
      seeded.kfs.symlink('loop-b', 'home/user/app/loop-a');
      seeded.kfs.symlink('loop-a', 'home/user/app/loop-b');
    });
    assert.throws(() => probe.fs.writeFileSync(`${APP}/loop-a`, 'x'), { code: 'ELOOP' });
  },
});
