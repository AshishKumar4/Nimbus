#!/usr/bin/env bun
// Experiment (work/d3-measure, not for landing): the two inputs of the bound
// on what a node one-shot's launch stages by guess (D3, B).
//   stage: what a guessed working-tree file costs every warm launch of
//     `node -e 0`: a tree with nothing, one 1 MiB file, one 2 MiB file, and
//     400 files of 1 KiB in 20 directories, rotated each round. The map's
//     file count (NIMBUS_DEBUG) shows what was staged.
//   rerun: what a synchronous miss costs: a one-shot reading a file no run
//     read before (it stops and runs again as a resident, D2.1), then the
//     same command twice more (its map rebuilt with the learned file, then
//     warm). The miss costs the first run less the third.
// One JSON line a run.
import { mintSession, deleteSession, Terminal, heredocCommand, stripAnsi } from '../../_driver.mjs';

const ROUNDS = Number(process.env.ROUNDS ?? 12);
const TREES = {
  none: [],
  'one 1 MiB': [['data.bin', 1024 * 1024]],
  'one 2 MiB': [['data.bin', 2 * 1024 * 1024]],
  '400 of 1 KiB': Array.from({ length: 400 }, (_, i) => [`d${i % 20}/f${i}.txt`, 1024]),
};
const out = (record) => console.log(JSON.stringify(record));
const mapFiles = (text) => {
  const found = /module map: (\d+) files/.exec(stripAnsi(text));
  return found === null ? null : Number(found[1]);
};
const timed = async (t, line) => {
  const started = performance.now();
  const r = await t.run(line, 300_000);
  return { ms: Math.round(performance.now() - started), exit: r.exitCode, output: r.output };
};

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const make = [];
  for (const [name, files] of Object.entries(TREES)) {
    const dir = `/home/user/d3/${name.replace(/\W+/g, '-')}`;
    make.push(`mkdir -p ${dir}`);
    for (const [file, bytes] of files) {
      make.push(`mkdir -p $(dirname ${dir}/${file}) && head -c ${bytes} /dev/urandom > ${dir}/${file}`);
    }
  }
  // One shell line per 40 commands, so setup is not 400 round trips.
  for (let i = 0; i < make.length; i += 40) {
    const r = await t.run(make.slice(i, i + 40).join(' && '), 120_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${r.output.slice(-300)}`);
  }
  for (const line of ['mkdir -p /home/user/d3m/app /home/user/d3m/data',
    heredocCommand('/home/user/d3m/app/m.js', "console.log('LEN=' + require('fs').readFileSync(process.argv[2]).length);")]) {
    const r = await t.run(line, 30_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${r.output.slice(-300)}`);
  }
  const names = Object.keys(TREES);
  const dirOf = (name) => `/home/user/d3/${name.replace(/\W+/g, '-')}`;
  // Two warm-ups each: the first builds the map, the second takes it from the cache.
  for (const name of names) for (let i = 0; i < 2; i++) await timed(t, `cd ${dirOf(name)} && node -e 0`);
  for (let round = 1; round <= ROUNDS; round++) {
    for (let k = 0; k < names.length; k++) {
      const name = names[(k + round) % names.length];
      const r = await timed(t, `cd ${dirOf(name)} && node -e 0`);
      out({ kind: 'stage', round, tree: name, ms: r.ms, exit: r.exit, mapFiles: mapFiles(r.output) });
    }
    const file = `/home/user/d3m/data/f${round}.txt`;
    await t.run(`head -c 1024 /dev/urandom > ${file}`, 30_000);
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const r = await timed(t, `cd /home/user/d3m/app && node m.js ${file}`);
      runs.push({ ms: r.ms, exit: r.exit, read: stripAnsi(r.output).includes('LEN=1024'), mapFiles: mapFiles(r.output) });
    }
    out({ kind: 'rerun', round, runs, missMs: runs[0].ms - runs[2].ms });
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.stack ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
