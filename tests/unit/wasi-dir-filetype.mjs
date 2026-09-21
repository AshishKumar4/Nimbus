#!/usr/bin/env bun
// wasi-dir-filetype — a directory must stat as a directory, however it got
// into the filesystem.
//
// os.makedirs(path, exist_ok=True) is mkdir followed by, on EEXIST, a check
// that the path is a directory after all. If stat disagrees, makedirs re-raises
// and the caller sees FileExistsError for a directory that plainly exists —
// which is how `pip install` died against this layer while every other Python
// operation worked.
//
// The layer is shared: ruby and clang stat directories through the same
// authority codec, so this is not a Python test that happens to live here.

import assert from 'node:assert/strict';

import { assertGeneratedSourcesAreCurrent } from './lib/generated-freshness.mjs';
import { loadWasiPreamble, makeGuest, makeSession } from './lib/wasi-authority.mjs';

assertGeneratedSourcesAreCurrent();

const P = await loadWasiPreamble();
const ESUCCESS = 0, EEXIST = 20;
const FT_DIRECTORY = 3, FT_REGULAR_FILE = 4;
const sessions = [];

/** A session with a populated directory, an empty one, and a file in one. */
function host() {
  const session = makeSession({
    dirs: ['home/user/pkg', 'home/user/empty'],
    files: { 'home/user/pkg/marker.txt': 'marker-bytes' },
  });
  sessions.push(session);
  const guest = makeGuest(P, session);
  return {
    /** filetype byte of path_filestat_get, or the errno if it failed. */
    filetype(p) {
      const st = guest.stat(p);
      return st.errno === ESUCCESS ? st.filetype : `errno=${st.errno}`;
    },
    mkdir(p) {
      const [pp, pl] = guest.putStr(p);
      return guest.wasi.path_create_directory(3, pp, pl);
    },
  };
}

// ── A directory the authority holds stats as a directory ───────────────────
{
  const h = host();
  assert.equal(h.filetype('home/user/pkg'), FT_DIRECTORY, 'a directory is a directory');
  assert.equal(h.filetype('home/user/empty'), FT_DIRECTORY, 'including one with no children');
  assert.equal(h.filetype('home/user'), FT_DIRECTORY, 'and an ancestor of one');
  assert.equal(h.filetype('home/user/pkg/marker.txt'), FT_REGULAR_FILE,
    'while a file is still a regular file');
  console.log('  ok  authority-backed directories stat as directories');
}

// ── makedirs(exist_ok=True) over an existing directory ─────────────────────
// mkdir must say EEXIST, and the stat that follows must agree it is a
// directory. Disagreement is what turns exist_ok into FileExistsError.
{
  const h = host();
  assert.equal(h.mkdir('home/user/pkg'), EEXIST, 'mkdir on an existing directory is EEXIST');
  assert.equal(h.filetype('home/user/pkg'), FT_DIRECTORY,
    'and the isdir check that follows must agree — otherwise exist_ok re-raises');
  console.log('  ok  mkdir/EEXIST and the isdir that follows agree');
}

// ── A directory created by the guest keeps its type ────────────────────────
{
  const h = host();
  assert.equal(h.mkdir('home/user/fresh'), ESUCCESS);
  assert.equal(h.filetype('home/user/fresh'), FT_DIRECTORY,
    'a directory the guest just created is a directory');
  assert.equal(h.mkdir('home/user/fresh'), EEXIST, 'and creating it again is EEXIST');
  assert.equal(h.filetype('home/user/fresh'), FT_DIRECTORY, 'still a directory afterwards');
  console.log('  ok  guest-created directories keep their filetype');
}

for (const session of sessions) await session.dispose();
console.log('wasi-dir-filetype: all cases passed');
