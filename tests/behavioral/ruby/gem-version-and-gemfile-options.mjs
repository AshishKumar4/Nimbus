#!/usr/bin/env bun
// ruby/gem-version-and-gemfile-options — RubyGems-compatible option forms
// work without treating Gemfile keyword option values as gem requirements.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/gem-version-and-gemfile-options';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install ruby', 180_000);

{
  const { output } = await t.run('gem install rack -v 3.0.8', 180_000);
  const stripped = stripAnsi(output);
  a.check('gem install accepts version option after gem name',
    /Successfully installed rack-3\.0\.8/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

{
  const { output } = await t.run('ruby -e "require \\"rack\\"; puts Rack.release"', 120_000);
  const stripped = stripAnsi(output);
  a.check('versioned gem install loads the requested version',
    /3\.0\.8/.test(stripped) && !/LoadError/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

await t.run('mkdir -p /home/user/ruby-gemfile-options && cd /home/user/ruby-gemfile-options', 10_000);
await t.run(heredocCommand('Gemfile', [
  'source "https://rubygems.org"',
  'gem "rack", "= 3.0.8", require: false',
].join('\n')), 10_000);

{
  const { output } = await t.run('bundle install', 180_000);
  const stripped = stripAnsi(output);
  a.check('Gemfile keyword options are ignored instead of parsed as requirements',
    /Bundle complete/.test(stripped) && !/unsupported argument/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

await t.run(heredocCommand('Gemfile', [
  'source "https://rubygems.org"',
  'gem "rack", git: "https://example.invalid/rack.git"',
].join('\n')), 10_000);

{
  const { output } = await t.run('bundle install', 60_000);
  const stripped = stripAnsi(output);
  a.check('Gemfile unsupported source options fail explicitly',
    /unsupported 'git' source/.test(stripped),
    JSON.stringify(stripped.slice(-1200)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
