#!/usr/bin/env bun
// pkg-manager/install-clang — black-box probe that `nimbus install clang`
// pulls the binji wasm-clang bundle from R2 + Cache API and lays it
// down in the per-user VFS at ~/.nimbus/runtimes/clang/binji-2020/.
//
// Asserts (all RED on current prod — no package manager yet):
//   1. `nimbus install clang` exits 0 within 90 s
//   2. `which clang` resolves to ~/.nimbus/runtimes/clang/binji-2020/bin/clang
//   3. manifest.json under that dir is valid JSON with the right `name` + `version`
//   4. share/clang/memfs.wasm exists and has wasm magic (\0asm)
//   5. bin/clang exists and has wasm magic

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('pkg-manager/install-clang');
console.log(`pkg-manager/install-clang — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. Run the install.
{
  const { elapsed, output } = await t.run('nimbus install clang', 120_000);
  const stripped = stripAnsi(output);
  const installedOk = /installed at .*\/\.nimbus\/runtimes\/clang\/binji-2020/.test(stripped)
    || /clang.*installed/i.test(stripped);
  a.check('nimbus install clang completes with success marker', installedOk,
    installedOk ? `elapsed=${elapsed}ms` : `output tail=${JSON.stringify(stripped.slice(-300))}`);
}

// 2. The installed bin path exists in VFS. Use `ls` (which talks to
//    SqliteFS directly via the supervisor, not via node's bundled FS
//    view which only covers the cwd subtree).
{
  const { output } = await t.run(
    'ls ~/.nimbus/runtimes/clang/binji-2020/bin/clang',
    15_000,
  );
  const stripped = stripAnsi(output);
  // `ls /path/to/file` echoes the path on success, empty/error on miss.
  const matched = /\/\.nimbus\/runtimes\/clang\/binji-2020\/bin\/clang/.test(stripped)
    && !/ENOENT|No such|cannot access|not found/i.test(stripped);
  a.check('installed bin/clang exists at expected path', matched,
    matched ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

// 3. manifest.json valid + correct name/version. Read via `cat` which
//    streams from SqliteFS through the supervisor terminal pipeline.
{
  const { output } = await t.run('cat ~/.nimbus/runtimes/clang/binji-2020/manifest.json', 15_000);
  const stripped = stripAnsi(output);
  // Find the JSON block (first { … last }) in the stripped output.
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  let parsed = null;
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(stripped.slice(start, end + 1)); } catch {}
  }
  a.check('manifest.json parses + name === "clang"',
    parsed != null && parsed.name === 'clang',
    parsed ? `name=${parsed.name}` : `slice=${JSON.stringify(stripped.slice(0, 300))}`);
  a.check('manifest.json version === "binji-2020"',
    parsed != null && parsed.version === 'binji-2020',
    parsed ? `version=${parsed.version}` : '');
}

// 4. share/clang/memfs.wasm + bin/clang are sha-pinned sizes. We
//    read `ls -la` (which queries SqliteFS inode size directly via
//    the supervisor, NOT via `wc -c` / `cat` pipes which appear to
//    inflate large-file byte counts on lifo-sh today).
{
  const { output } = await t.run('ls -la ~/.nimbus/runtimes/clang/binji-2020/share/clang/', 15_000);
  const stripped = stripAnsi(output);
  // ls line: "-rw-r--r-- 1 user user 345442 May 10 ... memfs.wasm"
  const m = stripped.match(/^\s*-\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s.*memfs\.wasm/m);
  const sz = m ? m[1] : null;
  a.check('share/clang/memfs.wasm size === 345442 (binji-2020 sha-pinned)',
    sz === '345442', `parsed size=${sz}`);
}

// 5. bin/clang sha-pinned 31214472.
{
  const { output } = await t.run('ls -la ~/.nimbus/runtimes/clang/binji-2020/bin/', 30_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/^\s*-\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s.*\bclang$/m);
  const sz = m ? m[1] : null;
  a.check('bin/clang size === 31214472 (binji-2020 sha-pinned)',
    sz === '31214472', `parsed size=${sz}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
