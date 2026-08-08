#!/usr/bin/env bun
// tti.mjs — Time-to-Interactive benchmark for @computesdk/nimbus,
// following ComputeSDK's published methodology.
//
//   TTI = performance.now() from compute.sandbox.create() through the
//   first successful runCommand. destroy() is not timed.
//   (https://github.com/computesdk/benchmarks/blob/main/METHODOLOGY.md)
//
// Differences from the upstream runner, all deliberate:
//
//   * Upstream's `bench run` posts to a hosted platform and needs
//     BENCHMARKS_PLATFORM_API_KEY. This driver runs the same task
//     locally and emits raw per-trial timings; scoring is applied
//     afterwards by score.mjs using upstream's own stats/scoring code,
//     so the numbers are comparable rather than re-derived.
//   * Every trial uses a fresh sandbox id, so each one creates a cold
//     Durable Object. Nothing is pre-warmed.
//   * Each trial records its phases (create, exec) separately, and a
//     run whose phases all round to zero is refused rather than scored.
//   * A control measures plain HTTP round-trip time to the same origin,
//     so the share of TTI that is simply network from this machine is
//     visible instead of buried.
//
// Workloads exist because `node -v` does not boot Node on Nimbus — it is
// answered by an argv fast path in runtime-registry.ts. Upstream uses it
// as proof that "the Node.js runtime is available and functional", which
// on Nimbus it is not. So the same TTI is also measured with commands
// that genuinely execute.
//
//   BASE=<url> NIMBUS_PROBE_TOKEN=<jwt> bun tti.mjs --trials 30 --workload node-version

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { nimbus } from '../src/index.ts';

const WORKLOADS = {
  // Upstream's readiness command, verbatim. On Nimbus this is a constant
  // written by an argv fast path — it does NOT prove Node started.
  'node-version': {
    command: 'node -v',
    proves: 'sandbox reachable and dispatching commands (NOT that Node booted)',
    verify: (r) => /^v\d+\.\d+\.\d+/.test(r.stdout),
  },
  // A real process whose output cannot be predicted by the caller, so a
  // pass proves the sandbox actually ran something.
  shell: {
    command: 'echo $((6*7))-$$',
    proves: 'a real process ran in the sandbox and returned computed output',
    verify: (r) => /^42-\d+/.test(r.stdout.trim()),
  },
  // Proof the Node runtime itself booted and executed JavaScript.
  'node-exec': {
    command: 'node -e "console.log(6*7)"',
    proves: 'the Node.js runtime booted and executed JavaScript',
    verify: (r) => r.stdout.trim() === '42',
  },
};

function parseArgs(argv) {
  const args = {
    trials: 20,
    shape: 'sequential',
    concurrency: 1,
    staggerDelayMs: 0,
    workload: 'node-version',
    out: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!(key in args)) throw new Error(`unknown flag: ${argv[i]}`);
    args[key] = ['trials', 'concurrency', 'staggerDelayMs'].includes(key) ? Number(value) : value;
  }
  if (args.shape === 'staggered' && args.staggerDelayMs === 0) args.staggerDelayMs = 200;
  if (args.shape !== 'sequential' && args.concurrency === 1) args.concurrency = args.trials;
  return args;
}

const args = parseArgs(process.argv.slice(2));
const endpoint = process.env.BASE;
const token = process.env.NIMBUS_PROBE_TOKEN;
if (!endpoint || !token) {
  console.error('tti: BASE and NIMBUS_PROBE_TOKEN are required');
  process.exit(2);
}

const workload = WORKLOADS[args.workload];
if (!workload) {
  console.error(`tti: unknown workload '${args.workload}'; try ${Object.keys(WORKLOADS).join(', ')}`);
  process.exit(2);
}

const compute = nimbus({ endpoint, token });

/**
 * Plain HTTP round trip to the same origin. This is the floor that any
 * TTI from this machine includes and that Nimbus cannot be blamed for.
 */
async function measureRtt(samples) {
  const times = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    // An unauthenticated GET the router answers without touching a DO.
    await fetch(`${endpoint}/healthz`, { method: 'GET' }).catch(() => null);
    times.push(performance.now() - start);
  }
  return times;
}

/**
 * Cold `ready()` straight through the Nimbus SDK, with no provider in the
 * way. `create()` is `ready()` plus the ownership-marker write, so the gap
 * between this and createMs is the provider's own overhead rather than
 * anything Nimbus spends booting.
 */
async function measureBareReady(samples) {
  const { Nimbus } = await import('../../sdk/src/index.ts');
  const client = Nimbus.connect({ endpoint, token });
  const times = [];
  for (let i = 0; i < samples; i += 1) {
    const box = client.sandbox(`bare-${Date.now().toString(36)}-${i}`);
    const start = performance.now();
    await box.ready();
    times.push(performance.now() - start);
    await box.destroy().catch(() => undefined);
  }
  return times;
}

async function runTrial(index) {
  const trial = { index, ttiMs: 0, createMs: 0, execMs: 0, error: null };
  let sandbox = null;
  try {
    const start = performance.now();

    sandbox = await compute.sandbox.create();
    trial.createMs = performance.now() - start;

    const execStart = performance.now();
    const result = await sandbox.runCommand(workload.command);
    trial.execMs = performance.now() - execStart;

    if (result.exitCode !== 0) {
      throw new Error(`exit ${result.exitCode}: ${result.stderr.trim() || 'no stderr'}`);
    }
    if (!workload.verify(result)) {
      throw new Error(
        `output did not prove the workload ran: ${JSON.stringify(result.stdout.slice(0, 120))}`,
      );
    }

    trial.ttiMs = performance.now() - start;
    trial.sandboxId = sandbox.sandboxId;
  } catch (error) {
    trial.error = error instanceof Error ? error.message : String(error);
  } finally {
    // Cleanup is deliberately outside the timed window.
    if (sandbox) await sandbox.destroy().catch(() => undefined);
  }
  return trial;
}

async function runSequential(trials) {
  const out = [];
  for (let i = 0; i < trials; i += 1) {
    const trial = await runTrial(i);
    out.push(trial);
    process.stdout.write(
      trial.error
        ? `  trial ${i}: FAILED — ${trial.error}\n`
        : `  trial ${i}: ${trial.ttiMs.toFixed(0)}ms (create ${trial.createMs.toFixed(0)} + exec ${trial.execMs.toFixed(0)})\n`,
    );
  }
  return out;
}

async function runConcurrent(trials, staggerDelayMs) {
  const started = performance.now();
  const pending = [];
  for (let i = 0; i < trials; i += 1) {
    if (staggerDelayMs > 0 && i > 0) {
      await new Promise((r) => setTimeout(r, staggerDelayMs));
    }
    pending.push(runTrial(i));
  }
  const out = await Promise.all(pending);
  return { out, wallClockMs: performance.now() - started };
}

console.log(`nimbus TTI — ${args.shape}, ${args.trials} trials, workload '${args.workload}'`);
console.log(`  command: ${workload.command}`);
console.log(`  proves:  ${workload.proves}`);
console.log(`  target:  ${endpoint}\n`);

console.log('measuring HTTP round-trip baseline...');
const rttSamples = await measureRtt(10);
const rttMedian = [...rttSamples].sort((a, b) => a - b)[Math.floor(rttSamples.length / 2)];
console.log(`  median RTT to origin: ${rttMedian.toFixed(0)}ms`);

console.log('measuring cold ready() without the provider...');
const bareSamples = await measureBareReady(5);
const bareMedian = [...bareSamples].sort((a, b) => a - b)[Math.floor(bareSamples.length / 2)];
console.log(`  median bare ready(): ${bareMedian.toFixed(0)}ms\n`);

let trials;
let wallClockMs = null;
if (args.shape === 'sequential') {
  trials = await runSequential(args.trials);
} else {
  const result = await runConcurrent(args.trials, args.staggerDelayMs);
  trials = result.out;
  wallClockMs = result.wallClockMs;
  for (const t of trials) {
    console.log(
      t.error
        ? `  trial ${t.index}: FAILED — ${t.error}`
        : `  trial ${t.index}: ${t.ttiMs.toFixed(0)}ms`,
    );
  }
}

const successes = trials.filter((t) => !t.error);

// A run in which the work rounds to nothing is not a fast run, it is a
// broken measurement. Refuse it rather than reporting a headline.
if (successes.length > 0) {
  const allZero = successes.every((t) => t.createMs < 1 && t.execMs < 1);
  if (allZero) {
    console.error('\ntti: every phase rounded to zero — refusing to score this run.');
    process.exit(1);
  }
}

const record = {
  version: '1.0',
  timestamp: new Date().toISOString(),
  target: endpoint,
  provider: 'nimbus',
  shape: args.shape,
  workload: { name: args.workload, ...workload, verify: undefined },
  config: {
    trials: args.trials,
    concurrency: args.shape === 'sequential' ? 1 : args.concurrency,
    staggerDelayMs: args.staggerDelayMs,
  },
  control: {
    rttSamplesMs: rttSamples,
    rttMedianMs: rttMedian,
    bareReadyMs: bareSamples,
    bareReadyMedianMs: bareMedian,
  },
  wallClockMs,
  trials,
  successRate: trials.length === 0 ? 0 : successes.length / trials.length,
};

const outPath = resolve(
  args.out ?? `bench-results/${args.workload}-${args.shape}-${Date.now()}.json`,
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);

console.log(`\nsuccess rate: ${(record.successRate * 100).toFixed(0)}% (${successes.length}/${trials.length})`);
if (successes.length > 0) {
  const sorted = successes.map((t) => t.ttiMs).sort((a, b) => a - b);
  console.log(`raw min/median/max: ${sorted[0].toFixed(0)} / ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} / ${sorted[sorted.length - 1].toFixed(0)}ms`);
}
console.log(`wrote ${outPath}`);
if (successes.length === 0) process.exit(1);
