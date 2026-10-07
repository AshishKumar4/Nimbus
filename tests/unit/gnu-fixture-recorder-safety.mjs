#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordFixture, assertUtf8Locale } from '../../scripts/record-gnu-fixtures.mjs';
import { runBoundedProcess } from '../../scripts/lib/bounded-process.mjs';

if (process.argv[2] === '--signal-recorder') {
  const [file, tempRoot] = process.argv.slice(3);
  try {
    await recordFixture(file, { tempRoot, timeoutMs: 3000 });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  await checkRecorder();
}

async function checkRecorder() {
  const root = mkdtempSync(join(tmpdir(), 'recorder-safety-'));
  const temps = join(root, 'temps');
  mkdirSync(temps);
  const file = join(root, 'cat.json');
  const options = { timeoutMs: 500, maxOutputBytes: 8192, tempRoot: temps };
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  function save(cases) {
    const bytes = JSON.stringify({ tool: 'cat', inputs: { data: Buffer.from([0xff, 0, 65]).toString('base64') }, cases }) + '\n';
    writeFileSync(file, bytes);
    return bytes;
  }
  function childProgram(lock, ready, action = '') {
    // flock -F retains the lock across exec; SIGSTOP cannot voluntarily release it.
    const child = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); fs.writeSync(3,'ready'); process.kill(process.pid,'SIGSTOP');`;
    return `const child=require('node:child_process').spawn('/usr/bin/flock',['-F','-x',${JSON.stringify(lock)},process.execPath,'-e',${JSON.stringify(child)}],{stdio:['ignore',1,2,'pipe']}); child.stdio[3].once('data',()=>{${action}});`;
  }
  async function lockStatus(lock) {
    const result = await runBoundedProcess('/usr/bin/flock', ['-n', lock, '/usr/bin/true'], { timeoutMs: 1000 });
    assert.equal(result.reason, '');
    return result.code;
  }
  function marker(path) {
    return new Promise((resolve, reject) => {
      const watcher = watch(root, check);
      const deadline = setTimeout(() => { watcher.close(); reject(new Error(`missing handshake ${path}`)); }, 4000);
      function check() {
        if (!existsSync(path) || readFileSync(path, 'utf8') !== 'ready') return;
        clearTimeout(deadline);
        watcher.close();
        resolve();
      }
      check();
    });
  }
  try {
    await assertUtf8Locale(options);
    save([{ args: 'data' }, { args: '%T data; exit 143' }]);
    await recordFixture(file, options);
    const recorded = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(recorded.cases.map(({ stdout, exit }) => [stdout, exit]), [['\xff\0A', 0], ['\xff\0A', 143]]);
    assert.deepEqual(readdirSync(temps), []);

    for (const [label, action, expected] of [
      ['timeout', '', /timeout|timed out/],
      ['signal', "process.kill(process.pid,'SIGTERM');", /signal|SIGTERM/],
      ['overflow', "for (;;) process.stdout.write('x'.repeat(1024));", /output limit/],
    ]) {
      const lock = join(root, `${label}.lock`);
      const ready = join(root, `${label}.ready`);
      const program = childProgram(lock, ready, action);
      const before = save([{ args: 'data', stdout: 'old', exit: 0 }, { args: `exec ${quote(process.execPath)} -e ${quote(program)}; : %T` }]);
      await assert.rejects(recordFixture(file, options), (error) => {
        assert.match(error.message, /cat.json case 2/);
        assert.match(error.message, expected, label);
        return true;
      }, label);
      assert.equal(readFileSync(ready, 'utf8'), 'ready');
      assert.equal(readFileSync(file, 'utf8'), before);
      assert.equal(await lockStatus(lock), 0, `${label}: stopped child released lock on death`);
      assert.deepEqual(readdirSync(temps), []);
      assert.equal(readdirSync(root).some((name) => name.startsWith('.gnu-record-')), false);
    }
    const before = save([{ args: 'data', stdout: 'previous', exit: 0 }]);
    const path = process.env.PATH;
    try {
      process.env.PATH = '';
      await assert.rejects(recordFixture(file, options), /cat.json case 1: spawn failed/);
    } finally {
      process.env.PATH = path;
    }
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(readdirSync(temps), []);
    await assert.rejects(recordFixture(file, { ...options, maxOutputBytes: 1 }), /cat --version: output limit exceeded/);
    assert.equal(readFileSync(file, 'utf8'), before);
    await assert.rejects(assertUtf8Locale({ ...options, maxOutputBytes: 1 }), /locale charmap: output limit exceeded/);

    const lock = join(root, 'recorder.lock');
    const ready = join(root, 'recorder.ready');
    const signalBefore = save([{ args: `exec ${quote(process.execPath)} -e ${quote(childProgram(lock, ready))}; : %T` }]);
    const recorder = spawn(process.execPath, [import.meta.filename, '--signal-recorder', file, temps], { stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    recorder.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
    const recording = new Promise((resolve, reject) => { recorder.on('error', reject); recorder.on('close', resolve); });
    try {
      await marker(ready);
      assert.equal(await lockStatus(lock), 1, 'child demonstrably holds lock before cancellation');
      recorder.kill('SIGTERM');
      assert.notEqual(await recording, 0);
    } finally {
      if (recorder.exitCode === null && recorder.signalCode === null) recorder.kill('SIGKILL');
    }
    assert.match(diagnostic, /SIGTERM/);
    assert.equal(readFileSync(file, 'utf8'), signalBefore);
    assert.deepEqual(readdirSync(temps), [], 'recorder SIGTERM runs finally');
    assert.equal(await lockStatus(lock), 0, 'recorder cancellation kills the stopped child');

    console.log('gnu-fixture-recorder-safety: bytes, nonzero exits, cancellation and cleanup');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
