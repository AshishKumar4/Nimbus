#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordFixture, assertUtf8Locale } from '../../scripts/record-gnu-fixtures.mjs';
import { runBoundedProcess } from '../../scripts/lib/bounded-process.mjs';

if (process.argv[2] === '--signal-recorder') {
  const [file, tempRoot, ready] = process.argv.slice(3);
  writeFileSync(ready, String(process.pid));
  try {
    await recordFixture(file, { tempRoot, timeoutMs: 3000 });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {

const root = mkdtempSync(join(tmpdir(), 'recorder-safety-'));
const temps = join(root, 'temps');
mkdirSync(temps);
const file = join(root, 'cat.json');
const pidFile = join(root, 'child.pid');
const options = { timeoutMs: 500, maxOutputBytes: 8192, tempRoot: temps };
const fixture = (cases) => ({ tool: 'cat', inputs: { data: Buffer.from([0xff, 0, 65]).toString('base64') }, cases });
function save(cases) {
  const bytes = JSON.stringify(fixture(cases)) + '\n';
  writeFileSync(file, bytes);
  return bytes;
}
function assertGone(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z', `descendant ${pid} is still running`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function marker(path) {
  return new Promise((resolve, reject) => {
    const watcher = watch(root, check);
    const deadline = setTimeout(() => { watcher.close(); reject(new Error(`missing handshake ${path}`)); }, 3000);
    function check() {
      if (!existsSync(path)) return;
      const value = readFileSync(path, 'utf8').trim();
      if (!value) return;
      clearTimeout(deadline);
      watcher.close();
      resolve(Number(value));
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

  for (const [label, command, expected] of [
    ['timeout', `sleep 30 & echo $! > '${pidFile}'; wait; : %T`, /timeout|timed out/],
    ['signal', `sleep 30 & echo $! > '${pidFile}'; kill -TERM $$; : %T`, /signal|SIGTERM/],
    ['overflow', `sleep 30 & echo $! > '${pidFile}'; while :; do printf '%0100d' 1; done; : %T`, /output limit/],
  ]) {
    const before = save([{ args: 'data', stdout: 'old', exit: 0 }, { args: command }]);
    await assert.rejects(recordFixture(file, options), (error) => {
      assert.match(error.message, /cat.json case 2/);
      assert.match(error.message, expected, label);
      return true;
    }, label);
    assert.equal(readFileSync(file, 'utf8'), before, `${label}: fixture must remain byte-identical`);
    assertGone(Number(readFileSync(pidFile, 'utf8').trim()));
    assert.deepEqual(readdirSync(temps), [], `${label}: private bins and inputs removed`);
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

  const recorderPid = join(root, 'recorder.pid');
  const liveChild = join(root, 'live-child.pid');
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  const child = `require('node:fs').writeFileSync(${JSON.stringify(liveChild)},String(process.pid)); process.kill(process.pid,'SIGSTOP');`;
  const signalBefore = save([{ args: `${quote(process.execPath)} -e ${quote(child)}; : %T` }]);
  const recording = runBoundedProcess(process.execPath, [import.meta.filename, '--signal-recorder', file, temps, recorderPid], { timeoutMs: 5000 });
  const [recorder, descendant] = await Promise.all([marker(recorderPid), marker(liveChild)]);
  process.kill(recorder, 'SIGTERM');
  const interrupted = await recording;
  assert.notEqual(interrupted.code, 0);
  assert.match(interrupted.stderr, /SIGTERM/);
  assert.equal(readFileSync(file, 'utf8'), signalBefore);
  assert.deepEqual(readdirSync(temps), [], 'recorder SIGTERM runs finally for private bin and case directories');
  assertGone(descendant);
  const escapedPid = join(root, 'escaped.pid');
  const escapedCode = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(escapedPid)},String(process.pid)); fs.writeSync(3,'ready'); process.kill(process.pid,'SIGSTOP');`;
  const parentCode = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(escapedCode)}],{detached:true,stdio:['ignore',1,2,'pipe']}); child.stdio[3].once('data',()=>process.exit(0));`;
  const escaped = await runBoundedProcess(process.execPath, ['-e', parentCode], { timeoutMs: 2000 });
  assert.equal(escaped.reason, '', 'leader exit cleans detached pipe holders without waiting for timeout');
  assert.equal(escaped.code, 0);
  assertGone(Number(readFileSync(escapedPid, 'utf8')));
  console.log('gnu-fixture-recorder-safety: bytes, nonzero exits, timeout, signal and overflow');
} finally {
  rmSync(root, { recursive: true, force: true });
}
}
