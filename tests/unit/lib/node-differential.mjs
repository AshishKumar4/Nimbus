// Programs run by host Node and by `node` in a local workerd session, from
// one fixture tree: what each printed, and its exit code, must be Node's.
// What is compared of a stream is what `shown` keeps of it: by default the
// tree's place named `root` on both sides, a warning's pid as PID, and
// Node's own frames (those not under the tree) and its internal arrow left
// out. A caller whose programs differ from Node only in what it knowingly
// leaves out passes its own `shown`, and `streams` names what it compares.
//
// Runs the worker built in the tree (workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './workerd-probe.mjs';
import { withoutInternalArrow } from './node-report.mjs';

/** A shell word that is `text` exactly. */
export const shellWord = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/** `text` printed where the tree is `from`, with that place named `root`. */
export const placed = (text, from, root) => text.split(from).join(root);

/**
 * The default of what is compared of `stream` ('out' or 'err') printed on
 * `side` ('node', host Node, or 'workerd'): the tree's place named `root`, a
 * warning's pid as PID, frames not under the tree left out, and, of Node's
 * stderr, its internal arrow (the runtime prints none).
 */
export function nodeShown(text, { stream, side, from, root }) {
  const kept = placed(text, from, root).replace(/^\(node:\d+\) /gm, '(node:PID) ')
    .split('\n').filter((line) => !/^\s+at /.test(line) || line.includes(`${root}/`)).join('\n');
  return stream === 'err' && side === 'node' ? withoutInternalArrow(kept) : kept;
}

/**
 * Run each of `commands` (shell command lines, run in the tree's root) under
 * host Node and in the session, over `files` (paths relative to the root),
 * and fail naming every command whose exit code, or whose `streams` as
 * `shown(text, { stream, side, from, root, command })` keeps them, are not
 * Node's.
 */
export async function matchNodeInWorkerd(label, root, files, commands, { shown = nodeShown, streams = ['out', 'err'] } = {}) {
  const host = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  process.on('exit', () => rmSync(host, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(host, name)), { recursive: true });
    writeFileSync(join(host, name), text);
  }
  const run = (command) => `${command} > out.txt 2> err.txt; echo $? > code.txt`;
  const read = `node -e "const fs = require('fs'); process.stdout.write(JSON.stringify({ out: fs.readFileSync('out.txt').toString('base64'), err: fs.readFileSync('err.txt').toString('base64'), code: fs.readFileSync('code.txt', 'utf8') }))"`;
  const hostRead = (name) => spawnSync('cat', [name], { cwd: host, encoding: 'utf8' }).stdout;
  /** A run's compared streams and exit code; `text(stream)` is what it printed there, on `side`, where the tree is `from`. */
  const compared = (command, side, from, text, code) => ({
    ...Object.fromEntries(streams.map((stream) => [stream, shown(text(stream), { stream, side, from, root, command })])),
    code: code.trim(),
  });

  console.log(`${label}: starting local workerd`);
  const probe = await startLocalProbe({ runtimes: [] });
  const failures = [];
  try {
    const session = await localTerminal(probe, { install: [] });
    try {
      const dirs = [...new Set(Object.keys(files).map((name) => dirname(`${root}/${name}`)))];
      const made = await session.run(`mkdir -p ${dirs.map(shellWord).join(' ')}`, 30_000);
      assert.equal(made.status, 0, `the fixture tree's directories: ${made.stdout}`);
      for (const [name, text] of Object.entries(files)) await session.writeFile(`${root}/${name}`, text);
      for (const command of commands) {
        assert.equal(spawnSync('sh', ['-c', run(command)], { cwd: host, env: { PATH: process.env.PATH, HOME: host } }).status, 0);
        const want = compared(command, 'node', host, (stream) => hostRead(`${stream}.txt`), hostRead('code.txt'));
        await session.run(`cd ${root} && ${run(command)}`, 120_000);
        const r = await session.run(`cd ${root} && ${read}`, 60_000);
        const line = splitScenarioOutput(r.stdout).lines.find((l) => l.startsWith('{'));
        assert.ok(line, `${command}: read its output: ${r.stdout.slice(-1500)}`);
        const got = JSON.parse(line);
        const seen = compared(command, 'workerd', root, (stream) => Buffer.from(got[stream], 'base64').toString('utf8'), got.code);
        const same = JSON.stringify(seen) === JSON.stringify(want);
        console.log(`  ${same ? 'ok ' : 'BAD'} ${command.replace(/\s+/g, ' ').slice(0, 70)}: exit ${want.code}`);
        if (!same) failures.push({ command, want, seen });
      }
    } finally {
      await session.close().catch(() => {});
    }
  } finally {
    await probe.stop();
  }
  for (const { command, want, seen } of failures) {
    console.log(`--- ${command}\n  want: ${JSON.stringify(want)}\n  seen: ${JSON.stringify(seen)}`);
  }
  assert.deepEqual(failures.map((f) => f.command), [], 'every program runs as Node runs it');
  console.log(`${label}: ${commands.length} programs as Node runs them`);
}
