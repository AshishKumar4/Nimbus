#!/usr/bin/env bun
// ruby/gem-install-pure-ruby — gem install fetches and installs a pure
// Ruby gem into persistent GEM_HOME, then require works in a later command.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/gem-install-pure-ruby';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install ruby', 180_000);

{
  const { output } = await t.run('gem install rack', 180_000);
  const stripped = stripAnsi(output);
  a.check('gem install fetches and installs a pure Ruby gem',
    /Successfully installed rack-/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

{
  const { output } = await t.run('ruby -e "require \\"rack\\"; puts Rack.release"', 120_000);
  const stripped = stripAnsi(output);
  a.check('installed pure Ruby gem can be required later',
    /\d+\.\d+\.\d+/.test(stripped) && !/LoadError/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

{
  const { output } = await t.run('test -d /home/user/.gem/gems/rack-* && echo GEM_PERSISTED', 10_000);
  const stripped = stripAnsi(output);
  a.check('installed gem files persist in Nimbus VFS',
    /GEM_PERSISTED/.test(stripped),
    JSON.stringify(stripped.slice(-500)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
