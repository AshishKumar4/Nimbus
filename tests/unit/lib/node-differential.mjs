// Programs run by host Node and by `node` in a local workerd session, from
// one fixture tree: their stdout, stderr and exit code must be Node's, with
// the tree's place named `root` on both sides, a warning's pid as PID, and
// Node's own frames (those not under the tree) left out.
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

/**
 * Run each of `commands` (shell command lines, run in the tree's root) under
 * host Node and in the session, over `files` (paths relative to the root), and
 * fail naming every command whose output is not Node's.
 */
export async function matchNodeInWorkerd(label, root, files, commands) {
  const host = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  process.on('exit', () => rmSync(host, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(host, name)), { recursive: true });
    writeFileSync(join(host, name), text);
  }
  // The tree's place, the process's pid in a warning, and frames of the tree's own.
  const shown = (text, from) => text.split(from).join(root).replace(/^\(node:\d+\) /gm, '(node:PID) ')
    .split('\n').filter((line) => !/^\s+at /.test(line) || line.includes(`${root}/`)).join('\n');
  const run = (command) => `${command} > out.txt 2> err.txt; echo $? > code.txt`;
  const read = `node -e "const fs = require('fs'); process.stdout.write(JSON.stringify({ out: fs.readFileSync('out.txt').toString('base64'), err: fs.readFileSync('err.txt').toString('base64'), code: fs.readFileSync('code.txt', 'utf8') }))"`;
  const hostRead = (name) => spawnSync('cat', [name], { cwd: host, encoding: 'utf8' }).stdout;

  console.log(`${label}: starting local workerd`);
  const probe = await startLocalProbe({ runtimes: [] });
  const failures = [];
  try {
    const session = await localTerminal(probe, { install: [] });
    try {
      const dirs = [...new Set(Object.keys(files).map((name) => dirname(`${root}/${name}`)))];
      await session.run(`mkdir -p ${dirs.join(' ')}`, 30_000);
      for (const [name, text] of Object.entries(files)) await session.writeFile(`${root}/${name}`, text);
      for (const command of commands) {
        assert.equal(spawnSync('sh', ['-c', run(command)], { cwd: host, env: { PATH: process.env.PATH, HOME: host } }).status, 0);
        const want = { out: shown(hostRead('out.txt'), host), err: withoutInternalArrow(shown(hostRead('err.txt'), host)), code: hostRead('code.txt').trim() };
        await session.run(`cd ${root} && ${run(command)}`, 120_000);
        const r = await session.run(`cd ${root} && ${read}`, 60_000);
        const line = splitScenarioOutput(r.stdout).lines.find((l) => l.startsWith('{'));
        assert.ok(line, `${command}: read its output: ${r.stdout.slice(-1500)}`);
        const got = JSON.parse(line);
        const decode = (b64) => shown(Buffer.from(b64, 'base64').toString('utf8'), root);
        const seen = { out: decode(got.out), err: decode(got.err), code: got.code.trim() };
        const same = seen.out === want.out && seen.err === want.err && seen.code === want.code;
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
