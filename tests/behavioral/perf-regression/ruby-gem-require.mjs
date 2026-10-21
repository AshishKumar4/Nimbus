#!/usr/bin/env bun
// perf-regression/ruby-gem-require — a Ruby launch, and a require from a gem
// home with no version to choose, cost what the baseline's do: graded paired
// (_paired.mjs). The home is 30 gems, one version each, written as Nimbus's
// installer writes them, and `top`, which requires five of them; nothing in
// it is left to RubyGems' activation, so the load path answers every require.
//
// What is graded is what the user waits for: each command's wall at the
// client, net of its terminal's own round trip in the same round (the least
// of REPEATS runs of the shell builtin `true`), the least of REPEATS commands
// a round. The round trip carries the Preview's placement: in an A/A of one
// commit (2026-10-20, 20 rounds, 5 calls each; /mnt/local/nimbus/verify/
// paired-grader/k-wall.py) one Preview's walls were +57% over its set's
// others, and graded on the wall alone that A/A was red at every k. The
// session's own record of a call is no stand-in: a Durable Object's clock does
// not move while its thread computes, so a call run on its thread reads short
// and one run elsewhere does not (2026-10-21, ruby one-shots on a session's
// peer). Spikes only add time, so a round grades the least of its calls.

import { mintSession, Terminal, makeAsserter, deleteSession, heredocCommand, hasOutputLine } from '../_driver.mjs';
import { assertCandidateRounds, assertPaired, measurePaired, requirePairedTargets } from '../_paired.mjs';

const a = makeAsserter('perf-regression/ruby-gem-require');
const arms = requirePairedTargets('perf-regression/ruby-gem-require');
console.log(`perf-regression/ruby-gem-require — baseline ${arms.a1.base}, ${arms.a2.base}; candidate ${arms.b1.base}, ${arms.b2.base}`);

const ROUNDS = 20;
/**
 * The share of net walls over 1.5 times their round's least, the most
 * measured: 0.152-0.221 over two A/As of one commit on fresh Preview sets,
 * 20 rounds of 7 each (2026-10-21, verdicts 20261021T184843-188b2be4dde5 and
 * 20261021T195005-188b2be4dde5; /mnt/local/nimbus/verify/paired-grader/k-net.py).
 */
const SPIKE_SHARE = 0.221;
/**
 * Calls a round: were calls spikes independently with chance SPIKE_SHARE,
 * the least of this many would be one under 5% of the time. A model, not a
 * measured bound: the share was measured against each group's own least,
 * and calls in a row may not be independent.
 */
const REPEATS = Math.ceil(Math.log(0.05) / Math.log(SPIKE_SHARE));
/**
 * What the grading was shown to find, and not to find. Both A/As passed at
 * every k from 1 to 7 (0.97-1.08). Replaying them at REPEATS calls with each
 * candidate arm slowed (2 Preview sets, 2 commands, either side as the
 * candidate) found +50% and +60% in 8 of 8, and +30% in 6 of 8.
 */
const FOUND = '+50% in 8 of 8 replays of two A/As at 2 calls a round, +30% in 6 of 8';
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

/** `command`'s wall time, once it exits 0 having printed `line` as a line of its own (when it names one). */
async function timed(t, command, line) {
  const t0 = performance.now();
  const { output, exitCode } = await t.run(command, 60_000);
  const ms = performance.now() - t0;
  if (exitCode !== 0 || (line !== null && !hasOutputLine(output, line))) throw new Error(`${command}: exit ${exitCode}: ${output.slice(-300)}`);
  return ms;
}

/**
 * `command`, REPEATS times, each after its terminal's round trip (`true`):
 * the least of its walls net of the least round trip, and every wall, as
 * said.
 */
async function leastNet(t, command, line) {
  const walls = [];
  const trips = [];
  for (let i = 0; i < REPEATS; i++) {
    trips.push(Math.round(await timed(t, 'true', null)));
    walls.push(Math.round(await timed(t, command, line)));
  }
  return { least: Math.max(1, Math.min(...walls) - Math.min(...trips)), walls, trips };
}

let round = 0;
const result = await measurePaired(arms, ROUNDS, async (target, arm) => {
  // The arms of a round start together, a1 first: its round is theirs.
  const at = arm === 'a1' ? ++round : round;
  const { t } = await ready(target, arm);
  const launch = await leastNet(t, LAUNCH, 'LAUNCHED');
  const require = await leastNet(t, REQUIRE, 'TOP=constant');
  console.log(`  round ${at} ${arm}: samples ${JSON.stringify({ launch: launch.walls, launchTrip: launch.trips, require: require.walls, requireTrip: require.trips })}`);
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
