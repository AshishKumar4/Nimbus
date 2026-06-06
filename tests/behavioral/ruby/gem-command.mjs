#!/usr/bin/env bun
// ruby/gem-command — Ruby runtime exposes gem/bundle command surfaces with
// real RubyGems version reporting and pure-gem install help.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/gem-command';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install ruby', 180_000);

{
  const { output } = await t.run('which gem && which bundle', 20_000);
  const stripped = stripAnsi(output);
  a.check('gem and bundle are registered runtime commands',
    /\/usr\/bin\/gem/.test(stripped) && /\/usr\/bin\/bundle/.test(stripped),
    JSON.stringify(stripped.slice(-500)));
}

{
  const { output } = await t.run('gem --version', 120_000);
  const stripped = stripAnsi(output);
  a.check('gem --version runs through RubyGems',
    /\d+\.\d+\.\d+/.test(stripped) && !/command not found/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

{
  const { output } = await t.run('gem --help', 120_000);
  const stripped = stripAnsi(output);
  a.check('gem help describes the Nimbus pure Ruby install path',
    /gem install <name>/.test(stripped) && /pure Ruby gems/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
