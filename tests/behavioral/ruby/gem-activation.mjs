#!/usr/bin/env bun
// ruby/gem-activation — `require` activates gems from GEM_HOME as RubyGems
// does: the highest version a request allows, a dependent's constraint
// choosing its dependency's version, and a conflict refused. The gem home is
// written as Nimbus's installer writes one (ruby-gems.ts: a specification
// recording runtime dependencies, the gem's lib under gems/), with two
// versions of `a` and `b` depending on `a < 2`.
//
// The expected lines are host Ruby 3.3.8's, run on the same gem home
// (GEM_HOME=GEM_PATH=it, `ruby cases.rb <case>`).
//
// Red before: Nimbus put every installed gem's lib on $LOAD_PATH first
// (NIMBUS_GEM_LIBS), so nothing was activated, a bare `require "a"` loaded
// a 1.0.0, and the conflict loaded too.

import { mintSession, Terminal, makeAsserter, stripAnsi, heredocCommand } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/gem-activation';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const HOME = '/home/user/.gem';
const HEADER = '# Gem::Specification written by Nimbus RubyGems, its runtime dependencies recorded.';
const GEMS = [
  ['a', '1.0.0', [], 'module A; VERSION = "1.0.0"; end'],
  ['a', '2.0.0', [], 'module A; VERSION = "2.0.0"; end'],
  ['b', '1.0.0', [['a', ['< 2']]], 'require "a"\nmodule B; end'],
];
const spec = (name, version, deps) => [
  HEADER,
  `# stub: ${name} ${version} ruby lib`,
  'Gem::Specification.new do |s|',
  `  s.name = ${JSON.stringify(name)}`,
  `  s.version = ${JSON.stringify(version)}`,
  '  s.platform = "ruby"',
  '  s.summary = "Installed by Nimbus"',
  '  s.files = []',
  '  s.executables = []',
  ...deps.map(([dep, requirements]) => `  s.add_runtime_dependency ${JSON.stringify(dep)}, ${JSON.stringify(requirements)}`),
  'end',
].join('\n');

const CASES = `
def report(label)
  yield
  specs = Gem.loaded_specs.values.select { |s| %w[a b].include?(s.name) }.map(&:full_name).sort.join(",")
  puts "#{label}: A=#{defined?(A::VERSION) ? A::VERSION : '-'} loaded=#{specs}"
rescue Exception => e
  puts "#{label}: #{e.class}: #{e.message.lines.first.strip}"
end
case ARGV[0]
when "dependent" then report("dependent") { require "b" }
when "bare" then report("bare") { require "a" }
when "conflict" then report("conflict") { require "a"; require "b" }
end`;

// Host Ruby 3.3.8 on this gem home.
const EXPECTED = {
  dependent: 'dependent: A=1.0.0 loaded=a-1.0.0,b-1.0.0',
  bare: 'bare: A=2.0.0 loaded=a-2.0.0',
  conflict: 'conflict: Gem::ConflictError: Unable to activate b-1.0.0, because a-2.0.0 conflicts with a (< 2)',
};

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install ruby', 180_000);

for (const [name, version, deps, lib] of GEMS) {
  await t.run(`mkdir -p ${HOME}/gems/${name}-${version}/lib ${HOME}/specifications`, 20_000);
  await t.run(heredocCommand(`${HOME}/gems/${name}-${version}/lib/${name}.rb`, lib), 20_000);
  await t.run(heredocCommand(`${HOME}/specifications/${name}-${version}.gemspec`, spec(name, version, deps)), 20_000);
}
await t.run(heredocCommand('/home/user/cases.rb', CASES), 20_000);

for (const [name, expected] of Object.entries(EXPECTED)) {
  const { output } = await t.run(`ruby /home/user/cases.rb ${name}`, 120_000);
  const line = stripAnsi(output).split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(`${name}: `)) ?? stripAnsi(output).slice(-400);
  console.log(`  ${line}`);
  a.check(`a session's ruby activates as host Ruby: ${name}`, line === expected, JSON.stringify({ line, expected }));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
