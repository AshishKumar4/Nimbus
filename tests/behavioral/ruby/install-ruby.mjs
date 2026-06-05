#!/usr/bin/env bun
// ruby/install-ruby — `nimbus install ruby` lays down the ruby+stdlib
// wasm in the per-user VFS at ~/.nimbus/runtimes/ruby/3.3.4/ and
// registers the `ruby` + `ruby3` bins. Asserts the install completed
// + the wasm blob is present with the sha-pinned size.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('ruby/install-ruby');
console.log(`ruby/install-ruby — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. Run the install.
{
  const { elapsed, output } = await t.run('nimbus install ruby', 180_000);
  const stripped = stripAnsi(output);
  const installedOk = /installed at .*\/\.nimbus\/runtimes\/ruby\/3\.3\.4/.test(stripped)
    || /ruby.*installed/i.test(stripped);
  const notCmdNotFound = !/nimbus: command not found/.test(stripped);
  a.check('nimbus install ruby completes with success marker',
    installedOk && notCmdNotFound,
    installedOk ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-400)));
}

// 2. Manifest exists with correct name + version.
{
  const { output } = await t.run('cat ~/.nimbus/runtimes/ruby/3.3.4/manifest.json', 15_000);
  const stripped = stripAnsi(output);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  let parsed = null;
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(stripped.slice(start, end + 1)); } catch {}
  }
  a.check('manifest.json parses + name === "ruby"',
    parsed != null && parsed.name === 'ruby',
    parsed ? `name=${parsed.name}` : JSON.stringify(stripped.slice(0, 300)));
  a.check('manifest.json version === "3.3.4"',
    parsed != null && parsed.version === '3.3.4',
    parsed ? `version=${parsed.version}` : '');
}

// 3. The ruby+stdlib wasm is at the expected path with sha-pinned size.
const EXPECTED_SIZES = {
  'share/ruby/ruby+stdlib.wasm': 35992842,
};
{
  const { output: lsOut } = await t.run('ls -la ~/.nimbus/runtimes/ruby/3.3.4/share/ruby/', 15_000);
  const stripped = stripAnsi(lsOut);
  for (const [path, expectedSize] of Object.entries(EXPECTED_SIZES)) {
    const basename = path.split('/').pop();
    const re = new RegExp('^\\s*-\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+(\\d+)\\s.*\\b' + basename.replace(/[.+]/g, '\\$&') + '$', 'm');
    const m = stripped.match(re);
    const size = m ? parseInt(m[1], 10) : 0;
    a.check(`${basename} size === ${expectedSize} (ruby.wasm 2.9.3-2.9.4 sha-pinned)`,
      size === expectedSize, `parsed size=${size}`);
  }
}

// 4. ruby and ruby3 bin paths exist.
{
  const { output } = await t.run('ls -la ~/.nimbus/runtimes/ruby/3.3.4/bin/', 10_000);
  const stripped = stripAnsi(output);
  a.check('bin/ruby exists', /\bruby$/m.test(stripped),
    JSON.stringify(stripped.slice(-200)));
  a.check('bin/ruby3 exists', /\bruby3$/m.test(stripped),
    JSON.stringify(stripped.slice(-200)));
}

// 5. nimbus install --list shows ruby.
{
  const { output } = await t.run('nimbus install --list', 10_000);
  const stripped = stripAnsi(output);
  a.check('nimbus install --list shows ruby@3.3.4',
    /ruby@3\.3\.4/.test(stripped),
    JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
