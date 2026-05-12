#!/usr/bin/env bun
// pkg-manager/install-clang — black-box probe that `nimbus install clang`
// pulls the wasm-clang bundle from R2 + Cache API and lays it down in
// the per-user VFS at ~/.nimbus/runtimes/clang/<version>/.
//
// Category: H (hybrid — install observable + sha-pinned content sizes).
//
// PROBE-CLEANUP (2026-05-12): the version string + on-disk layout used
// to be hardcoded `binji-2020`. The clang-sysroot-swap wave (Path C)
// shipped a new version `wasi-libc-modern` while keeping the same
// `clang` and `memfs.wasm` binaries — only the sysroot blob changed.
// Pre-fix the probe asserted on the literal `binji-2020` path and went
// RED everywhere even though the install was correct. Discover the
// installed version dynamically and assert on its layout.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('pkg-manager/install-clang');
console.log(`pkg-manager/install-clang — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. Run the install. The success marker is the path that `nimbus
//    install clang` prints to stdout — we accept ANY trailing version
//    segment (the per-wave version), but the path SHAPE is locked.
let installedVersion = null;
{
  const { elapsed, output } = await t.run('nimbus install clang', 120_000);
  const stripped = stripAnsi(output);
  // `installed at home/user/.nimbus/runtimes/clang/<version>` — strip
  // the trailing `(50.6 MiB)` size if present.
  const m = stripped.match(/installed at\s+(?:\/)?home\/user\/\.nimbus\/runtimes\/clang\/([\w.-]+)/);
  installedVersion = m ? m[1] : null;
  a.check('nimbus install clang completes with success marker + version path',
    installedVersion !== null,
    installedVersion !== null
      ? `elapsed=${elapsed}ms version=${installedVersion}`
      : `output tail=${JSON.stringify(stripped.slice(-300))}`);
}

// Stop early if we couldn't discover the version — the remaining
// checks all depend on it. Reporting "version=null" four more times
// adds no signal.
if (installedVersion === null) {
  await t.close();
  const sum = a.summary();
  process.exit(sum.fail > 0 ? 1 : 0);
}
const RUNTIME_DIR = `~/.nimbus/runtimes/clang/${installedVersion}`;

// 2. The installed bin path exists in VFS. `ls /path/to/file` echoes
//    the path on success and emits an ENOENT-style line on miss.
{
  const { output } = await t.run(`ls ${RUNTIME_DIR}/bin/clang`, 15_000);
  const stripped = stripAnsi(output);
  const matched = stripped.includes(`/.nimbus/runtimes/clang/${installedVersion}/bin/clang`)
    && !/ENOENT|No such|cannot access|not found/i.test(stripped);
  a.check('installed bin/clang exists at expected path', matched,
    matched ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

// 3. manifest.json valid + correct name + version matches what install
//    printed (cross-checks that the install message and on-disk manifest
//    agree).
{
  const { output } = await t.run(`cat ${RUNTIME_DIR}/manifest.json`, 15_000);
  const stripped = stripAnsi(output);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  let parsed = null;
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(stripped.slice(start, end + 1)); } catch {}
  }
  a.check('manifest.json parses + name === "clang"',
    parsed != null && parsed.name === 'clang',
    parsed ? `name=${parsed.name}` : `slice=${JSON.stringify(stripped.slice(0, 300))}`);
  a.check(`manifest.json version matches install path ("${installedVersion}")`,
    parsed != null && parsed.version === installedVersion,
    parsed ? `version=${parsed.version}` : '');
}

// 4. share/clang/memfs.wasm sha-pinned size. The `clang` and
//    `memfs.wasm` binaries are CONTENT-HASH-IDENTICAL across the
//    binji-2020 → wasi-libc-modern swap (only sysroot.tar changed),
//    so the byte size remains exactly 345442. If a future version
//    legitimately changes this binary, update this constant.
{
  const { output } = await t.run(`ls -la ${RUNTIME_DIR}/share/clang/`, 15_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/^\s*-\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s.*memfs\.wasm/m);
  const sz = m ? m[1] : null;
  a.check('share/clang/memfs.wasm size === 345442 (sha-pinned wasm binary)',
    sz === '345442', `parsed size=${sz}`);
}

// 5. bin/clang sha-pinned 31214472 — same rationale as #4.
{
  const { output } = await t.run(`ls -la ${RUNTIME_DIR}/bin/`, 30_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/^\s*-\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s.*\bclang$/m);
  const sz = m ? m[1] : null;
  a.check('bin/clang size === 31214472 (sha-pinned wasm binary)',
    sz === '31214472', `parsed size=${sz}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
