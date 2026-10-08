#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { _emitExitDump, _emitShellExecDone, _reportExternalExit, _rpcReportExit } from '../../packages/worker/src/session/rpc.ts';
import { stripAnsi } from '../behavioral/_driver.mjs';
import { testBox } from './lib/test-box.mjs';
import { installLogPersistence } from '../../packages/worker/src/session/hibernation.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { HeredocHandler } from '../../packages/core/src/shell/features.ts';

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
    await exercise({ box, host, processes, terminal, text: () => stripAnsi(output), reset: () => { output = ''; } });
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
  assert.equal((text().match(/failure context/g) ?? []).length, 1, 'program diagnostics appear immediately and once');
  assert.ok(!/Process .*exited with code|\[facet exited|\[shell exited/.test(text()), 'only status lines wait for a prompt');
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
  assert.match(text().slice(before.length), /host lost/, 'the actual abnormal diagnostic is delivered immediately');
  assert.ok(!text().slice(before.length).includes('exited with code'), 'its status remains queued');
  gate.resolve();
  await command;
  assert.match(text(), /host lost/);
  assert.ok(text().indexOf('host lost') < text().lastIndexOf('user@nimbus:'), text());
});

await scenario('held foreground notices do not pin log tails after capped-store eviction', async ({ box, host, processes, text, reset }) => {
  const gate = Promise.withResolvers();
  box.commands.registry.register('hold', async () => { await gate.promise; return 0; });
  const command = box.shell.executeLine('hold');
  let rendered = 0;
  const tailLogs = processes.tailLogs.bind(processes);
  processes.tailLogs = (...args) => { rendered++; return tailLogs(...args); };
  try {
    for (let index = 0; index < 600; index++) {
      const entry = processes.spawn('node failed-background.js', [], '/home/user', { longRunning: true });
      processes.appendOutput(entry.pid, 'stderr', `TAIL_${index}_` + 'x'.repeat(63 * 1024));
      await _rpcReportExit(host, entry.pid, 7, '');
    }
    assert.equal(rendered, 600, 'each real diagnostic is read once for immediate delivery, never stored in the queued status');
    reset();
    gate.resolve();
    await command;
    assert.equal(rendered, 600, 'rendering status at a prompt must not reread or retain log tails');
    assert.ok(!text().includes('TAIL_0_'), 'the queue cannot resurrect evicted bytes');
    assert.match(text(), /exited with code 7/, 'still-retained exit status is shown');
  } finally {
    gate.resolve();
    await command;
  }
});

await scenario('an attached program\'s crash stderr appears before another user input', async ({ box, host, processes, text }) => {
  const entry = processes.spawn('async-attached-crash', [], '/home/user', { longRunning: true, attachedTty: true });
  const promptBeforeExit = text();
  await _rpcReportExit(host, entry.pid, 1, 'Error: ASYNC_TUI_FAILURE\n    at program.js:1\n');
  assert.notEqual(text(), promptBeforeExit, 'actual program diagnostics cannot wait for another shell prompt');
  assert.match(text(), /Error: ASYNC_TUI_FAILURE/);
  assert.ok(!/\[facet exited:|Process .* exited with code/.test(text()), 'only job status is deferred');
  const beforeNextPrompt = text();
  box.shell.printPrompt();
  assert.ok(text().slice(beforeNextPrompt.length).includes('exited with code 1'), 'status precedes the next primary prompt');
});

await scenario('a background crash preserves heredoc PS2 without inventing primary readiness', async ({ box, host, processes, terminal, text, reset }) => {
  const control = [];
  terminal.shellIntegration = (event) => control.push(event);
  HeredocHandler.install(box.shell, terminal);
  await box.shell.handleInput("cat > /home/user/mid-crash <<'EOF'\r");
  assert.ok(text().endsWith('> '), 'the heredoc is awaiting data under PS2');
  reset();
  control.length = 0;
  const crashed = processes.spawn('background-failure', [], '/home/user', { longRunning: true });
  await _rpcReportExit(host, crashed.pid, 1, 'Error: MID_HEREDOC_CRASH\n');
  assert.match(text(), /MID_HEREDOC_CRASH/);
  assert.ok(text().replace(/\r$/, '').endsWith('> '), 'stderr redraw keeps the actual heredoc continuation prompt: ' + JSON.stringify(text()));
  assert.ok(!text().includes('user@nimbus:'), 'there is no false primary prompt');
  assert.deepEqual(control, [], 'redraw manufactures no primary/completion control event');
  await box.shell.handleInput('kept-data\r');
  await box.shell.handleInput('EOF\r');
  assert.equal(box.root.readFileString('home/user/mid-crash'), 'kept-data\n');
  assert.ok(text().endsWith('user@nimbus:~$ '), 'the completed heredoc reaches the real primary prompt');
});

for (const persisted of [false, true]) {
  await scenario('notice pruning is passive before the deferred SQL flush: persisted=' + persisted, async ({ box, host, processes, text, reset }) => {
    const disk = createSqliteVfsTestHarness();
    const gate = Promise.withResolvers();
    box.commands.registry.register('hold', async () => { await gate.promise; return 0; });
    const command = box.shell.executeLine('hold');
    let activity = 0;
    installLogPersistence(host, { storage: { ...disk.ctx.storage, sql: disk.sql } }, () => { activity++; }, () => {});
    try {
      for (let index = 0; index < 500; index++) {
        const entry = processes.spawn('node background.js', [], '/home/user', { longRunning: true });
        processes.appendOutput(entry.pid, 'stderr', `SQL_TAIL_${index}\n`);
        await _rpcReportExit(host, entry.pid, 7, '');
      }
      if (persisted) processes.flushLogs();
      const sqlRowsBefore = [...disk.sql.exec('SELECT count(*) AS n FROM w9_proc_logs')][0].n;
      const hydratedBefore = processes.logHibStats().rehydratedPids;
      const statementsBefore = disk.statements.length;
      const newcomer = processes.spawn('node newest.js', [], '/home/user', { longRunning: true });
      processes.appendOutput(newcomer.pid, 'stderr', 'NEWEST_UNFLUSHED\n');
      await _rpcReportExit(host, newcomer.pid, 7, '');
      assert.ok(activity > 0, 'the real persistence adapter scheduled a future flush');
      assert.equal([...disk.sql.exec('SELECT count(*) AS n FROM w9_proc_logs')][0].n, sqlRowsBefore, 'the debounce flush is still deferred');
      assert.equal(processes.logHibStats().rehydratedPids, hydratedBefore, 'pruning does not reload an evicted tail from SQL');
      const loads = disk.statements.slice(statementsBefore).filter((entry) => /SELECT .* FROM w9_proc_(logs|exits) WHERE pid =/.test(entry.sql));
      assert.equal(loads.length, 2, 'only the newcomer\'s normal creation checks its two SQL tables');
      assert.ok(loads.every((entry) => entry.params[0] === newcomer.pid), 'notice membership never queries old SQL rows');
      reset();
      gate.resolve();
      await command;
      assert.ok(!text().includes('SQL_TAIL_0\r\n'), 'an evicted SQL tail is not resurrected before its queued deletion flushes');
      assert.ok(processes.retainsLogs(newcomer.pid), 'the newest unflushed record is retained');
      assert.ok(text().includes(`Process ${newcomer.pid} (`), 'the current status is shown, without replaying program diagnostics');
    } finally {
      gate.resolve();
      await command;
      disk.db.close();
    }
  });
}

assert.deepEqual(failures, []);
console.log('shell-exit-notice-order: PASS');
