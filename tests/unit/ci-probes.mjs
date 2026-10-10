#!/usr/bin/env bun
// scripts/ci/probes.mjs: the behavioral suite as one CI task. What a lane
// reads back from a container is its verdict, so this runs probes.mjs over
// the real runner (tests/behavioral/run-all.mjs, copied with its helpers
// into a fixture beside three probes of its own) and asserts the verdict:
// one row per probe of the part asked for, run-all's --part split, the exit
// status, and that the token never appears in it, whichever stream a probe
// printed it on.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeScreenshots } from '../../scripts/ci/lib/probe-screenshots.mjs';
import { gradeMatrix } from '../../scripts/ci/lib/matrix.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const TOKEN = `probe-token-${process.pid}-not-a-jwt`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHn0AAAAASUVORK5CYII=', 'base64');

const root = mkdtempSync(join(tmpdir(), 'ci-probes-'));
const server = createServer((request, response) => response.end('target')).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const behavioral = join(root, 'tests', 'behavioral');
  mkdirSync(behavioral, { recursive: true });
  mkdirSync(join(root, 'scripts', 'ci', 'lib'), { recursive: true });
  for (const file of ['run-all.mjs', '_probe-browser.mjs', '_ledger.mjs', '_session-transport.mjs', '_assertions.mjs']) copyFileSync(join(REPO, 'tests', 'behavioral', file), join(behavioral, file));
  copyFileSync(join(REPO, 'scripts', 'ci', 'probes.mjs'), join(root, 'scripts', 'ci', 'probes.mjs'));
  copyFileSync(join(REPO, 'scripts', 'ci', 'lib', 'probe-screenshots.mjs'), join(root, 'scripts', 'ci', 'lib', 'probe-screenshots.mjs'));
  const capture = `if (process.env.NIMBUS_PROBE_SCREENSHOTS) require('fs').writeFileSync(require('path').join(process.env.NIMBUS_PROBE_SCREENSHOTS, 'capture.png'), Buffer.from('${PNG.toString('base64')}', 'base64'));\n`;
  // Sorted, they are a, b, c, d: --part 1/2 is a and c, --part 2/2 is b and d.
  writeFileSync(join(behavioral, 'a.mjs'), "console.log('a sees ' + process.env.NIMBUS_PROBE_TOKEN + ' at ' + process.env.BASE);\n");
  writeFileSync(join(behavioral, 'b.mjs'), capture + "console.error('b fails holding ' + process.env.NIMBUS_PROBE_TOKEN); process.exit(3);\n");
  writeFileSync(join(behavioral, 'c.mjs'), capture + "console.log('c passes');\n");
  // A long line thick with the token: wherever a pipe read splits it, some
  // token is split across two reads.
  writeFileSync(join(behavioral, 'd.mjs'), "console.error(('x'.repeat(7) + process.env.NIMBUS_PROBE_TOKEN).repeat(6000)); process.exit(1);\n");

  // Spawned, not spawnSync: the target is this process's server, which must keep answering.
  const probes = async (args, env = {}) => {
    const out = join(root, `verdict-${Math.random().toString(36).slice(2)}.json`);
    const child = spawn(process.execPath, ['scripts/ci/probes.mjs', '--out', out, ...args], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: root, NIMBUS_PROBE_TOKEN: TOKEN, ...env },
    });
    const run = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => { run.stdout += chunk; });
    child.stderr.on('data', (chunk) => { run.stderr += chunk; });
    run.status = await new Promise((resolve) => child.on('close', resolve));
    const text = readFileSync(out, 'utf8');
    assert.doesNotMatch(text + run.stdout + run.stderr, new RegExp(TOKEN), 'the token appears nowhere: not in the verdict, not in the log');
    return { status: run.status, log: run.stdout + run.stderr, ...JSON.parse(text) };
  };
  const rows = (verdict) => verdict.rows.map((row) => [row.name, row.exitCode]);

  {
    for (const name of ['b', 'c']) {
      const verdict = await probes(['--base', base, '--only', name, '--screenshots', '1']);
      assert.equal(verdict.status, name === 'b' ? 1 : 0, verdict.log);
      const paths = writeScreenshots(join(root, 'captures-' + name), verdict.screenshots);
      assert.deepEqual(paths, [join(root, 'captures-' + name, 'capture.png')]);
      assert.deepEqual(readFileSync(paths[0]), PNG, 'armada task output returns the exact PNG, even when the probe fails');
      assert.throws(() => writeScreenshots(join(root, 'captures-' + name), verdict.screenshots), /EEXIST/, 'a repeated export cannot overwrite an artifact');
    }
    const dir = join(root, 'unsafe-captures');
    for (const name of ['../escape.png', '/absolute.png', 'not-a-png.txt']) {
      assert.throws(() => writeScreenshots(dir, [{ name, base64: PNG.toString('base64') }]), /invalid screenshot artifact/);
    }
    console.log('  ok  screenshot hooks return exact PNGs through the verdict on pass and failure; exports keep files in their task directory without overwriting');
  }
  {
    const verdict = await probes(['--base', base, '--part', '1/2', '--jobs', '2']);
    assert.equal(verdict.status, 0, verdict.log);
    assert.equal(verdict.part, '1/2');
    assert.deepEqual(rows(verdict).sort(), [['session-ledger', 0], ['tests/behavioral/a.mjs', 0], ['tests/behavioral/c.mjs', 0]]);
    assert.match(verdict.rows.find((row) => row.name === 'tests/behavioral/a.mjs').output, new RegExp(`a sees \\[NIMBUS_PROBE_TOKEN\\] at ${base}`));
    console.log('  ok  part 1/2 runs every other probe from the first, each a green row, and the token reads [NIMBUS_PROBE_TOKEN]');
  }
  {
    const verdict = await probes(['--base', base, '--part', '2/2']);
    assert.equal(verdict.status, 1);
    assert.deepEqual(rows(verdict).sort(), [['session-ledger', 0], ['tests/behavioral/b.mjs', 3], ['tests/behavioral/d.mjs', 1]]);
    assert.match(verdict.rows.find((row) => row.name === 'tests/behavioral/b.mjs').output, /b fails holding \[NIMBUS_PROBE_TOKEN\]/, 'a failing probe\'s stderr is in its row, scrubbed');
    assert.match(verdict.log, /(x{7}\[NIMBUS_PROBE_TOKEN\]){100}/, 'the long line passed through the log, every token in it scrubbed');
    console.log('  ok  part 2/2 is the rest: failing probes are red rows with their exit codes and output, the run exits 1, and a token split across reads is scrubbed');
  }
  {
    const verdict = await probes(['--base', base, '--only', 'c', '--skip', '']);
    assert.deepEqual(rows(verdict), [['tests/behavioral/c.mjs', 0], ['session-ledger', 0]]);
    for (const named of ['c.mjs', 'tests/behavioral/c.mjs']) {
      assert.deepEqual(rows(await probes(['--base', base, '--only', named])), [['tests/behavioral/c.mjs', 0], ['session-ledger', 0]], `--only ${named}`);
    }
    const none = await probes(['--base', base, '--only', 'c,nothing-by-this-name']);
    assert.equal(none.status, 2, 'a selection naming a probe that does not exist ran nothing it was asked to: never green');
    assert.match(none.rows[0].output, /names no probe for: nothing-by-this-name/);
    console.log('  ok  --only selects as run-all does, by name or file, an empty --skip skips nothing, and a name that matches no probe is not graded');
  }
  {
    const verdict = await probes(['--base', base], { NIMBUS_PROBE_TOKEN: '' });
    assert.equal(verdict.status, 2);
    assert.deepEqual(rows(verdict), [['probes', 2]]);
    assert.match(verdict.rows[0].output, /NIMBUS_PROBE_TOKEN is not set/);
    const unreachable = await probes(['--base', 'http://127.0.0.1:9']);
    assert.equal(unreachable.status, 2);
    assert.match(unreachable.rows[0].output, /is unreachable/);
    const late = await probes(['--base', base, '--start-by', String(Date.now() - 1000)]);
    assert.equal(late.status, 2);
    assert.deepEqual(rows(late), [['probes', 2]]);
    assert.match(late.rows[0].output, /the token could expire before its limit/);
    console.log('  ok  no token, a target that does not answer, or a task that starts too late for its token is not graded (2), with a row saying why');
  }
  {
    mkdirSync(join(behavioral, 'frameworks'));
    const path = join(behavioral, 'frameworks', 'remix-real.mjs');
    const entry = { probe: 'frameworks/remix-real', assertion: 'launch', failure: { detail: 'approved failure' },
      reason: 'fixture', approved: 'user, 2026-10-10', owner: 'fixture', tracking: 'fixture' };
    const run = async complete => {
      writeFileSync(path, `import {makeAsserter} from '../_assertions.mjs';\nconst a=makeAsserter('frameworks/remix-real');\na.check('setup',true);a.check('launch',false,'approved failure: Bearer '+process.env.NIMBUS_PROBE_TOKEN);a.check('cleanup',true);\n${complete ? 'a.summary();' : ''}\nprocess.exit(1);`);
      return probes(['--base', base, '--only', entry.probe]);
    };
    const complete = await run(true);
    const checked = complete.rows.find(row => row.name.endsWith('remix-real.mjs')).assertions;
    assert.equal(checked[0].complete, true);
    assert.equal(checked[0].checks.length, 3);
    assert.doesNotMatch(JSON.stringify(checked), new RegExp(TOKEN));
    assert.equal(gradeMatrix([{ tasks: [{ task: 'fixture', rows: complete.rows }] }], [entry]).exitCode, 0,
      'real producer → runner IPC → probes JSON → release grading covers the exact completed failure');
    const partial = await run(false);
    assert.equal(gradeMatrix([{ tasks: [{ task: 'fixture', rows: partial.rows }] }], [entry]).exitCode, 1,
      'the same failure without producer completion stays red, independent of printed output');
  }
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
console.log('ci-probes OK');
