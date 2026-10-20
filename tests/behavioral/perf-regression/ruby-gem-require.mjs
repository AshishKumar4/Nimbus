#!/usr/bin/env bun
// perf-regression/ruby-gem-require — a Ruby launch, and a require from a gem
// home with no version to choose, cost what the baseline's do: graded paired
// (_paired.mjs). The home is 30 gems, one version each, written as Nimbus's
// installer writes them, and `top`, which requires five of them; nothing in
// it is left to RubyGems' activation, so the load path answers every require.
//
// What is graded is the session's own time for the Ruby call, the least of
// REPEATS calls a round. Measured in an A/A of one commit (2026-10-20, 20
// rounds, 5 calls each; /mnt/local/nimbus/verify/paired-grader): the time a
// client sees carries its Preview's placement (about +200 ms on some
// Previews, none of it the session's), and a call took over 1.5 times its
// round's least in a share p = 0.55-0.62 of calls. Spikes only add time, so
// a round grades the least of its calls; how many is a model's choice, not a
// measured bound (REPEATS).

import { mintSession, Terminal, makeAsserter, deleteSession, heredocCommand, hasOutputLine } from '../_driver.mjs';
import { assertCandidateRounds, assertPaired, measurePaired, requirePairedTargets } from '../_paired.mjs';

const a = makeAsserter('perf-regression/ruby-gem-require');
const arms = requirePairedTargets('perf-regression/ruby-gem-require');
console.log(`perf-regression/ruby-gem-require — baseline ${arms.a1.base}, ${arms.a2.base}; candidate ${arms.b1.base}, ${arms.b2.base}`);

const ROUNDS = 20;
/** The share of calls over 1.5 times their five-call round's least, the most measured. */
const SPIKE_SHARE = 0.62;
/**
 * Calls a round: were calls spikes independently with chance SPIKE_SHARE,
 * the least of this many would be one under 5% of the time. A model, not a
 * measured bound: the share was measured against each group's own least,
 * and calls in a row may not be independent.
 */
const REPEATS = Math.ceil(Math.log(0.05) / Math.log(SPIKE_SHARE));
/**
 * What the grading was shown to find. Replaying the A/A (the least of 5
 * calls) with each candidate arm slowed found +60% in 8 of 8 cases (2 Preview
 * sets, 2 commands, either side as the candidate), +50% in 6, +30% in 3. Live,
 * at 7 calls (work/psm-v3, 2026-10-20), +60% was red on 3 of 4 metric-sets:
 * launch passed on one set, its weaker candidate 0.934-1.299.
 */
const FOUND = '+60% in 8 of 8 replays at 5 calls a round and 3 of 4 live checks at 7';
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
      for (const [command, ms] of [['nimbus install ruby', 180_000], [heredocCommand('/home/user/write-home.rb', homeWriter()), 30_000], ['ruby /home/user/write-home.rb', 120_000]]) {
        const done = await t.run(command, ms);
        if (done.exitCode !== 0) throw new Error(`${arm}: ${command.slice(0, 60)} exited ${done.exitCode}: ${done.output.slice(-300)}`);
      }
      // Each command once, untimed, as it is then timed.
      await timed(t, LAUNCH, 'LAUNCHED');
      await timed(t, REQUIRE, 'TOP=constant');
      return { sid, t };
    })());
  }
  return await sessions.get(arm);
}

const LAUNCH = 'ruby -e \'puts "LAUN" + "CHED"\'';
const REQUIRE = `ruby -e 'require "top"; puts "TOP=#{defined?(Top)}"'`;

/** `command`'s wall time, once it exits 0 having printed `line` as a line of its own. */
async function timed(t, command, line) {
  const t0 = performance.now();
  const { output, exitCode } = await t.run(command, 60_000);
  const ms = performance.now() - t0;
  if (exitCode !== 0 || !hasOutputLine(output, line)) throw new Error(`${command}: exit ${exitCode}: ${output.slice(-300)}`);
  return ms;
}

/**
 * What the Ruby facet's last call cost, as the session recorded it: a cold
 * worker's code read and its call (ruby+stdlib.wasm compiled, the VM booted
 * and the program run), or a warm one's call (the program alone).
 */
async function rubyCall(t) {
  const calls = await t.facetCalls();
  if (typeof calls === 'string') throw new Error(calls);
  const call = calls.findLast((c) => c.tag === 'ruby-runner');
  if (!call) throw new Error('no ruby call recorded');
  return call;
}

/** `command`, REPEATS times: the session's least time for its Ruby call, and every call's, as said. */
async function leastCall(t, command, line) {
  const calls = [];
  for (let i = 0; i < REPEATS; i++) {
    const wall = await timed(t, command, line);
    const call = await rubyCall(t);
    calls.push({ wall: Math.round(wall), callMs: call.callMs, cold: call.cold });
  }
  return { least: Math.min(...calls.map((call) => call.callMs)), calls };
}

let round = 0;
const result = await measurePaired(arms, ROUNDS, async (target, arm) => {
  // The arms of a round start together, a1 first: its round is theirs.
  const at = arm === 'a1' ? ++round : round;
  const { t } = await ready(target, arm);
  const launch = await leastCall(t, LAUNCH, 'LAUNCHED');
  const require = await leastCall(t, REQUIRE, 'TOP=constant');
  console.log(`  round ${at} ${arm}: ruby launch ${JSON.stringify(launch.calls)}; gem require ${JSON.stringify(require.calls)}`);
  return { 'ruby launch': launch.least, 'single-version gem require': require.least };
});

for (const pending of sessions.values()) {
  const { sid, t } = await pending.catch(() => ({}));
  if (t) await t.close();
  if (sid) await deleteSession(sid);
}

assertCandidateRounds(a, 'each command ran and printed', result);
const launch = assertPaired(a, 'ruby launch', result, { found: FOUND });
const require = assertPaired(a, 'single-version gem require', result, { found: FOUND });

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : launch && require ? 0 : 2);
