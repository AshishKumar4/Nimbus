#!/usr/bin/env bun
// shell/wasm-bash-substrate-proof — prove which bash a shell gate actually ran on.
//
// A fresh session's `bash` is the JS LIFO engine. The wasm GNU bash only
// dispatches after `nimbus install bash`. Every shell suite in this tree is
// therefore capable of passing green without the wasm WASI layer having
// executed a single syscall — which makes it worthless as evidence for a change
// to that layer, while looking exactly like evidence.
//
// This probe states the substrate instead of assuming it: it asserts the JS
// engine BEFORE installing, installs, asserts real GNU bash AFTER, and only
// then exercises the syscall paths that ride wasi-instance — fd_write, fd_read,
// path_open, fd_readdir, path_filestat_get, fd_seek.

import { deleteSession, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'shell/wasm-bash-substrate-proof';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
const tail = (out) => JSON.stringify(stripAnsi(out).slice(-600));

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  // ── The substrate, before ────────────────────────────────────────────────
  {
    const { output } = await t.run('bash --version', 30_000);
    const isGnu = /GNU bash, version/.test(stripAnsi(output));
    a.check('BEFORE install: bash is NOT real GNU bash (the JS engine answers)',
      !isGnu, tail(output));
  }

  await t.run('nimbus install bash', 240_000);

  // ── The substrate, after ─────────────────────────────────────────────────
  let onWasm = false;
  {
    const { output } = await t.run('bash --version', 60_000);
    onWasm = /GNU bash, version 5\.\d+/.test(stripAnsi(output));
    a.check('AFTER install: bash IS real GNU bash 5.x (the wasm/WASI path)',
      onWasm, tail(output));
  }
  if (!onWasm) {
    // Everything below would still pass on the JS engine, so a green result
    // here would be a lie about what was tested.
    throw new Error('wasm bash never took over — the syscall assertions below would prove nothing');
  }

  // ── Syscalls that ride wasi-instance ─────────────────────────────────────
  {
    // fd_write to stdout through the wasm guest.
    const { output } = await t.run("bash -c 'printf \"WASI_STDOUT_%s\\n\" OK'", 60_000);
    a.check('fd_write: guest stdout reaches the terminal',
      /WASI_STDOUT_OK/.test(stripAnsi(output)), tail(output));
  }

  {
    // path_open(O_CREAT) + fd_write + fd_close, then path_open + fd_read.
    const { output } = await t.run(
      "bash -c 'echo ROUNDTRIP_PAYLOAD > /home/user/wasiprobe.txt && cat /home/user/wasiprobe.txt'",
      60_000,
    );
    a.check('path_open + fd_write + fd_read: file round-trips through the VFS',
      /ROUNDTRIP_PAYLOAD/.test(stripAnsi(output)), tail(output));
  }

  {
    // path_filestat_get — size must be the real byte count, not a fabricated one.
    const { output } = await t.run("bash -c 'wc -c < /home/user/wasiprobe.txt'", 60_000);
    a.check('path_filestat_get: stat reports the true size (18 bytes)',
      /\b18\b/.test(stripAnsi(output)), tail(output));
  }

  {
    // fd_readdir through a real directory listing.
    const { output } = await t.run("bash -c 'mkdir -p /home/user/wasidir && touch /home/user/wasidir/alpha /home/user/wasidir/beta && ls /home/user/wasidir'", 60_000);
    const s = stripAnsi(output);
    a.check('fd_readdir: both entries enumerate',
      /alpha/.test(s) && /beta/.test(s), tail(output));
  }

  {
    // fd_seek / fd_read at an offset — the whence constants are ABI-specific,
    // and getting them wrong is silent rather than a trap.
    const { output } = await t.run(
      "bash -c 'printf \"0123456789\" > /home/user/wasiseek.txt && tail -c 4 /home/user/wasiseek.txt'",
      60_000,
    );
    a.check('fd_seek: reading the last 4 bytes yields 6789',
      /6789/.test(stripAnsi(output)), tail(output));
  }

  {
    // A non-zero exit status has to survive proc_exit's __WasiExit path.
    const { output } = await t.run("bash -c 'exit 42'; echo \"STATUS=$?\"", 60_000);
    a.check('proc_exit: a guest exit code survives as the shell status',
      /STATUS=42/.test(stripAnsi(output)), tail(output));
  }
} finally {
  try { await t.close(); } catch {}
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
