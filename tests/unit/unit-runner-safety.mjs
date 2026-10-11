#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess, DEFAULT_TEST_TIMEOUT_MS } from '../../scripts/lib/bounded-process.mjs';

const root = mkdtempSync(join(tmpdir(), 'unit-safety-'));
const repo = fileURLToPath(new URL('../..', import.meta.url));
const unit = join(root, 'tests/unit');
const helper = join(root, 'scripts/lib');
mkdirSync(join(unit, 'lib'), { recursive: true });
mkdirSync(helper, { recursive: true });
for (const file of ['run-all.mjs', 'lib/partition.mjs']) copyFileSync(join(repo, 'tests/unit', file), join(unit, file));
copyFileSync(join(repo, 'scripts/lib/bounded-process.mjs'), join(helper, 'bounded-process.mjs'));
const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(predicate, label) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(); }
  assert.fail(`safety handshake never completed: ${label}`);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function fixture(name, source) { writeFileSync(join(unit, name + '.mjs'), source); }
// The workstation's wrapper requests one worker; repository defaults remain
// available to controlled CI runs.
const env = (name) => {
  return { ...process.env, NIMBUS_UNIT_ONLY: name, NIMBUS_UNIT_JOBS: '1' };
};
const run = (name, extra = []) => runBoundedProcess(process.execPath, [join(unit, 'run-all.mjs'), ...extra], {
  cwd: root, env: env(name), timeoutMs: 15_000, name: `runner safety ${name}`,
});
try {
  assert.ok(Number.isSafeInteger(DEFAULT_TEST_TIMEOUT_MS) && DEFAULT_TEST_TIMEOUT_MS > 0);
  fixture('failure', `console.log('consumer assertion detail'); process.exit(23);`);
  const failed = await run('failure');
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\(jobs 1\)/);
  assert.match(failed.stdout, /failure\.mjs.*FAIL/);
  assert.match(failed.stdout, /exit code=23/);
  assert.match(failed.stdout, /consumer assertion detail/);

  fixture('flood', `for (;;) process.stdout.write('x'.repeat(16384));`);
  const flooded = await run('flood');
  assert.equal(flooded.code, 1);
  assert.match(flooded.stdout, /flood\.mjs: output exceeded/);
  assert.ok(flooded.stdout.length < 12_000, 'diagnostics remain bounded even without newlines');

  // Both normal failure and timeout must remove descendants that inherited
  // the output pipes; waiting for close before killing would wedge here.
  for (const mode of ['failure', 'timeout', 'signal']) {
    const pidFile = join(root, `${mode}.pid`);
    const ready = join(root, `${mode}.ready`);
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n' + require('node:fs').readFileSync('/proc/self/cgroup')); setInterval(() => {}, 1000);`;
    fixture('tree', `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'inherit'});
      const check = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(pidFile)})) return;
        clearInterval(check); fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        ${mode === 'failure' ? 'process.exit(17);' : ''}
      }, 10);
      setInterval(() => {}, 1000);
    `);
    if (mode === 'signal') {
      const runner = spawn(process.execPath, [join(unit, 'run-all.mjs')], { env: env('tree'), cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let diagnostics = '';
      runner.stdout.on('data', () => {});
      runner.stderr.on('data', (d) => { diagnostics += d; process.stderr.write(d); });
      await until(() => existsSync(ready), 'signal child ready');
      const closed = new Promise((resolve) => runner.once('close', resolve));
      runner.kill('SIGTERM');
      assert.equal(await closed, 143);
      assert.match(diagnostics, /FAIL .*tree\.mjs: runner received SIGTERM/);
    } else {
      const result = await run('tree', mode === 'timeout' ? ['--timeout', '500'] : []);
      assert.equal(result.code, 1);
      assert.match(result.stdout, mode === 'timeout' ? /exceeded --timeout 500ms/ : /exit code=17/);
    }
    const [pid] = readFileSync(pidFile, 'utf8').trim().split('\n');
    // The descendant itself must end: the case's cgroup, where it has one,
    // stays populated by nothing else, and the host's by everything.
    await until(() => !alive(Number(pid)), `${mode}: pid ${pid}`);
  }
  const binary = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,128])); process.exit(7)'], { encoding: null });
  assert.equal(binary.reason, '', 'normal nonzero is not infrastructure failure');
  assert.equal(binary.code, 7);
  assert.deepEqual([...binary.stdout], [0, 255, 128]);
  console.log('unit-runner-safety: bounded diagnostics, timeout, failure and signal tree cleanup');
} finally {
  rmSync(root, { recursive: true, force: true });
}
