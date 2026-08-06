#!/usr/bin/env bun
// bash-wasi-correctness — the bash runner's private WASI layer answers
// syscalls truthfully.
//
// bash-runner.ts carries its own preview1 implementation rather than using
// runtime/wasi-instance.ts, because fork/dup2/pipe mutate the fd table from
// outside WASI and the shared layer has no seam for that. A private copy is
// allowed to be a subset. It is not allowed to be WRONG, and the failures
// below were all silent: a weak CSPRNG, reads that dropped bytes, writes that
// surfaced in the user's terminal instead of failing, and a clock that made
// every timed wait return instantly.
//
// Everything here drives REAL bash and REAL BusyBox over the real syscall
// layer. Two claims cannot be made through a shell — a vectored read across
// several iovecs, and a write to an fd that was never opened — so those use a
// purpose-built WASI guest staged as a coreutil (tests/unit/lib/
// wasi-probe-guest.mjs), which is the same syscall table under test.

import { runScript } from './lib/bash-preamble.mjs';
import { probeWasmEntry } from './lib/wasi-probe-guest.mjs';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

const extraWasm = probeWasmEntry();
const tmp = { dirs: ['tmp'], modes: { tmp: 7 } };

// ── random_get is a CSPRNG ────────────────────────────────────────────────
// $SRANDOM is bash's documented cryptographically-seeded variable; it reads
// random_get directly. Pinning Math.random is what separates a real CSPRNG
// from the arithmetic one this layer used to ship: with Math.random frozen a
// Math.random-backed random_get returns the SAME bytes every call (it did —
// 0x80808080, four bytes of 0.5*256), while crypto.getRandomValues does not
// consult it at all.
{
  const realRandom = Math.random;
  Math.random = () => 0.5;
  let out;
  try {
    out = runScript('echo $SRANDOM; echo $SRANDOM; echo $SRANDOM').stdout.trim().split('\n');
  } finally {
    Math.random = realRandom;
  }
  const unique = new Set(out);
  check('random_get does not draw from Math.random',
    unique.size === out.length && !out.includes('2155905152'),
    `SRANDOM values with Math.random pinned: ${JSON.stringify(out)}`);
}

// ── clock ids are honoured ────────────────────────────────────────────────
// A guest asking for MONOTONIC must not silently receive wall time, and an id
// this layer cannot answer must say so rather than invent a reading.
{
  const r = runScript('probe clockid', { extraWasm });
  check('clock_time_get rejects an unknown clock id',
    r.stdout.includes('bad=28'),
    `expected EINVAL(28) for id 99, got ${JSON.stringify(r.stdout)}`);
  check('clock_time_get answers REALTIME and MONOTONIC',
    r.stdout.includes('rt=0:1') && r.stdout.includes('mono=0:1'),
    JSON.stringify(r.stdout));
}
{
  const r = runScript('probe clocktwice', { extraWasm });
  check('clock_time_get advances between calls',
    r.stdout.includes('advanced=1'), JSON.stringify(r.stdout));
}

// ── a clock subscription is a deadline, not an event ──────────────────────
// poll_oneoff used to report every clock subscription ready immediately,
// ignoring its timeout entirely. It now computes a real deadline and reports
// the subscription only once that deadline has passed.
//
// READ THIS BEFORE TRUSTING IT IN PRODUCTION. What this asserts holds on a
// host whose clock advances during synchronous execution, which is where the
// unit suite runs. It does NOT hold inside a facet: workerd freezes both
// Date.now() and performance.now() for the whole synchronous block (measured:
// 50M spin iterations, 0ms elapsed), so no synchronous implementation can wait
// a deadline out there, and poll_oneoff reports the timeout instead of
// hanging. Making sleep(1) genuinely take a second in-facet requires
// poll_oneoff to become async, which is the migration onto wasi-instance.ts.
// The deadline arithmetic under test is the part that migration will keep.
{
  const started = Date.now();
  const r = runScript('sleep 1; echo done');
  const elapsed = Date.now() - started;
  check('poll_oneoff honours a clock deadline where the clock advances',
    r.stdout === 'done\n' && elapsed >= 900,
    `sleep 1 took ${elapsed}ms, stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr)}`);
}

// ── timestamps track writes ───────────────────────────────────────────────
// Every inode used to report one boot-time constant, so nothing was ever
// newer than anything else and every incremental build believed its targets
// were up to date. -nt is the exact question make(1) asks.
{
  const r = runScript(
    'cd /tmp && echo a > src && sleep 1 && echo b > out && '
    + 'if [ out -nt src ]; then echo NEWER; else echo NOT-NEWER; fi', tmp);
  check('a file written later reports a later mtime',
    r.stdout === 'NEWER\n',
    `stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr)}`);
}

// ── symlinks ──────────────────────────────────────────────────────────────
// path_symlink returned ENOSYS and path_readlink returned EINVAL, so ln -s
// failed outright ("ln: link.txt: Function not implemented").
{
  const r = runScript(
    'cd /tmp && echo payload > t.txt && ln -s t.txt link.txt && '
    + 'readlink link.txt && cat link.txt', tmp);
  check('a symlink can be created, read back, and followed',
    r.stdout === 't.txt\npayload\n',
    `stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr)}`);
}
{
  // A link resolves through its own directory, and -L sees the link itself
  // rather than the target.
  const r = runScript(
    'cd /tmp && mkdir -p d && echo deep > d/real && ln -s d/real ref && '
    + 'cat ref && if [ -L ref ]; then echo IS-LINK; fi', tmp);
  check('a symlink is distinguishable from its target',
    r.stdout === 'deep\nIS-LINK\n',
    `stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr)}`);
}
{
  // A cycle must answer ELOOP rather than hang the scheduler.
  const r = runScript('cd /tmp && ln -s a b && ln -s b a && cat a; echo "rc=$?"', tmp);
  check('a symlink cycle terminates instead of hanging',
    r.state === 'exited' && r.stdout.includes('rc=1'),
    `state ${r.state} stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr)}`);
}

// ── a vectored read fills every buffer ────────────────────────────────────
// fd_read honoured iovs[0] and ignored the rest, so a guest reading into
// several buffers lost everything past the first — silently, with a short
// nread that looked like a legitimate partial read.
{
  const r = runScript('echo -n abcdef | probe readv', { extraWasm });
  check('fd_read scatters across every iovec',
    r.stdout === 'nread=6 iov0=ab iov1=cd iov2=ef\n',
    JSON.stringify(r.stdout));
}

// ── a write to an unknown fd fails ────────────────────────────────────────
// An fd the table does not hold used to fall through to stdout, so a guest's
// misdirected write appeared in the user's terminal and reported success.
{
  const r = runScript('probe badwrite', { extraWasm });
  check('fd_write to an unopened fd returns EBADF',
    r.stdout.includes('errno=8'),
    `expected EBADF(8), got ${JSON.stringify(r.stdout)}`);
  check('fd_write to an unopened fd does not reach stdout',
    !r.stdout.includes('LEAKED-TO-STDOUT'),
    `payload surfaced on stdout: ${JSON.stringify(r.stdout)}`);
}

// ── the real workload still runs ──────────────────────────────────────────
// A stateful script over the paths these fixes touched: pipes, redirection,
// a loop accumulating file state, command substitution, and exit status.
{
  const r = runScript(
    'cd /tmp && for i in 1 2 3; do echo "line$i" >> log; done && '
    + 'n=$(wc -l < log) && echo "count=$n" && '
    + 'grep -c line log && sort -r log | head -1 && '
    + 'cp log copy && diff -q log copy && echo SAME', tmp);
  check('a stateful bash script runs end to end',
    r.state === 'exited' && r.exitCode === 0
      && r.stdout.includes('count=3') && r.stdout.includes('line3') && r.stdout.includes('SAME'),
    `state ${r.state} code ${r.exitCode} stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr)}`);
}

console.log(failures === 0 ? '\nAll bash WASI correctness checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
