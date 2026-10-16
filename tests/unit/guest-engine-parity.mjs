#!/usr/bin/env bun
// The guest filesystem engines' parity ledger (VFS-9 B, stage 1): every
// behaviour either engine has that a process's guest can see, written once
// (lib/guest-engines.mjs) and run against both, the node shim's and the WASI
// holder's. Where an engine lacks one, the ledger says so (GAPS), and the run
// must fail showing it: so the ledger is the specification both engines are
// held to, and exactly what each lacks. An engine that gains a behaviour
// fails its gap until the gap is removed.
//
// The families:
//   - decided in a held subtree: answered with the session's waves stalled,
//     the session holding the change once they are not;
//   - judged by the session's rules where decided (core vfs/posix-access);
//   - waves: what the process answered lingers, and goes with the next change
//     it awaits;
//   - descriptors: an open description stays on the file it opened;
//   - the namespace unavailable: what this view cannot judge is the session's;
//   - the end of a process: its log holds what it answered.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { LINGER_MS } from '../../packages/core/src/_shared/process-fs-client.ts';
import { runScenarios, sleep, until } from './lib/resident-body.mjs';
import { APP, answeredAtOnce, ledgerScenarios, stat } from './lib/guest-engines.mjs';

const OUT = `${APP}/out`;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** What the session holds at `path` now, read as its own store reads it (no recall); undefined where nothing is. */
function sessionText(e, path) {
  try { return e.authority.read(path.slice(1)); } catch { return undefined; }
}

/** Whether the session holds a name at `path` now, read as its own store reads it (no recall). */
function sessionHas(e, path) {
  try { e.authority.kfs.stat(path.slice(1)); return true; } catch { return false; }
}

/** The change `work` makes is answered with the session's waves stalled, and the session has it once they go. */
async function decided(e, work, landed) {
  e.stall();
  const pending = work();
  const answered = await answeredAtOnce(pending);
  await e.release();
  assert.equal(answered, 'answered', 'not answered with the session stalled: not decided in the held subtree');
  await pending;
  await landed();
}

const SCENARIOS = {
  // ── Decided in a held subtree ──────────────────────────────────────────
  async 'a file made in a held subtree is answered at once, and numbered as the process saw it'(e) {
    await e.hold(OUT);
    await decided(e, () => e.write(`${OUT}/made.txt`, 'MADE'), async () => {
      const seen = await e.stat(`${OUT}/made.txt`);
      assert.equal(await e.peerText(`${OUT}/made.txt`), 'MADE');
      assert.equal((await e.peerStat(`${OUT}/made.txt`)).ino, seen.ino, 'the session numbered it otherwise');
    });
  },
  async 'a directory made in a held subtree is answered at once'(e) {
    await e.hold(OUT);
    await decided(e, () => e.fs.mkdir(`${OUT}/sub`, { mode: 0o750 }), async () => {
      assert.equal((await e.peerStat(`${OUT}/sub`)).mode, 0o750);
    });
  },
  async 'an unlink and a file\'s rename in a held subtree are answered at once'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/gone.txt`, 'G');
    await e.write(`${OUT}/moved.txt`, 'M');
    await decided(e, () => Promise.all([e.fs.unlink(`${OUT}/gone.txt`), e.fs.rename(`${OUT}/moved.txt`, `${OUT}/there.txt`)]), async () => {
      await assert.rejects(e.authority.peer.stat('home/user/app/out/gone.txt'), { code: 'ENOENT' });
      assert.equal(await e.peerText(`${OUT}/there.txt`), 'M');
    });
  },
  async 'a chmod in a held subtree is answered at once, and the process sees it'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/m.txt`, 'm');
    await decided(e, () => e.fs.chmod(`${OUT}/m.txt`, 0o600), async () => {
      assert.equal((await e.stat(`${OUT}/m.txt`)).mode, 0o600);
      assert.equal((await e.peerStat(`${OUT}/m.txt`)).mode, 0o600);
    });
  },
  async 'a utimes in a held subtree is answered at once'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/t.txt`, 't');
    await decided(e, () => e.fs.utimes(`${OUT}/t.txt`, 5_000, 7_000), async () => {
      assert.equal((await e.stat(`${OUT}/t.txt`)).mtimeMs, 7_000);
      assert.equal((await e.peerStat(`${OUT}/t.txt`)).mtimeMs, 7_000);
    });
  },
  async 'a chown of the process\'s own file in a held subtree is answered at once'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/o.txt`, 'o');
    await decided(e, () => e.fs.chown(`${OUT}/o.txt`, 1000, 1000), async () => {
      assert.equal((await e.peerStat(`${OUT}/o.txt`)).uid, 1000);
    });
  },
  async 'a copy of the process\'s own unanswered write is answered at once, with its bytes and its mode'(e) {
    await e.hold(OUT);
    e.stall();
    await e.write(`${OUT}/src.txt`, 'SOURCE', 0o640);
    const copied = await answeredAtOnce(e.fs.copyFile(`${OUT}/src.txt`, `${OUT}/dst.txt`));
    await e.release();
    assert.equal(copied, 'answered', 'not answered with the session stalled: not decided in the held subtree');
    assert.equal(await e.text(`${OUT}/dst.txt`), 'SOURCE');
    assert.equal(await e.peerText(`${OUT}/dst.txt`), 'SOURCE');
    assert.equal((await e.peerStat(`${OUT}/dst.txt`)).mode, 0o640);
  },
  async 'a copy of a held file the process did not write is answered once it has read it'(e) {
    await e.hold(OUT);
    await e.authority.peer.writeFile('home/user/app/out/theirs.txt', 'THEIRS');
    await e.hold(OUT);
    assert.equal(await e.text(`${OUT}/theirs.txt`), 'THEIRS');
    e.stall();
    const copied = await answeredAtOnce(e.fs.copyFile(`${OUT}/theirs.txt`, `${OUT}/copy.txt`));
    await e.release();
    assert.equal(copied, 'answered', 'not answered with the session stalled: not decided in the held subtree');
    assert.equal(await e.peerText(`${OUT}/copy.txt`), 'THEIRS');
  },
  async 'a decided copy is logged as what the destination became, in copyfile\'s order'(e) {
    await e.hold(OUT);
    e.stall();
    await e.write(`${OUT}/private.bin`, 'SECRET-BYTES', 0o600);
    await answeredAtOnce(e.fs.copyFile(`${OUT}/private.bin`, `${OUT}/copy.bin`));
    const entries = e.journal().entries();
    const open = entries.find(({ op }) => op.type === 'call' && op.call.call === 'open' && op.call.path === 'home/user/app/out/copy.bin');
    assert.ok(open, 'the copy is not logged as an open of its destination');
    assert.equal(open.op.call.fchmod, 0o600, 'the destination\'s open does not narrow it to the source\'s mode');
    await e.end('kill');
    assert.equal(await e.peerText(`${OUT}/copy.bin`), 'SECRET-BYTES');
    assert.equal((await e.peerStat(`${OUT}/copy.bin`)).mode, 0o600);
  },

  // ── Judged by the session's rules ──────────────────────────────────────
  async 'utimes of another\'s file is refused as the session refuses it'(e) {
    await e.hold(OUT);
    await e.authority.peerAs(CRED_KERNEL).writeFile('home/user/app/out/rootfile', 'R');
    await assert.rejects(e.fs.utimes(`${OUT}/rootfile`, 1_000, 1_000), { code: 'EPERM' });
  },
  async 'lchown judges the link itself, chown what it names'(e) {
    await e.hold(OUT);
    await e.authority.peerAs(CRED_KERNEL).writeFile('home/user/app/out/rootfile', 'R');
    await e.fs.symlink(`${OUT}/rootfile`, `${OUT}/mylink`);
    await e.fs.chown(`${OUT}/mylink`, 1000, 1000, { followSymlinks: false });
    await assert.rejects(e.fs.chown(`${OUT}/mylink`, 1000, 1000), { code: 'EPERM' });
  },
  async 'a chown by the owner clears the set-id bits, as the process sees it'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/setid`, 'x');
    await e.fs.chmod(`${OUT}/setid`, 0o4755);
    await e.fs.chown(`${OUT}/setid`, 1000, 1000);
    assert.equal((await e.stat(`${OUT}/setid`)).mode, 0o755, 'the set-id bits the session clears are still set in the process\'s view');
  },
  async 'a walk through a directory the process may not search is refused, the directories before a link too'(e) {
    await e.hold(OUT);
    await e.fs.mkdir(`${OUT}/blocked`, { mode: 0o755 });
    await e.fs.symlink(OUT, `${OUT}/blocked/escape`);
    await e.write(`${OUT}/victim`, 'V');
    await e.fs.chmod(`${OUT}/blocked`, 0o600);
    await assert.rejects(e.fs.unlink(`${OUT}/blocked/escape/victim`), { code: 'EACCES' });
    await e.fs.chmod(`${OUT}/blocked`, 0o755);
    assert.equal(await e.peerText(`${OUT}/victim`), 'V');
  },
  async 'a name under a file is ENOTDIR, a looping link ELOOP'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/plain`, 'p');
    await assert.rejects(e.fs.mkdir(`${OUT}/plain/sub`), { code: 'ENOTDIR' });
    await e.fs.symlink('loop', `${OUT}/loop`);
    await assert.rejects(e.fs.unlink(`${OUT}/loop/x`), { code: 'ELOOP' });
  },
  async 'a call through a link to outside the held subtree waits for the session'(e) {
    await e.hold(OUT);
    await e.authority.peer.mkdir('home/user/elsewhere');
    await e.authority.peer.writeFile('home/user/elsewhere/a.txt', 'A');
    await e.fs.symlink('/home/user/elsewhere', `${OUT}/alias`);
    await sleep(LINGER_MS * 2);
    e.stall();
    const unlink = e.fs.unlink(`${OUT}/alias/a.txt`);
    assert.equal(await answeredAtOnce(unlink), 'waiting', 'decided here through a link out of the held subtree');
    await e.release();
    await unlink;
    await assert.rejects(e.authority.peer.stat('home/user/elsewhere/a.txt'), { code: 'ENOENT' });
  },

  // ── Waves ───────────────────────────────────────────────────────────────
  async 'an answered change goes with the next change the process awaits, in one wave'(e) {
    await e.authority.peer.mkdir('home/user/other');
    await e.hold(OUT);
    await e.write(`${OUT}/w.txt`, 'w');
    await sleep(LINGER_MS * 4);
    const before = e.waves();
    await e.write(`${OUT}/w2.txt`, 'w2');
    assert.equal(e.held('/home/user/other/d'), false);
    await e.fs.mkdir('/home/user/other/d');
    assert.equal(e.waves() - before, 1, 'the answered change went alone, ahead of the awaited one');
  },
  async 'the session hears an answered change within the linger, unasked'(e) {
    await e.hold(OUT);
    const heard = [];
    const stop = e.authority.files.vfs.watchChanges('/home/user/app/out', (events) => { for (const event of events) heard.push(event.path); });
    await e.write(`${OUT}/told.txt`, 'told');
    await until(() => heard.some((path) => path.endsWith('/told.txt')), 'the session heard the write', LINGER_MS + 500);
    stop();
  },
  async 'awaited chmods alone take the subtree they change'(e) {
    await e.authority.peer.mkdir('home/user/app/modes');
    for (let i = 0; i < 12; i++) await e.authority.peer.writeFile(`home/user/app/modes/f${i}`, 'm');
    await e.fs.readdir(`${APP}/modes`);
    for (let i = 0; i < 12; i++) await e.fs.chmod(`${APP}/modes/f${i}`, 0o600);
    await until(() => e.held(`${APP}/modes/x`), 'the chmods took their subtree', 5_000);
  },

  // ── Synchronous calls: answered now, from what the process holds ──────
  async 'a synchronous write in a held subtree is answered at once, and read back at once'(e) {
    await e.hold(OUT);
    await e.fs.readdir(OUT);
    e.stall();
    const written = e.sync.writeFile(`${OUT}/sync.txt`, enc.encode('SYNC'));
    assert.ok(!(written instanceof Promise), 'a synchronous write began a wait');
    assert.equal(dec.decode(e.sync.readFile(`${OUT}/sync.txt`)), 'SYNC');
    assert.equal(stat(e.sync.stat(`${OUT}/sync.txt`)).size, 4);
    await e.release();
    assert.equal(await e.peerText(`${OUT}/sync.txt`), 'SYNC');
  },
  async 'synchronous mkdir, rename, chmod and unlink in a held subtree are answered at once'(e) {
    await e.hold(OUT);
    await e.fs.readdir(OUT);
    e.stall();
    e.sync.mkdir(`${OUT}/d`, { mode: 0o750 });
    e.sync.writeFile(`${OUT}/a.txt`, enc.encode('A'));
    e.sync.rename(`${OUT}/a.txt`, `${OUT}/d/b.txt`);
    e.sync.chmod(`${OUT}/d/b.txt`, 0o600);
    assert.equal(stat(e.sync.stat(`${OUT}/d/b.txt`)).mode, 0o600);
    assert.equal(e.sync.stat(`${OUT}/a.txt`), null);
    e.sync.writeFile(`${OUT}/gone.txt`, enc.encode('G'));
    e.sync.unlink(`${OUT}/gone.txt`);
    assert.equal(e.sync.stat(`${OUT}/gone.txt`), null);
    await e.release();
    assert.equal((await e.peerStat(`${OUT}/d`)).mode, 0o750);
    assert.equal(await e.peerText(`${OUT}/d/b.txt`), 'A');
    assert.equal((await e.peerStat(`${OUT}/d/b.txt`)).mode, 0o600);
    assert.equal(await e.peerStat(`${OUT}/gone.txt`), null);
  },

  async 'a synchronous write outside a held subtree is answered at once, seen by name, and lands'(e) {
    await e.fs.readdir(APP);
    e.stall();
    e.sync.writeFile(`${APP}/p.txt`, enc.encode('PROVISIONAL'));
    assert.equal(dec.decode(e.sync.readFile(`${APP}/p.txt`)), 'PROVISIONAL');
    assert.equal(stat(e.sync.stat(`${APP}/p.txt`)).size, 11);
    await e.release();
    await until(() => sessionText(e, `${APP}/p.txt`) === 'PROVISIONAL', 'the session has the write');
  },
  async 'synchronous mkdir -p, rename, chmod, symlink, rmdir and unlink outside a held subtree are answered at once, and land'(e) {
    await e.fs.readdir(APP);
    e.stall();
    e.sync.mkdir(`${APP}/p/q`, { recursive: true, mode: 0o750 });
    e.sync.writeFile(`${APP}/p/q/a.txt`, enc.encode('A'));
    e.sync.rename(`${APP}/p/q/a.txt`, `${APP}/p/b.txt`);
    e.sync.chmod(`${APP}/p/b.txt`, 0o600);
    e.sync.symlink('b.txt', `${APP}/p/link`);
    e.sync.mkdir(`${APP}/p/empty`);
    e.sync.rmdir(`${APP}/p/empty`);
    e.sync.writeFile(`${APP}/p/gone.txt`, enc.encode('G'));
    e.sync.unlink(`${APP}/p/gone.txt`);
    assert.equal(stat(e.sync.stat(`${APP}/p/q`)).type, 'directory');
    assert.equal(stat(e.sync.stat(`${APP}/p/b.txt`)).mode, 0o600);
    assert.equal(e.sync.readlink(`${APP}/p/link`), 'b.txt');
    assert.equal(e.sync.stat(`${APP}/p/empty`), null);
    assert.equal(e.sync.stat(`${APP}/p/gone.txt`), null);
    assert.equal(e.sync.stat(`${APP}/p/q/a.txt`), null);
    await e.release();
    await until(() => sessionText(e, `${APP}/p/b.txt`) === 'A', 'the session has the rename');
    await until(() => sessionText(e, `${APP}/p/gone.txt`) === undefined, 'the session has the unlink');
    assert.equal((await e.peerStat(`${APP}/p/q`)).mode, 0o750);
    assert.equal((await e.peerStat(`${APP}/p/b.txt`)).mode, 0o600);
    assert.equal(await e.authority.peer.readlink(`${APP.slice(1)}/p/link`), 'b.txt');
    await until(() => !sessionHas(e, `${APP}/p/empty`), 'the session has the rmdir');
  },
  async 'a synchronous change is seen until the view has the session\'s, and the session\'s after'(e) {
    await e.fs.readdir(APP);
    e.sync.writeFile(`${APP}/r.txt`, enc.encode('MINE'));
    await until(() => sessionText(e, `${APP}/r.txt`) === 'MINE', 'the session has the write');
    // Answered, and no barrier since: the view is the process's own still.
    assert.equal(dec.decode(e.sync.readFile(`${APP}/r.txt`)), 'MINE');
    assert.equal(dec.decode(await e.fs.readFile(`${APP}/r.txt`)), 'MINE');
    // Retired: a peer's change is the view's once a barrier brings it.
    await e.authority.peer.writeFile(`${APP.slice(1)}/r.txt`, 'THEIRS');
    await until(() => sessionText(e, `${APP}/r.txt`) === 'THEIRS', 'the peer\'s write');
    e.fs.inbound?.();
    assert.equal(dec.decode(await e.fs.readFile(`${APP}/r.txt`)), 'THEIRS');
  },

  async 'what the session refused of a synchronous write is the next fsync\'s answer'(e) {
    e.authority.kfs.mkdir(`${APP.slice(1)}/locked`, { mode: 0o755 });
    await e.fs.readdir(APP);
    await e.fs.readdir(`${APP}/locked`);
    e.stall();
    e.sync.writeFile(`${APP}/locked/x.txt`, enc.encode('X'));
    // The session's directory changes before the write reaches it: it refuses it.
    await e.authority.peer.chmod(`${APP.slice(1)}/locked`, 0o555);
    await e.release();
    const fd = e.sync.open(`${APP}/other.txt`, { write: true, create: true, truncate: true, mode: 0o644 }).id;
    let refused;
    await until(() => {
      try { e.sync.fsync(fd); return false; } catch (error) { refused = error; return true; }
    }, 'the refusal reported');
    assert.equal(refused.code, 'EACCES', refused.message);
    e.sync.close(fd);
    assert.equal(sessionText(e, `${APP}/locked/x.txt`), undefined);
  },

  // ── Descriptors ────────────────────────────────────────────────────────
  async 'an open description reads the file it opened after its name is unlinked'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/kept.txt`, 'KEPT');
    const opened = await e.fs.open(`${OUT}/kept.txt`, { read: true });
    await e.fs.unlink(`${OUT}/kept.txt`);
    await e.write(`${OUT}/kept.txt`, 'REPLACEMENT');
    assert.equal(new TextDecoder().decode(await e.fs.read(opened.id, 0, 64)), 'KEPT', 'the description read the name\'s new file');
    await e.fs.close(opened.id);
  },
  async 'a description writes the file it opened after its name is renamed'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/before.txt`, '');
    const opened = await e.fs.open(`${OUT}/before.txt`, { write: true });
    await e.fs.rename(`${OUT}/before.txt`, `${OUT}/after.txt`);
    await e.fs.write(opened.id, 0, enc.encode('FOLLOWED'));
    await e.fs.close(opened.id);
    assert.equal(await e.text(`${OUT}/after.txt`), 'FOLLOWED', 'the write did not reach the renamed file');
    assert.equal(await e.stat(`${OUT}/before.txt`), null);
  },
  async 'fstat of a description whose file lost its name says so'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/orphan.txt`, 'O');
    const opened = await e.fs.open(`${OUT}/orphan.txt`, { read: true });
    await e.fs.unlink(`${OUT}/orphan.txt`);
    assert.equal(Number((await e.fs.fstat(opened.id)).nlink), 0, 'fstat answered for a name, not the open file');
    await e.fs.close(opened.id);
  },

  async 'fchmod, fchown and futimes change the file a description opened after its name is unlinked and taken'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/orphan.txt`, 'O');
    const opened = await e.fs.open(`${OUT}/orphan.txt`, { write: true });
    await e.fs.unlink(`${OUT}/orphan.txt`);
    await e.write(`${OUT}/orphan.txt`, 'TAKEN');
    const taken = await e.peerStat(`${OUT}/orphan.txt`);
    await e.fs.fchmod(opened.id, 0o600);
    await e.fs.fchown(opened.id, 1000, 1000);
    await e.fs.futimes(opened.id, 5_000, 7_000);
    const own = stat(await e.fs.fstat(opened.id));
    assert.deepEqual([own.mode, own.mtimeMs], [0o600, 7_000], 'the description\'s own file did not change as asked');
    await e.fs.close(opened.id);
    const now = await e.peerStat(`${OUT}/orphan.txt`);
    assert.deepEqual([now.mode, now.mtimeMs], [taken.mode, taken.mtimeMs], 'the file that took the name changed');
  },
  async 'fchmod of a file whose name is gone is judged as the session judges a description: a confined principal grants nothing'(e) {
    // Confined (as a private /tmp principal is): it may narrow its own
    // triad, never grant group or other bits or a set-id bit.
    e.authority.rawVfs.confinePrincipal(1000, 'tmp/1000');
    await e.hold(OUT);
    // Made by this open (decided where the process holds the subtree), its name gone.
    const opened = await e.fs.open(`${OUT}/orphan.txt`, { write: true, create: true, truncate: true, mode: 0o644 });
    await e.fs.write(opened.id, null, enc.encode('O'));
    await e.fs.unlink(`${OUT}/orphan.txt`);
    await e.fs.fchmod(opened.id, 0o600);
    await assert.rejects(e.fs.fchmod(opened.id, 0o640), { code: 'EPERM' }, 'a group bit granted');
    await assert.rejects(e.fs.fchmod(opened.id, 0o4600), { code: 'EPERM' }, 'a set-id bit granted');
    assert.equal(stat(await e.fs.fstat(opened.id)).mode, 0o600);
    await e.fs.close(opened.id);
  },
  async 'fchmod, fchown and futimes change the file a description opened after its name is renamed'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/before.txt`, 'B');
    const opened = await e.fs.open(`${OUT}/before.txt`, { write: true });
    await e.fs.rename(`${OUT}/before.txt`, `${OUT}/after.txt`);
    await e.fs.fchmod(opened.id, 0o640);
    await e.fs.fchown(opened.id, 1000, 1000);
    await e.fs.futimes(opened.id, 5_000, 9_000);
    await e.fs.close(opened.id);
    const moved = await e.peerStat(`${OUT}/after.txt`);
    assert.deepEqual([moved.mode, moved.mtimeMs], [0o640, 9_000], 'the renamed file did not change as asked');
  },

  async 'fchmod, fchown and futimes through the session\'s description change the file it opened, not the name\'s'(e) {
    await e.write(`${APP}/through.txt`, 'T');
    const opened = await e.fs.open(`${APP}/through.txt`, { write: true });
    await e.fs.write(opened.id, 0, enc.encode('THROUGH'));
    await e.fs.rename(`${APP}/through.txt`, `${APP}/moved.txt`);
    await e.write(`${APP}/through.txt`, 'TAKEN');
    await e.fs.fsync();
    const taken = await e.peerStat(`${APP}/through.txt`);
    await e.fs.fchmod(opened.id, 0o640);
    await e.fs.fchown(opened.id, 1000, 1000);
    await e.fs.futimes(opened.id, 5_000, 11_000);
    const own = stat(await e.fs.fstat(opened.id));
    assert.deepEqual([own.mode, own.mtimeMs], [0o640, 11_000], 'fstat did not say what the description\'s file became');
    await e.fs.close(opened.id);
    const moved = await e.peerStat(`${APP}/moved.txt`);
    assert.deepEqual([moved.mode, moved.mtimeMs], [0o640, 11_000], 'the opened file did not change as asked');
    const now = await e.peerStat(`${APP}/through.txt`);
    assert.deepEqual([now.mode, now.mtimeMs], [taken.mode, taken.mtimeMs], 'the file that took the name changed');
  },

  // ── The namespace unavailable ──────────────────────────────────────────
  async 'with the namespace unavailable, a chmod is the session\'s, not refused'(e) {
    await e.hold(OUT);
    await e.write(`${OUT}/n.txt`, 'n');
    await e.authority.peerAs(CRED_KERNEL).mkdir('home/user/app/locked', { mode: 0o700 });
    await e.authority.peerAs(CRED_KERNEL).chmod('home/user/app/locked', 0o755);
    e.failListings(true);
    await e.fs.stat(APP);
    await e.fs.chmod(`${OUT}/n.txt`, 0o640);
    e.failListings(false);
    assert.equal((await e.peerStat(`${OUT}/n.txt`)).mode, 0o640);
  },

  // ── The end of a process ──────────────────────────────────────────────
  async 'what the process logged and the session never answered lands when the session kills it'(e) {
    await e.hold(OUT);
    e.stall();
    await e.write(`${OUT}/last.txt`, 'LAST');
    // The next file it makes logs this one's bytes first (the session does not answer).
    await e.write(`${OUT}/next.txt`, 'NEXT');
    await e.end('kill');
    assert.equal(await e.peerText(`${OUT}/last.txt`), 'LAST');
    assert.doesNotMatch(e.authority.host.processes.allLogs(e.log.pid).map((log) => log.data).join(''), /refused/);
  },
  async 'what the process logged and the session never answered lands when it exits'(e) {
    await e.hold(OUT);
    e.stall();
    await e.write(`${OUT}/last.txt`, 'LAST');
    await e.write(`${OUT}/next.txt`, 'NEXT');
    await e.end('exit');
    assert.equal(await e.peerText(`${OUT}/last.txt`), 'LAST');
  },
  async 'two drains of the process\'s log at once land each of its appends once'(e) {
    await e.write(`${APP}/log.txt`, '');
    const opened = await e.fs.open(`${APP}/log.txt`, { write: true, append: true });
    await e.fs.write(opened.id, null, enc.encode('a'));
    e.stall();
    // Logged, and never answered.
    for (const piece of ['b', 'c']) e.fs.write(opened.id, null, enc.encode(piece)).catch(() => {});
    await sleep(LINGER_MS * 4);
    await e.end('kill', { twice: true });
    assert.equal(await e.peerText(`${APP}/log.txt`), 'abc', 'an append landed twice, or not at all');
  },
  async 'what the process was told it wrote lands when the session kills it at once'(e) {
    await e.hold(OUT);
    e.stall();
    await e.write(`${OUT}/last.txt`, 'LAST');
    await e.end('kill');
    assert.equal(await e.peerText(`${OUT}/last.txt`), 'LAST');
  },
  async 'what the process was told it wrote lands when its waves are refused as the session kills it'(e) {
    await e.hold(OUT);
    e.stall();
    const before = e.waves();
    await e.write(`${OUT}/sent.txt`, 'SENT');
    await until(() => e.waves() > before, 'its wave on its way');
    await e.write(`${OUT}/held.txt`, 'HELD');
    await e.end('kill', { refused: true });
    assert.equal(await e.peerText(`${OUT}/sent.txt`), 'SENT', 'a change on its way when the process ended was lost');
    assert.equal(await e.peerText(`${OUT}/held.txt`), 'HELD', 'a change not yet sent when the process ended was lost');
  },
};

/** What each engine lacks today: each must fail, showing what it lacks. */
const PATH_FDS = 'descriptors on the open file, not on its name';
const GAPS = {
  'a copy of a held file the process did not write is answered once it has read it [node]': { lacks: 'decided copies of a file it read', shows: 'not decided in the held subtree' },
  'a name under a file is ENOTDIR, a looping link ELOOP [node]': { lacks: 'ENOTDIR for a name under a file it made, decided in a held subtree', shows: 'Missing expected rejection' },
  'an open description reads the file it opened after its name is unlinked [node]': { lacks: PATH_FDS, shows: 'the description read the name\'s new file' },
  'a description writes the file it opened after its name is renamed [node]': { lacks: PATH_FDS, shows: 'the write did not reach the renamed file' },
  'fstat of a description whose file lost its name says so [node]': { lacks: PATH_FDS, shows: 'ENOENT' },
  'fchmod, fchown and futimes change the file a description opened after its name is unlinked and taken [node]': { lacks: PATH_FDS, shows: 'the file that took the name changed' },
  'fchmod, fchown and futimes change the file a description opened after its name is renamed [node]': { lacks: PATH_FDS, shows: 'ENOENT' },
  'fchmod of a file whose name is gone is judged as the session judges a description: a confined principal grants nothing [node]': { lacks: PATH_FDS, shows: 'ENOENT' },
  'fchmod, fchown and futimes through the session\'s description change the file it opened, not the name\'s [node]': { lacks: PATH_FDS, shows: 'the opened file did not change as asked' },
};

await runScenarios(import.meta.path, ledgerScenarios(SCENARIOS), { gaps: GAPS });
