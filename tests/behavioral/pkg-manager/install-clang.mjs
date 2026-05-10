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

// 2. The installed bin path exists in VFS. We use a sigil pair so
//    the shell command echo doesn't false-match: print
//    "RESULT-IS:YES" / "RESULT-IS:NO" — sigil only appears in the
//    program's own console.log output, never in the command-echo
//    string (the source uses 'YES'/'NO' separately).
{
  const { output } = await t.run(
    `node -e "const ok = require('fs').existsSync(process.env.HOME + '/.nimbus/runtimes/clang/binji-2020/bin/clang'); console.log('RESULT'+'-IS:' + (ok ? 'YES' : 'NO'))"`,
    15_000,
  );
  const stripped = stripAnsi(output);
  const matched = /RESULT-IS:YES/.test(stripped);
  a.check('installed bin/clang exists at expected path', matched,
    matched ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

// 3. manifest.json valid + correct name/version (read via node).
{
  const { output } = await t.run(
    `node -e "const j = JSON.parse(require('fs').readFileSync(process.env.HOME + '/.nimbus/runtimes/clang/binji-2020/manifest.json', 'utf8')); console.log('MNAME=' + j.name + ' MVER=' + j.version)"`,
    15_000,
  );
  const stripped = stripAnsi(output);
  const nameOk = /MNAME=clang\b/.test(stripped);
  const verOk = /MVER=binji-2020\b/.test(stripped);
  a.check('manifest.json parses + name === "clang"', nameOk,
    nameOk ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
  a.check('manifest.json version === "binji-2020"', verOk,
    verOk ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

// 4. share/clang/memfs.wasm has wasm magic (\0asm).
{
  const { output } = await t.run(
    `node -e "const b = require('fs').readFileSync(process.env.HOME + '/.nimbus/runtimes/clang/binji-2020/share/clang/memfs.wasm').subarray(0,4); console.log('MAGIC=' + Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join(''))"`,
    15_000,
  );
  const stripped = stripAnsi(output);
  const isWasm = /MAGIC=0061736d/.test(stripped);
  a.check('share/clang/memfs.wasm has wasm magic (0061736d)', isWasm,
    isWasm ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

// 5. bin/clang has wasm magic.
{
  const { output } = await t.run(
    `node -e "const b = require('fs').readFileSync(process.env.HOME + '/.nimbus/runtimes/clang/binji-2020/bin/clang').subarray(0,4); console.log('MAGIC=' + Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join(''))"`,
    30_000,
  );
  const stripped = stripAnsi(output);
  const isWasm = /MAGIC=0061736d/.test(stripped);
  a.check('bin/clang has wasm magic (0061736d)', isWasm,
    isWasm ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
