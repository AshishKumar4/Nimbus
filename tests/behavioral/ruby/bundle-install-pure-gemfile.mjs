#!/usr/bin/env bun
// ruby/bundle-install-pure-gemfile — bundle install handles a simple Gemfile
// by installing compatible pure Ruby gems through Nimbus RubyGems.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/bundle-install-pure-gemfile';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install ruby', 180_000);
await t.run('mkdir -p /home/user/ruby-bundle && cd /home/user/ruby-bundle', 10_000);
await t.run(heredocCommand('Gemfile', [
  'source "https://rubygems.org"',
  'gem "rack"',
].join('\n')), 10_000);

{
  const { output } = await t.run('bundle install', 180_000);
  const stripped = stripAnsi(output);
  a.check('bundle install installs pure gems from Gemfile',
    /Bundle complete/.test(stripped) && /rack/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

{
  const { output } = await t.run('ruby -e "require \\"rack\\"; puts Rack.release"', 120_000);
  const stripped = stripAnsi(output);
  a.check('Bundler-installed gem can be required later',
    /\d+\.\d+\.\d+/.test(stripped) && !/LoadError/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
