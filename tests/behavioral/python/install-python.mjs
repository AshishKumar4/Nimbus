#!/usr/bin/env bun
// python/install-python — `nimbus install python` lays down the
// Pyodide bundle in the per-user VFS at
// ~/.nimbus/runtimes/python/0.29.4/ and registers the `python` +
// `python3` bins. Asserts the install completed + the four critical
// blobs are present with correct sha-pinned sizes.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('python/install-python');
console.log(`python/install-python — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. Run the install.
{
  const { elapsed, output } = await t.run('nimbus install python', 180_000);
  const stripped = stripAnsi(output);
  const installedOk = /installed at .*\/\.nimbus\/runtimes\/python\/0\.29\.4/.test(stripped)
    || /python.*installed/i.test(stripped);
  const notCmdNotFound = !/nimbus: command not found/.test(stripped);
  a.check('nimbus install python completes with success marker',
    installedOk && notCmdNotFound,
    installedOk ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-400)));
}

// 2. Manifest exists with correct name + version.
{
  const { output } = await t.run('cat ~/.nimbus/runtimes/python/0.29.4/manifest.json', 15_000);
  const stripped = stripAnsi(output);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  let parsed = null;
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(stripped.slice(start, end + 1)); } catch {}
  }
  a.check('manifest.json parses + name === "python"',
    parsed != null && parsed.name === 'python',
    parsed ? `name=${parsed.name}` : JSON.stringify(stripped.slice(0, 300)));
  a.check('manifest.json version === "0.29.4"',
    parsed != null && parsed.version === '0.29.4',
    parsed ? `version=${parsed.version}` : '');
}

// 3. The four Pyodide blobs are at the expected paths with sha-pinned sizes.
//    Sizes from the upstream jsdelivr CDN (recorded in the manifest).
const EXPECTED_SIZES = {
  'share/pyodide/pyodide.asm.wasm':   8647684,
  'share/pyodide/pyodide.asm.js':     1074322,
  'share/pyodide/python_stdlib.zip':  2424002,
  'share/pyodide/pyodide-lock.json':   122027,
};
{
  // Dir listing first; sizes via ls -la
  const { output: lsOut } = await t.run('ls -la ~/.nimbus/runtimes/python/0.29.4/share/pyodide/', 15_000);
  const stripped = stripAnsi(lsOut);
  for (const [path, expectedSize] of Object.entries(EXPECTED_SIZES)) {
    const basename = path.split('/').pop();
    const re = new RegExp('^\\s*-\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+(\\d+)\\s.*\\b' + basename.replace(/\./g, '\\.') + '$', 'm');
    const m = stripped.match(re);
    const size = m ? parseInt(m[1], 10) : 0;
    a.check(`${basename} size === ${expectedSize} (Pyodide 0.29.4 sha-pinned)`,
      size === expectedSize, `parsed size=${size}`);
  }
}

// 4. python and python3 bin paths exist.
{
  const { output } = await t.run('ls -la ~/.nimbus/runtimes/python/0.29.4/bin/', 10_000);
  const stripped = stripAnsi(output);
  a.check('bin/python exists', /\bpython$/m.test(stripped),
    JSON.stringify(stripped.slice(-200)));
  a.check('bin/python3 exists', /\bpython3$/m.test(stripped),
    JSON.stringify(stripped.slice(-200)));
}

// 5. nimbus install --list shows python.
{
  const { output } = await t.run('nimbus install --list', 10_000);
  const stripped = stripAnsi(output);
  a.check('nimbus install --list shows python@0.29.4',
    /python@0\.29\.4/.test(stripped),
    JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
