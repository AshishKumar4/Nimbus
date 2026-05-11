#!/usr/bin/env bun
// ruby/stdlib-import — require'd stdlib modules load from the packed
// wasi-vfs stdlib bundled in ruby+stdlib.wasm.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('ruby/stdlib-import');
console.log(`ruby/stdlib-import — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install ruby', 180_000);

// 1. json stdlib
{
  const { output } = await t.run(`ruby -rjson -e 'puts JSON.dump({hi: 1})'`, 60_000);
  const stripped = stripAnsi(output);
  const hasJson = /\{"hi":\s*1\}/.test(stripped);
  a.check('json stdlib via -rjson; JSON.dump → {"hi":1}',
    hasJson, JSON.stringify(stripped.slice(-300)));
}

// 2. set stdlib
{
  const { output } = await t.run(`ruby -rset -e 'puts Set[1,2,1].to_a.sort.inspect'`, 60_000);
  const stripped = stripAnsi(output);
  const hasSet = /\[1,\s*2\]/.test(stripped);
  a.check('set stdlib via -rset; Set[1,2,1].to_a.sort → [1, 2]',
    hasSet, JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
