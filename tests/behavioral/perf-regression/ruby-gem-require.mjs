#!/usr/bin/env bun
// perf-regression/ruby-gem-require — a Ruby launch, and a require from a gem
// home with no version to choose, cost what the baseline's do: graded paired
// (_paired.mjs). The home is 30 gems, one version each, written as Nimbus's
// installer writes them, and `top`, which requires five of them; nothing in
// it is left to RubyGems' activation, so the load path answers every require.

import { mintSession, Terminal, makeAsserter, deleteSession, stripAnsi, heredocCommand } from '../_driver.mjs';
import { assertCandidateRounds, assertPaired, measurePaired, requirePairedTargets } from '../_paired.mjs';

const a = makeAsserter('perf-regression/ruby-gem-require');
const arms = requirePairedTargets('perf-regression/ruby-gem-require');
console.log(`perf-regression/ruby-gem-require — baseline ${arms.a1.base}, ${arms.a2.base}; candidate ${arms.b.base}`);

const ROUNDS = 20;
const GEMS = 30;
const HEADER = '# Gem::Specification written by Nimbus RubyGems, its runtime dependencies recorded.';
const spec = (name, deps) => [
  HEADER,
  `# stub: ${name} 1.0.0 ruby lib`,
  'Gem::Specification.new do |s|',
  `  s.name = ${JSON.stringify(name)}`,
  '  s.version = "1.0.0"',
  '  s.platform = "ruby"',
  '  s.summary = "Installed by Nimbus"',
  '  s.files = []',
  '  s.executables = []',
  ...deps.map((dep) => `  s.add_runtime_dependency ${JSON.stringify(dep)}, [">= 0"]`),
  'end',
].join('\n');

/** A Ruby script that writes the gem home under GEM_HOME. */
function homeWriter() {
  const gems = Array.from({ length: GEMS }, (_, i) => [`g${i}`, [], `module G${i}; end`]);
  gems.push(['top', ['g0', 'g1', 'g2', 'g3', 'g4'], 'require "g0"; require "g1"; require "g2"; require "g3"; require "g4"; module Top; end']);
  const lines = ['require "fileutils"', 'home = ENV["GEM_HOME"]'];
  for (const [name, deps, lib] of gems) {
    lines.push(`FileUtils.mkdir_p("#{home}/gems/${name}-1.0.0/lib"); FileUtils.mkdir_p("#{home}/specifications")`);
    lines.push(`File.write("#{home}/gems/${name}-1.0.0/lib/${name}.rb", ${JSON.stringify(lib)})`);
    lines.push(`File.write("#{home}/specifications/${name}-1.0.0.gemspec", ${JSON.stringify(spec(name, deps))})`);
  }
  return lines.join('\n');
}

/** Each arm's session, made ready once: ruby installed, the home written, each command run once untimed. */
const sessions = new Map();
async function ready(target, arm) {
  if (!sessions.has(arm)) {
    sessions.set(arm, (async () => {
      const sid = await mintSession(target);
      const t = new Terminal(sid);
      await t.connect();
      await t.waitForPrompt(30_000);
      await t.run('nimbus install ruby', 180_000);
      await t.run(heredocCommand('/home/user/write-home.rb', homeWriter()), 30_000);
      await t.run('ruby /home/user/write-home.rb', 120_000);
      await t.run('ruby -e 1', 60_000);
      const loaded = stripAnsi((await t.run(`ruby -e 'require "top"; puts "TOP=#{defined?(Top)}"'`, 60_000)).output);
      if (!/TOP=constant/.test(loaded)) throw new Error(`${arm}: require "top" did not load: ${loaded.slice(-300)}`);
      return { sid, t };
    })());
  }
  return await sessions.get(arm);
}

async function timed(t, command, expect) {
  const t0 = performance.now();
  const output = stripAnsi((await t.run(command, 60_000)).output);
  const ms = performance.now() - t0;
  if (!expect.test(output)) throw new Error(`${command}: ${output.slice(-300)}`);
  return ms;
}

const result = await measurePaired(arms, ROUNDS, async (target, arm) => {
  const { t } = await ready(target, arm);
  return {
    'ruby launch': await timed(t, 'ruby -e \'puts "LAUNCHED"\'', /LAUNCHED/),
    'single-version gem require': await timed(t, `ruby -e 'require "top"; puts "TOP=#{defined?(Top)}"'`, /TOP=constant/),
  };
});

for (const pending of sessions.values()) {
  const { sid, t } = await pending.catch(() => ({}));
  if (t) await t.close();
  if (sid) await deleteSession(sid);
}

assertCandidateRounds(a, 'each command ran and printed', result);
const launch = assertPaired(a, 'ruby launch', result);
const require = assertPaired(a, 'single-version gem require', result);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : launch && require ? 0 : 2);
