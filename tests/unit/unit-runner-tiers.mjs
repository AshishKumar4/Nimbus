#!/usr/bin/env bun
// run-all's tiers and report, and the CI plan's parts. A copy of the runner runs against
// fixture files in a scratch tree:
//   - `// @tier slow|quiet-cpu — <reason>` in the leading comment block
//     decides `--tier fast|slow|all`; a marker below it is a comment;
//   - an unknown tier, a marker without a reason, or two markers stop the
//     runner with exit 2 naming the file, whatever was selected;
//   - quiet-cpu files run after the pool, one at a time;
//   - the CI plan's parts (tests/unit/lib/partition.mjs) are disjoint,
//     cover the selection, are the same on every call, and balance the
//     expected time from the timings;
//   - `--json` records every file's tier, verdict, wall time and the CPU of
//     its whole process tree where the isolation can read it, and a failing
//     file's whole output;
//   - under NIMBUS_TEST_CGROUP (the CI containers' isolation) each case's
//     environment arrives unchanged, its CPU is its tree's, a case killed
//     with a nested runner inside leaves no group behind, and a file that
//     could not be started is reported as never started.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess } from '../../scripts/lib/bounded-process.mjs';
import { expectedCosts, partition } from './lib/partition.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'unit-tiers-'));

/** A scratch repository holding the runner and the given test files. */
function tree(label, files) {
  const root = join(scratch, label);
  mkdirSync(join(root, 'tests/unit/lib'), { recursive: true });
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  for (const file of ['run-all.mjs', 'lib/partition.mjs']) copyFileSync(join(repo, 'tests/unit', file), join(root, 'tests/unit', file));
  for (const lib of ['bounded-process.mjs', 'subprocess-entry.mjs']) copyFileSync(join(repo, 'scripts/lib', lib), join(root, 'scripts/lib', lib));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, 'tests/unit', name), source);
  return root;
}

// The selection this suite itself runs under must not reach the copy.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NIMBUS_UNIT_')));
const runner = (root, args, env = {}) => runBoundedProcess(process.execPath, [join(root, 'tests/unit/run-all.mjs'), ...args], {
  cwd: root, timeoutMs: 60_000, name: `run-all ${args.join(' ')}`,
  env: { ...inherited, NIMBUS_UNIT_JOBS: '2', ...env },
});

const listed = (result) => {
  assert.equal(result.code, 0, `--list failed: ${result.reason}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => line.split('\t'));
};

const pass = 'process.exit(0);\n';

try {
  // ── Markers and --tier ──────────────────────────────────────────────
  const marked = tree('marked', {
    'plain.mjs': pass,
    'slow-shebang.mjs': `#!/usr/bin/env bun\n// drives a local workerd\n// @tier slow — 40 s wall, 90 s CPU\n${pass}`,
    'quiet.mjs': `// @serial\n// @tier quiet-cpu: asserts 400 ms of ticks\n${pass}`,
    'after-blank.mjs': `// header\n\n// @tier slow - 12,000 files\n${pass}`,
    'below-code.mjs': `import 'node:fs';\n// @tier slow — not a marker: below the first statement\n${pass}`,
  });
  const all = listed(await runner(marked, ['--list']));
  assert.deepEqual(all.map(([name]) => name), ['after-blank.mjs', 'below-code.mjs', 'plain.mjs', 'quiet.mjs', 'slow-shebang.mjs']);
  assert.deepEqual(Object.fromEntries(all.map(([name, tier]) => [name, tier])), {
    'after-blank.mjs': 'slow', 'below-code.mjs': 'fast', 'plain.mjs': 'fast', 'quiet.mjs': 'quiet-cpu', 'slow-shebang.mjs': 'slow',
  });
  assert.deepEqual(listed(await runner(marked, ['--list', '--tier', 'fast'])).map(([name]) => name), ['below-code.mjs', 'plain.mjs']);
  assert.deepEqual(listed(await runner(marked, ['--list', '--tier', 'slow'])).map(([name]) => name), ['after-blank.mjs', 'quiet.mjs', 'slow-shebang.mjs']);
  assert.deepEqual(listed(await runner(marked, ['--list'], { NIMBUS_UNIT_TIER: 'slow' })).map(([name]) => name), ['after-blank.mjs', 'quiet.mjs', 'slow-shebang.mjs']);

  const badTier = await runner(marked, ['--list', '--tier', 'medium']);
  assert.equal(badTier.code, 2);
  assert.match(badTier.stderr, /--tier must be fast, slow or all/);

  for (const [label, source, error] of [
    ['unknown', `// @tier glacial — slow\n${pass}`, /unknown tier "glacial"/],
    ['fast-named', `// @tier fast — it is quick\n${pass}`, /unknown tier "fast"/],
    ['no-reason', `// @tier slow\n${pass}`, /expected `\/\/ @tier <name> — <reason>`/],
    ['twice', `// @tier slow — one\n// @tier quiet-cpu — two\n${pass}`, /2 @tier markers \(lines 1, 2\)/],
  ]) {
    // Malformed metadata stops every run, not only one that selects it.
    const result = await runner(tree(label, { 'fine.mjs': pass, [`${label}.mjs`]: source }), ['--list', '--tier', 'fast']);
    assert.equal(result.code, 2, `${label}: ${result.stdout}`);
    assert.match(result.stderr, new RegExp(`FATAL: ${label}\\.mjs: .*${error.source}`));
  }

  // ── Execution order and the JSON report ─────────────────────────────
  // quiet.mjs records when it ran; it must be after both pooled files ended.
  const order = join(scratch, 'order.log');
  const note = (label, ms) => `require('node:fs').appendFileSync(${JSON.stringify(order)}, '${label} start\\n'); setTimeout(() => require('node:fs').appendFileSync(${JSON.stringify(order)}, '${label} end\\n'), ${ms});\n`;
  // The CPU fixture burns 300 ms of CPU in a child process: the case's CPU
  // is its whole tree's, not only the test file's own process. It counts its
  // own CPU rather than the clock: on a loaded machine 300 ms of wall time
  // can hold much less CPU (it did in a 4-vCPU CI container, 2 runs in 5).
  const burn = `for (let i = 0; ; i++) if (i % 100000 === 0 && process.cpuUsage().user + process.cpuUsage().system >= 300000) break;`;
  const ran = tree('ran', {
    'a-pooled.mjs': note('a', 300),
    'b-pooled.mjs': `// @tier slow — measured\n${note('b', 300)}`,
    'c-quiet.mjs': `// @tier quiet-cpu — measured\n${note('c', 10)}`,
    'd-fails.mjs': `console.log('assertion detail'); process.exit(3);\n`,
    'e-cpu.mjs': `require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(burn)}], { stdio: 'inherit' });\n`,
  });
  const report = join(scratch, 'report.json');
  const result = await runner(ran, ['--json', report]);
  assert.equal(result.code, 1, result.stdout);
  const events = readFileSync(order, 'utf8').trim().split('\n');
  assert.ok(events.indexOf('c start') > events.indexOf('a end') && events.indexOf('c start') > events.indexOf('b end'), `quiet-cpu ran inside the pool: ${events.join(', ')}`);
  const json = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(json.version, 1);
  assert.equal(json.tier, 'all');
  assert.equal(json.pass, 4);
  assert.equal(json.fail, 1);
  const byName = Object.fromEntries(json.files.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(), ['a-pooled.mjs', 'b-pooled.mjs', 'c-quiet.mjs', 'd-fails.mjs', 'e-cpu.mjs']);
  assert.equal(byName['b-pooled.mjs'].tier, 'slow');
  assert.equal(byName['c-quiet.mjs'].serial, true);
  assert.equal(byName['a-pooled.mjs'].serial, false);
  assert.ok(byName['a-pooled.mjs'].wallMs >= 300, `wall ${byName['a-pooled.mjs'].wallMs}`);
  assert.equal(byName['d-fails.mjs'].ok, false);
  assert.match(byName['d-fails.mjs'].reason, /exit code=3/);
  assert.match(byName['d-fails.mjs'].stdoutTail, /assertion detail/);
  assert.match(byName['d-fails.mjs'].stdout, /assertion detail/, 'a failing file keeps its whole output');
  assert.equal(byName['a-pooled.mjs'].stdoutTail, undefined, 'a passing file carries no output');
  assert.equal(byName['a-pooled.mjs'].stdout, undefined, 'a passing file carries no output');
  const cpu = byName['e-cpu.mjs'].cpuMs;
  if (json.isolation !== 'systemd') {
    // The census names what a case started: the burning child is a bun.
    assert.ok(byName['e-cpu.mjs'].commands.includes('bun'), `commands ${byName['e-cpu.mjs'].commands}`);
  }
  if (json.isolation === 'portable') {
    assert.equal(cpu, null, 'portable cleanup cannot see a process tree\'s CPU');
  } else {
    assert.ok(cpu >= 250 && cpu < 5_000, `${json.isolation}: the case's tree used ~300 ms of CPU, read ${cpu}`);
  }

  // ── Parts (tests/unit/lib/partition.mjs, which scripts/ci/unit.mjs plans with) ─
  const files = {};
  const wallMs = {};
  for (let i = 0; i < 40; i++) {
    const name = `f${String(i).padStart(2, '0')}.mjs`;
    files[name] = i % 9 === 0 ? 'quiet-cpu' : 'pool';
    wallMs[name] = { wallMs: 1000 * (1 + ((i * 7) % 13)) };
  }
  delete wallMs['f05.mjs']; // Unmeasured: expected at the median.
  const names = Object.keys(files);
  const alone = (name) => files[name] === 'quiet-cpu';
  const expectedMs = expectedCosts(names, wallMs, alone);
  const parts = partition(names, 3, { expectedMs, runsAlone: alone, jobs: 2 }).map((part) => part.names);
  assert.deepEqual(partition(names, 3, { expectedMs, runsAlone: alone, jobs: 2 }).map((part) => part.names), parts, 'the same inputs give the same parts');
  assert.deepEqual(parts.flat().sort(), [...names].sort(), 'the parts cover the selection exactly once');
  // Balanced: with 2 jobs, no part expects much more than an even share.
  const expected = (name) => wallMs[name]?.wallMs ?? 7000;
  const costs = parts.map((part) => {
    const serial = part.filter(alone);
    const pooled = part.filter((name) => !alone(name));
    return Math.max(pooled.reduce((sum, n) => sum + expected(n), 0) / 2, ...pooled.map(expected)) + serial.reduce((sum, n) => sum + expected(n), 0);
  });
  assert.ok(Math.max(...costs) - Math.min(...costs) <= 13_000, `unbalanced parts: ${costs}`);
  // A file's cost is the larger of its wall and CPU time: one using four
  // CPUs for 10 s weighs 40 s, and gets a part to itself.
  const threadedTimings = { 'busy.mjs': { wallMs: 10_000, cpuMs: 40_000 }, 'a.mjs': { wallMs: 9_000, cpuMs: 9_000 }, 'b.mjs': { wallMs: 9_000, cpuMs: 9_000 }, 'c.mjs': { wallMs: 9_000, cpuMs: 9_000 } };
  const threaded = Object.keys(threadedTimings);
  const [first] = partition(threaded, 2, { expectedMs: expectedCosts(threaded, threadedTimings, () => false), runsAlone: () => false, jobs: 2 });
  assert.deepEqual(first.names, ['busy.mjs'], `the threaded file shares its part: ${first.names}`);

  // ── Environment, in whatever isolation this suite runs under ────────
  // Names a shell would drop or env(1) would take for an option still
  // reach the target, as do empty values.
  const odd = { '-odd': 'leading hyphen', 'a.b': 'dotted', EMPTY: '', EQ: 'a=b' };
  const echoed = await runBoundedProcess(process.execPath, ['-e', `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(odd))}.map((k) => [k, process.env[k]]))))`], {
    env: { ...inherited, ...odd }, timeoutMs: 30_000, name: 'odd environment',
  });
  assert.equal(echoed.code, 0, echoed.stderr);
  assert.deepEqual(JSON.parse(echoed.stdout), odd);

  // ── The CI containers' isolation: one cgroup per case ───────────────
  // Needs a cgroup this process may create groups in, as run-bounded's unit
  // and a CI task's case group are; elsewhere it is skipped, and says so.
  const own = `/sys/fs/cgroup${readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(\/.*)$/m)?.[1] ?? '/'}`;
  const groups = join(own, `unit-tiers-${process.pid}`);
  let delegated = false;
  try { mkdirSync(groups); delegated = true; } catch (error) {
    console.log(`  skipped: cgroup isolation (cannot create a group under ${own}: ${error.code})`);
  }
  if (delegated) {
    try {
      const cgroupEnv = { NIMBUS_TEST_PID_ISOLATION: '', NIMBUS_TEST_CGROUP: groups, ...odd };
      const sawEnv = join(scratch, 'saw-env.json');
      const cg = tree('cgroup', {
        'e-cpu.mjs': `require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(burn)}], { stdio: 'inherit' });\n`,
        'env.mjs': `require('node:fs').writeFileSync(${JSON.stringify(sawEnv)}, JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(odd))}.map((k) => [k, process.env[k]]))));\n`,
      });
      const cgReport = join(scratch, 'cgroup.json');
      const cgRun = await runner(cg, ['--json', cgReport], cgroupEnv);
      assert.equal(cgRun.code, 0, cgRun.stdout);
      const cgJson = JSON.parse(readFileSync(cgReport, 'utf8'));
      assert.equal(cgJson.isolation, 'cgroup');
      const cgCpu = cgJson.files.find((f) => f.name === 'e-cpu.mjs').cpuMs;
      assert.ok(cgCpu >= 250 && cgCpu < 5_000, `cgroup: the case's tree used ~300 ms of CPU, read ${cgCpu}`);
      assert.deepEqual(JSON.parse(readFileSync(sawEnv, 'utf8')), odd, 'the environment reaches the target unchanged');

      // A case killed while a runner inside it has cases of its own: every
      // group under it is removed, not only its own.
      const inner = tree('inner', { 'sleeps.mjs': 'setInterval(() => {}, 1000);\n' });
      const nested = tree('nested', {
        'outer.mjs': `require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(join(inner, 'tests/unit/run-all.mjs'))}], { stdio: 'inherit' });\n`,
      });
      const killed = await runner(nested, ['--timeout', '3000'], cgroupEnv);
      assert.equal(killed.code, 1, killed.stdout);
      assert.match(killed.stdout, /outer\.mjs: file exceeded --timeout 3000ms/);
      assert.deepEqual(readdirSync(groups, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name), [], 'no case group outlives its run');

      // No group to create cases in: the file never started, and the
      // report says so apart from a test that failed.
      const unstartable = await runner(tree('unstartable', { 'any.mjs': pass }), ['--json', cgReport], { ...cgroupEnv, NIMBUS_TEST_CGROUP: join(groups, 'missing') });
      assert.equal(unstartable.code, 1);
      const refused = JSON.parse(readFileSync(cgReport, 'utf8')).files[0];
      assert.match(refused.launchError, /cgroup isolation unavailable/);
    } finally {
      // Deepest first; a group that will not go is named, without hiding
      // the assertion that left it.
      const remove = (group) => {
        for (const entry of readdirSync(group, { withFileTypes: true })) if (entry.isDirectory()) remove(join(group, entry.name));
        try { rmdirSync(group); } catch (error) { console.error(`left cgroup ${group}: ${error.code}`); }
      };
      remove(groups);
    }
  }
  console.log('unit-runner-tiers: markers, tier selection, quiet-cpu ordering, CI parts, JSON report, environment and cgroup isolation');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
