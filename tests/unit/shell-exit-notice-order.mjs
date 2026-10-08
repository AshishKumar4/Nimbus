#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { _emitExitDump, _emitShellExecDone, _reportExternalExit, _rpcReportExit } from '../../packages/worker/src/session/rpc.ts';
import { stripAnsi } from '../behavioral/_driver.mjs';
import { testBox } from './lib/test-box.mjs';

const failures = [];
async function scenario(name, exercise) {
  let output = '';
  const terminal = { write(data) { output += data; }, writeln(data) { output += data + '\n'; }, onData() {}, focus() {}, clear() {}, cols: 80, rows: 24, ws: null };
  const box = await testBox({ terminal });
  const processes = new SessionProcessSupervisor();
  const host = {
    shell: box.shell, terminal, processes, nimbusDebug: true,
    facetManager: { noteProcessReportedExit(pid, code) { processes.exit(pid, code); processes.setForeground(pid, false); } },
    _emitExitDump(pid, code) { _emitExitDump(host, pid, code); },
  };
  try {
    box.shell.printPrompt();
    output = '';
    await exercise({ box, host, processes, text: () => stripAnsi(output), reset: () => { output = ''; } });
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  } finally {
    await box.workspace.close();
  }
}

await scenario('a normal foreground exit is silent even in debug mode', async ({ box, host, processes, text, reset }) => {
  const entry = processes.spawn('pi -p say-ok', [], '/home/user', { longRunning: true });
  processes.setForeground(entry.pid, true);
  await _rpcReportExit(host, entry.pid, 0, '');
  _emitShellExecDone(host, entry.pid, entry.command, 0, 100);
  assert.equal(text(), '', 'neither report nor finalizer writes a successful foreground exit notice');
  box.shell.printPrompt();
  assert.ok(!/exited/.test(text()));
  reset();
  const attached = processes.spawn('pi -p attached', [], '/home/user', { longRunning: true, attachedTty: true });
  await _rpcReportExit(host, attached.pid, 0, '');
  _emitShellExecDone(host, attached.pid, attached.command, 0, 100);
  box.shell.printPrompt();
  assert.ok(!/exited/.test(text()), 'a normally completed attached CLI is silent on the parent shell');
  reset();
  const late = processes.spawn('node -e ok', [], '/home/user');
  await box.shell.executeLine('echo LATER');
  const before = text();
  await _rpcReportExit(host, late.pid, 0, '');
  assert.equal(text(), before, 'a late normal exit cannot appear after a later command\'s prompt');
});

await scenario('a background exit waits for the next primary prompt, including PS2', async ({ box, host, processes, text, reset }) => {
  const entry = processes.spawn('node server.js', [], '/home/user', { longRunning: true });
  await _rpcReportExit(host, entry.pid, 0, '');
  assert.equal(text(), '', 'idle job status is deferred rather than appended after a prompt');
  await box.shell.handleInput('echo "open\r');
  assert.ok(!text().includes('[facet exited:'), 'PS2 does not flush a job status');
  reset();
  await box.shell.handleInput('\x03');
  const shown = text();
  assert.match(shown, /\[facet exited:/);
  assert.ok(shown.indexOf('[facet exited:') < shown.lastIndexOf('user@nimbus:'), shown);
});

await scenario('an abnormal foreground exit is shown once, before its prompt', async ({ box, host, processes, text, reset }) => {
  const entry = processes.spawn('pi -p failing', [], '/home/user');
  processes.setForeground(entry.pid, true);
  processes.appendOutput(entry.pid, 'stderr', 'failure context\n');
  await _rpcReportExit(host, entry.pid, 7, '');
  _emitShellExecDone(host, entry.pid, entry.command, 7, 100);
  assert.equal(text(), '', 'both report paths enqueue, never write behind an existing prompt');
  box.shell.printPrompt();
  assert.equal((text().match(/failure context/g) ?? []).length, 1, 'the two exit paths share one notice');
  assert.ok(text().indexOf('failure context') < text().lastIndexOf('user@nimbus:'), text());
  reset();
  box.shell.printPrompt();
  assert.ok(!text().includes('failure context'), 'a later prompt does not replay the notice');
});

await scenario('an external abnormal exit is queued until a running command ends', async ({ box, host, processes, text }) => {
  const gate = Promise.withResolvers();
  box.commands.registry.register('hold', async () => { await gate.promise; return 0; });
  const command = box.shell.executeLine('hold');
  const before = text();
  const entry = processes.spawn('node worker.js', [], '/home/user', { longRunning: true });
  _reportExternalExit(host, entry.pid, 137, 'host lost');
  assert.equal(text(), before, 'an exit callback cannot inject an unordered notice into a later command');
  gate.resolve();
  await command;
  assert.match(text(), /host lost/);
  assert.ok(text().indexOf('host lost') < text().lastIndexOf('user@nimbus:'), text());
});

assert.deepEqual(failures, []);
console.log('shell-exit-notice-order: PASS');
