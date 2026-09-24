#!/usr/bin/env bun
// wasi-authority-permissions — the guest's permission checks are the
// filesystem's, made as the process's credential.
//
// There is no permission table in the facet: path_open, path_filestat_get and
// fd_readdir are answered by the authority, so what a file's mode bits and
// the directory chain above it allow is decided once, where the shell decides
// it too. These pin the errno a guest sees for each refusal, and that a
// refusal never masquerades as ENOENT or the other way round.

import assert from 'node:assert/strict';

import { loadWasiPreamble, makeGuest, makeSession } from './lib/wasi-authority.mjs';

const ESUCCESS = 0;
const EACCES = 2;
const ENOENT = 44;
const O_DIRECTORY = 2;
const RIGHT_FD_READ = 1n << 1n;

const P = await loadWasiPreamble();
const sessions = [];

/** A guest over /home/user, with the given paths chmod'ed by the kernel. */
function host({ dirs = [], files = {}, modes = {} }) {
  const session = makeSession({ dirs, files });
  sessions.push(session);
  for (const [path, mode] of Object.entries(modes)) session.root.chmod(path, mode);
  const guest = makeGuest(P, session, { root: 'home/user', preopens: [{ wasiPath: '/', vfsPath: 'home/user' }] });
  return {
    guest,
    open: (path, opts) => guest.open(path, { lookup: 0, rights: RIGHT_FD_READ, inheriting: 0n, ...opts }).errno,
    stat: (path) => guest.stat(path, { lookup: 0 }).errno,
  };
}

{
  const h = host({
    files: { 'home/user/secret.txt': 'secret' },
    modes: { 'home/user/secret.txt': 0o000 },
  });
  assert.equal(h.open('secret.txt'), EACCES,
    'a present file without read permission must fail path_open with EACCES');
  assert.equal(h.open('missing.txt'), ENOENT,
    'an absent file must remain ENOENT rather than becoming a permission denial');
  assert.equal(h.open('absent/child.txt'), ENOENT,
    'a missing ancestor must remain ENOENT when no present ancestor denies traversal');
}

{
  const h = host({
    files: { 'home/user/metadata.txt': 'metadata' },
    modes: { 'home/user/metadata.txt': 0o000 },
  });
  assert.equal(h.stat('metadata.txt'), ESUCCESS,
    'path_filestat_get needs traversal permission but no read permission on the leaf');
}

{
  const h = host({
    dirs: ['home/user/locked'],
    files: { 'home/user/locked/present.txt': 'present' },
    modes: { 'home/user/locked': 0o600 },
  });
  assert.equal(h.stat('locked/present.txt'), EACCES,
    'path_filestat_get must reject a present leaf below an untraversable directory');
  assert.equal(h.stat('locked/missing.txt'), EACCES,
    'ancestor traversal denial must take precedence over a missing leaf');
}

{
  const h = host({
    dirs: ['home/user/listable'],
    files: { 'home/user/listable/child.txt': 'child' },
    modes: { 'home/user/listable': 0o100 },
  });
  // POSIX: a directory is traversed with x and listed with r. opendir(3) is
  // an open for reading, so it is refused outright rather than handing out a
  // descriptor whose every readdir fails; what the x bit still allows is
  // reaching what is inside by name.
  const opened = h.guest.open('listable', { lookup: 0, oflags: O_DIRECTORY, rights: 0n, inheriting: 0n });
  assert.equal(opened.errno, EACCES,
    'opening a directory for listing requires read permission on it');
  assert.equal(h.stat('listable/child.txt'), ESUCCESS,
    'while a child named through it is still reachable');
  const child = h.guest.open('listable/child.txt', { lookup: 0, rights: RIGHT_FD_READ, inheriting: 0n });
  assert.equal(child.errno, ESUCCESS);
  assert.equal(h.guest.read(child.fd).text, 'child');
}

// The other way round: what the credential may read, it reads, and a file
// owned by someone else with group-read is readable through the group.
{
  const h = host({
    files: { 'home/user/shared.txt': 'shared', 'home/user/mine.txt': 'mine' },
    modes: { 'home/user/shared.txt': 0o640, 'home/user/mine.txt': 0o400 },
  });
  sessions.at(-1).root.chown('home/user/shared.txt', 0, 1000);
  const shared = h.guest.open('shared.txt', { lookup: 0, rights: RIGHT_FD_READ, inheriting: 0n });
  assert.equal(shared.errno, ESUCCESS, 'group read is honoured');
  assert.equal(h.guest.read(shared.fd).text, 'shared');
  sessions.at(-1).root.chown('home/user/shared.txt', 0, 0);
  assert.equal(h.open('shared.txt'), EACCES, 'and withdrawn with the group');
  const mine = h.guest.open('mine.txt', { lookup: 0, rights: RIGHT_FD_READ, inheriting: 0n });
  assert.equal(mine.errno, ESUCCESS, 'owner read is honoured');
  assert.equal(h.guest.read(mine.fd).text, 'mine');
}

for (const session of sessions) await session.dispose();
console.log('wasi authority permissions: ok');
