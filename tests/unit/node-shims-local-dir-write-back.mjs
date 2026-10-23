#!/usr/bin/env bun
// Behavior test: a directory this facet created with mkdirSync must exist at
// the authority before anything is written into it.
//
// mkdirSync is a sync syscall, so it cannot make an RPC; it records the
// directory in the facet's sync view and nothing more. The write-back path
// then flushed only the FILE, never the local-only directories above it.
//
// RED on the pre-fix build: supervisor.writeFile creates missing parents
// implicitly, so writeFileSync into a fresh mkdirSync tree happened to work
// and hid the gap. An append and a truncate do not, so an appendFileSync log
// inside that tree failed with `ENOENT: <parent dir>` out of
// __nimbusPersistVfsWrite, and the file never reached the authority at all —
// which is how `opencode run` and `opencode --help` exited 1 on their own
// log directory.
//
// Each case is a process of its own over the real session (runScenarios).

import assert from 'node:assert/strict';
import { createAuthority, runScenarios } from './lib/resident-body.mjs';
import { observeWaves, shimsOnSession } from './lib/shims-on-session.mjs';

const key = (path) => path.replace(/^\/+/, '');

/**
 * A process over a new session, whose mkdir calls reach the session as
 * records: each directory it names is pushed to `mkdirs`. `seed` makes what
 * the session holds before the process starts (its listing).
 */
function facetRecording(mkdirs, seed = () => {}) {
  const authority = createAuthority();
  seed(authority);
  const shims = shimsOnSession({
    authority,
    overrides: (forward) => ({
      writeBatchStream: observeWaves(forward, (record) => {
        if (record.type === 'call' && record.call.call === 'mkdir') mkdirs.push(key(record.call.path));
      }),
    }),
  });
  return { authority, ...shims };
}

const scenarios = {
  // ── the opencode shape: mkdirSync -p a log tree, append to it, reopen 'w' ───
  async 'a log tree made with mkdirSync, appended, and reopened for writing reaches the session'() {
    const authority = createAuthority();
    const { fs } = shimsOnSession({ authority });
    const dir = '/home/user/.local/share/opencode/log';
    const log = `${dir}/session.log`;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(log, 'first line\n');

    const handle = await fs.promises.open(log, 'w');
    await handle.close();

    assert.equal(
      authority.kfs.kind(dir),
      'directory',
      'every mkdirSync ancestor reached the authority',
    );
    assert.equal(
      authority.kfs.readFileString(log),
      '',
      "opening 'w' truncated the appended log at the authority",
    );
  },

  // ── an append into a local-only directory persists its own bytes ───────────
  async 'an append into a local-only directory persists its own bytes'() {
    const authority = createAuthority();
    const { fs } = shimsOnSession({ authority });
    fs.mkdirSync('/home/user/logdir', { recursive: true });
    fs.appendFileSync('/home/user/logdir/a.log', 'hello');
    await fs.promises.appendFile('/home/user/logdir/a.log', ' world');

    assert.equal(
      authority.kfs.readFileString('/home/user/logdir/a.log'),
      'hello world',
      'the append ledger reached the authority through a mkdirSync-only parent',
    );
  },

  // ── truncate reaches an append-ledger file under a local-only directory ────
  async 'a truncate reaches an appended file under a local-only directory'() {
    const authority = createAuthority();
    const { fs } = shimsOnSession({ authority });
    fs.mkdirSync('/home/user/deep/nested/tree', { recursive: true });
    fs.appendFileSync('/home/user/deep/nested/tree/x.log', 'abcdefghij');
    await fs.promises.truncate('/home/user/deep/nested/tree/x.log', 4);

    assert.equal(
      authority.kfs.readFileString('/home/user/deep/nested/tree/x.log'),
      'abcd',
      'fsTruncate found the file the append ledger created',
    );
  },

  // ── the directory keeps the mode mkdirSync asked for, not an implicit one ──
  // The authority creating parents on the caller's behalf is what masked this
  // bug; a directory the facet declared must arrive as the facet declared it.
  async 'a directory declared with mkdirSync arrives as declared'() {
    const authority = createAuthority();
    const { fs } = shimsOnSession({ authority });
    fs.mkdirSync('/home/user/moded', { recursive: true, mode: 0o700 });
    await fs.promises.writeFile('/home/user/moded/f.txt', 'x');
    assert.equal(authority.kfs.kind('/home/user/moded'), 'directory', 'the declared directory exists at the authority');
  },

  // ── a directory already known to the authority costs no extra mkdir ────────
  // The write-back must not turn every flush into an mkdir round trip.
  async 'a live parent directory is never re-announced'() {
    const mkdirs = [];
    const { fs } = facetRecording(mkdirs, (authority) => { authority.kfs.mkdir('/home/user/live', { recursive: true }); });
    fs.appendFileSync('/home/user/live/a.log', 'one\n');
    await fs.promises.appendFile('/home/user/live/a.log', 'two\n');
    await globalThis.__nimbusProcessFs.flush();
    assert.equal(mkdirs.filter((path) => path === 'home/user/live').length, 0, 'a live parent directory is never re-announced');
  },

  // ── repeated appends announce a local-only directory once ─────────────────
  async 'repeated appends announce a local-only directory once'() {
    const mkdirs = [];
    const { authority, fs } = facetRecording(mkdirs);
    fs.mkdirSync('/home/user/chatty', { recursive: true });
    for (let i = 0; i < 5; i++) await fs.promises.appendFile('/home/user/chatty/a.log', `line ${i}\n`);
    await globalThis.__nimbusProcessFs.flush();
    assert.equal(mkdirs.filter((path) => path === 'home/user/chatty').length, 1, 'the local-only parent is announced once, not once per write');
    assert.equal(
      authority.kfs.readFileString('/home/user/chatty/a.log'),
      'line 0\nline 1\nline 2\nline 3\nline 4\n',
      'every append landed in order',
    );
  },
};

await runScenarios(import.meta.path, scenarios);
