#!/usr/bin/env bun
// python/install-python — `nimbus install python` lays down the CPython
// wasm32-wasi runtime in the per-user VFS at ~/.nimbus/runtimes/cpython/3.13.14/
// and registers the `python` + `python3` bins. Asserts the install completed and
// that the artifacts are present at their expected sizes.
//
// This probe used to assert the Pyodide bundle: name "python", version 0.29.4,
// and the three pristine jsdelivr blobs under share/pyodide/. Every one of those
// described the old implementation rather than anything a user can observe.
// `python` is CPython 3.13 now — package-manager.ts redirects the `python`
// runtime name to `cpython` — so the install lands under a different name, a
// different version and different paths, and a probe pinned to the Pyodide bytes
// was asserting that the migration had not happened. The user-visible contract
// it exists to protect is unchanged and still asserted below: the install
// reports success, the interpreter runs, pip installs a pure wheel that then
// imports, both bins exist, and --list shows what was installed.

import { mintSession, Terminal, makeAsserter, stripAnsi, deleteSession } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('python/install-python');
console.log(`python/install-python — ${process.env.BASE}`);

const RUNTIME_ROOT = '~/.nimbus/runtimes/cpython/3.13.14';

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
await t.connect();
await t.waitForPrompt(60_000);

// 1. Run the install.
{
  const { elapsed, output } = await t.run('nimbus install python', 300_000);
  const stripped = stripAnsi(output);
  const installedOk = /installed at .*\/\.nimbus\/runtimes\/cpython\/3\.13\.14/.test(stripped)
    || /(cpython|python).*installed/i.test(stripped);
  const notCmdNotFound = !/nimbus: command not found/.test(stripped);
  a.check('nimbus install python completes with success marker',
    installedOk && notCmdNotFound,
    installedOk ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-400)));
}

// 2. Manifest exists with the name and version the runtime actually has.
{
  const { output } = await t.run(`cat ${RUNTIME_ROOT}/manifest.json`, 15_000);
  const stripped = stripAnsi(output);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  let parsed = null;
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(stripped.slice(start, end + 1)); } catch {}
  }
  a.check('manifest.json parses + name === "cpython"',
    parsed != null && parsed.name === 'cpython',
    parsed ? `name=${parsed.name}` : JSON.stringify(stripped.slice(0, 300)));
  a.check('manifest.json version === "3.13.14"',
    parsed != null && parsed.version === '3.13.14',
    parsed ? `version=${parsed.version}` : '');
}

// 3. The interpreter and its stdlib are present at the sizes build-python.sh
//    produced. Both variants ship: wasm32-wasi has no dlopen, so the compiled
//    packages live in a second interpreter that the runner selects from what the
//    session installed (see packages/worker/wasm/python/EXTENSIONS.md).
const EXPECTED_SIZES = {
  'share/cpython/python.wasm': 11123914,
  'share/cpython/python-sci.wasm': 19305939,
  'lib/python313.zip': 3845898,
  'lib/sci-packages.zip': 1269909,
};
{
  const { output: shareOut } = await t.run(`ls -la ${RUNTIME_ROOT}/share/cpython/ ${RUNTIME_ROOT}/lib/`, 15_000);
  const stripped = stripAnsi(shareOut);
  for (const [path, expectedSize] of Object.entries(EXPECTED_SIZES)) {
    const basename = path.split('/').pop();
    const re = new RegExp('^\\s*-\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+(\\d+)\\s.*\\b'
      + basename.replace(/\./g, '\\.') + '$', 'm');
    const m = stripped.match(re);
    const size = m ? parseInt(m[1], 10) : 0;
    a.check(`${basename} size === ${expectedSize}`,
      size === expectedSize, `parsed size=${size}`);
  }
}

// 3b. python actually runs, and pip installs a pure wheel.
{
  const { output } = await t.run("python3 -c 'print(1)'", 120_000);
  const stripped = stripAnsi(output);
  a.check("python3 -c 'print(1)' prints 1",
    /(^|\n)\s*1\s*(\n|$)/.test(stripped) && !/Traceback|Error/i.test(stripped),
    JSON.stringify(stripped.slice(-300)));
}
{
  const { output } = await t.run('pip install attrs 2>&1', 180_000);
  const stripped = stripAnsi(output);
  const installed = /Successfully installed[\s\S]*attrs|Installed attrs|attrs[-\s]/i.test(stripped)
    && !/No matching distribution|ERROR|unsupported/i.test(stripped);
  a.check('pip install attrs (pure wheel) succeeds',
    installed, JSON.stringify(stripped.slice(-400)));
  const { output: importOut } = await t.run("python3 -c 'import attr; print(attr.__name__)'", 120_000);
  const importStripped = stripAnsi(importOut);
  a.check('installed attrs imports + runs',
    /(^|\n)\s*attr\s*(\n|$)/.test(importStripped) && !/Traceback|ModuleNotFoundError/i.test(importStripped),
    JSON.stringify(importStripped.slice(-300)));
}

// 4. python and python3 bin paths exist.
{
  const { output } = await t.run(`ls -la ${RUNTIME_ROOT}/bin/`, 10_000);
  const stripped = stripAnsi(output);
  a.check('bin/python exists', /\bpython$/m.test(stripped),
    JSON.stringify(stripped.slice(-200)));
  a.check('bin/python3 exists', /\bpython3$/m.test(stripped),
    JSON.stringify(stripped.slice(-200)));
}

// 5. nimbus install --list shows what was installed.
{
  const { output } = await t.run('nimbus install --list', 10_000);
  const stripped = stripAnsi(output);
  a.check('nimbus install --list shows cpython@3.13.14',
    /cpython@3\.13\.14/.test(stripped),
    JSON.stringify(stripped.slice(-300)));
}

} finally {
  await t.close();
  await deleteSession(sid);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
