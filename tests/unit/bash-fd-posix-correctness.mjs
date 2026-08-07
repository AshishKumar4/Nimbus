#!/usr/bin/env bun
// Behavior test: a descriptor's direction and its existence are both real.
//
// Driven through REAL bash on the REAL staged wasm, so what is asserted is what
// a program actually observes rather than what the syscall table says.
//
//   1. A pipe descriptor records a direction — `end: 'r' | 'w'` — and nothing
//      read it. Writing to the READ end pushed bytes into the pipe and reported
//      them written, so inside a pipeline `echo x >&0` fed the reader its own
//      output: data appearing from nowhere, attributed to the wrong writer, no
//      error anywhere. POSIX makes direction part of the descriptor: EBADF.
//
//   2. One descriptor table held five opinions about a descriptor that does not
//      exist. fd_close, fd_fdstat_get and fd_write answered EBADF; fd_tell and
//      fd_filestat_get answered SUCCESS; fd_seek answered ESPIPE — which is a
//      YES, since ESPIPE means "open, and not seekable". A caller using lseek to
//      test whether an fd is valid read a closed descriptor as open.

import { runScript } from './lib/bash-preamble.mjs';

let pass = 0;
const failed = [];
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failed.push(name); }
};

// ── 1. Writing to the read end of a pipe ────────────────────────────────────
{
  // Inside the right-hand side of a pipeline, fd 0 IS the pipe's read end.
  // If the write succeeds, LEAK is injected into the pipe and `cat` prints it
  // alongside (or instead of) the real payload.
  const r = runScript('echo REAL | { echo LEAK >&0 2>/dev/null; cat; }');
  const out = r.stdout || '';
  check('writing to a pipe read end does not inject into the pipe',
    !out.includes('LEAK'), JSON.stringify({ stdout: r.stdout, stderr: r.stderr, state: r.state }));
  check('the real payload still flows through the pipe',
    out.includes('REAL'), JSON.stringify({ stdout: r.stdout, stderr: r.stderr }));
}

// ── 2. A pipe's write end still works ───────────────────────────────────────
{
  const r = runScript('echo THROUGH | cat');
  check('a normal pipeline is unaffected',
    (r.stdout || '').includes('THROUGH'), JSON.stringify({ stdout: r.stdout, stderr: r.stderr }));
}

// ── 3. Redirection into a real file still works ─────────────────────────────
{
  // fd 4 deliberately, not 3. Explicit fd redirection is only sound at 4 today,
  // and that is a separate pre-existing defect measured while writing this:
  //   fd 3  -> collides with the WASI preopen dirfd, so every later path_open
  //           fails ("cat: can't open …: Bad file descriptor")
  //   fd 4  -> works
  //   fd 5+ -> "bash: redirection error: cannot duplicate fd: Bad file descriptor"
  // Identical before and after the fixes in this commit, so it is not a
  // regression from them. Using 3 here would assert a bug rather than a fix.
  const r = runScript('exec 4> /tmp/out.txt; echo WRITTEN >&4; exec 4>&-; cat /tmp/out.txt',
    { dirs: ['tmp'], modes: { tmp: 7 } });
  check('writing to an explicitly opened output fd still works',
    (r.stdout || '').includes('WRITTEN'), JSON.stringify({ stdout: r.stdout, stderr: r.stderr }));
}

// ── 4. Reading a file through an explicit fd still works ────────────────────
{
  const r = runScript('exec 4< /tmp/in.txt; cat <&4; exec 4<&-',
    { files: { 'tmp/in.txt': 'SEEDED\n' }, dirs: ['tmp'], modes: { tmp: 7, 'tmp/in.txt': 6 } });
  check('reading through an explicitly opened input fd still works',
    (r.stdout || '').includes('SEEDED'), JSON.stringify({ stdout: r.stdout, stderr: r.stderr }));
}

// ── 5. Closing a descriptor bash never opened must not break the shell ──────
{
  // fd_close now answers EBADF for an unknown descriptor, which is POSIX. The
  // risk of that change is a shell that closes speculatively, so assert the
  // shell survives it and keeps running rather than that it reports anything.
  const r = runScript('exec 9>&- 2>/dev/null; echo STILL_RUNNING');
  check('closing an unopened fd leaves the shell running',
    (r.stdout || '').includes('STILL_RUNNING'),
    JSON.stringify({ stdout: r.stdout, stderr: r.stderr, state: r.state }));
}

console.log(`\n  ──── bash-fd-posix-correctness: ${pass} pass / ${failed.length} fail`);
process.exit(failed.length > 0 ? 1 : 0);
