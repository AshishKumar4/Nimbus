#!/usr/bin/env bun
// An opencode process's files are in the session before its end is.
//
// Each disposition of the generated runner is run with a program of its own
// for the opencode bundle: it writes a file synchronously and exits. The
// session holds the write that carries the file. Until it is answered the
// resident runners (the attached TUI, `opencode serve`) do not report the
// exit, and the one-shot runner does not answer its run; once it is, they
// do, with the program's exit code and the file in the session. The one-shot
// runner never reports an exit itself: its manager does.
//
// Each disposition runs in a child process of its own (importOpencodeRunner).

import assert from 'node:assert/strict';

const realProcess = globalThis.process;
const realExit = realProcess.exit.bind(realProcess);
const realStdout = realProcess.stdout.write.bind(realProcess.stdout);
const realStderr = realProcess.stderr.write.bind(realProcess.stderr);

// The program's own fs, as opencode's import of node:fs reaches it (the map's bridge to the shims).
const writesThenExits = (code) => `
const fs = globalThis.__nimbusOpencodeBuiltins.fs;
export async function nimbusMain() {
  fs.writeFileSync("/home/user/out.txt", "durable");
  process.exit(${code});
}
`;
// A server: its main resolves once it serves, and it exits later.
const servesThenExits = (code) => `
const fs = globalThis.__nimbusOpencodeBuiltins.fs;
export async function nimbusMain() {
  setTimeout(() => {
    fs.writeFileSync("/home/user/out.txt", "durable");
    process.exit(${code});
  }, 0);
}
`;
const DISPOSITIONS = {
  oneshot: { program: writesThenExits(3), code: 3 },
  attached: { program: writesThenExits(4), code: 4 },
  server: { program: servesThenExits(5), code: 5 },
};

const mode = realProcess.env.NIMBUS_EXIT_ORDERING_MODE;
if (mode) {
  try {
    const { CRED, createAuthority, facetSql, sleep, until } = await import('./lib/resident-body.mjs');
    const { opSender, supervisorDouble } = await import('./lib/supervisor-double.mjs');
    const { importOpencodeRunner } = await import('./lib/opencode-runner-module.mjs');
    const authority = createAuthority();
    const { pid } = authority.host.processes.spawn('opencode', ['opencode'], '/home/user', { cred: CRED, longRunning: mode !== 'oneshot' });
    const send = opSender((envelope) => authority.host.supervisorOp({ ...envelope, pid }));
    const events = [];
    const release = Promise.withResolvers();
    const reported = Promise.withResolvers();
    const supervisor = supervisorDouble(async (name, args) => {
      if (name === 'stdout' || name === 'stderr') return;
      if (name === 'reportExit') { events.push(`reportExit ${args[0]}`); reported.resolve(); return; }
      if (name !== 'writeBatchStream') return send(name, args);
      events.push('write');
      await release.promise;
      const answer = await send(name, args);
      events.push('write answered');
      return answer;
    });

    const { program, code } = DISPOSITIONS[mode];
    // What the manager stages an attached TUI with (_stageOpencodeSpec).
    const terminal = mode === 'attached' ? { NIMBUS_ATTACHED_TTY: '1', NIMBUS_CP_CHILD_PID: String(pid) } : {};
    const vfsCursor = JSON.stringify(authority.cursor());
    const { runner } = await importOpencodeRunner({ mode, program, terminal, vfsCursor });
    let answered = false;
    const run = mode === 'oneshot'
      ? runner.default.fetch(new Request('http://facet/run', { method: 'POST', body: JSON.stringify({ env: terminal }) }), { SUPERVISOR: supervisor })
      : new runner.NimbusProcess({ storage: { sql: facetSql() }, waitUntil() {}, id: { toString: () => 'exit-ordering' } }, { SUPERVISOR: supervisor }).startProcess({ env: terminal });
    void run.then(() => { answered = true; }, () => { answered = true; });

    await until(() => events.includes('write'), 'the program\'s write to reach the session', 10_000);
    // The end a runner that does not wait would report now, while the write is held.
    await Promise.race([reported.promise, sleep(250)]);
    assert.deepEqual(events, ['write'], `${mode}: nothing ends the process while its write is held`);
    assert.equal(answered, false, `${mode}: the run is still open while its write is held`);
    release.resolve();
    const answer = await run;

    assert.equal(authority.read('home/user/out.txt'), 'durable', `${mode}: the program's file is in the session`);
    if (mode === 'oneshot') {
      assert.deepEqual(events, ['write', 'write answered'], 'the one-shot runner reports no exit of its own');
      const result = await answer.json();
      assert.equal(result.exitCode, code, `the run answers the program's exit code (${JSON.stringify(result)})`);
    } else {
      assert.deepEqual(events, ['write', 'write answered', `reportExit ${code}`], `${mode}: the exit is reported once the write is answered`);
    }
    realStdout(`EXIT-ORDERING-OK ${mode}\n`);
    realExit(0);
  } catch (error) {
    realStderr(`EXIT-ORDERING-FAILED ${mode}\n${(error && error.stack) || error}\n`);
    realExit(1);
  }
} else {
  const failures = [];
  for (const each of Object.keys(DISPOSITIONS)) {
    const child = Bun.spawnSync({
      cmd: [realProcess.execPath, import.meta.path],
      env: { ...realProcess.env, NIMBUS_EXIT_ORDERING_MODE: each },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    });
    const stdout = child.stdout.toString();
    if (child.exitCode === 0 && stdout.includes(`EXIT-ORDERING-OK ${each}`)) {
      console.log(`  ok  ${each}`);
    } else {
      console.log(`  FAIL ${each} (exit ${child.exitCode})\n${stdout}${child.stderr.toString()}`);
      failures.push(each);
    }
  }
  assert.deepEqual(failures, [], 'every disposition drains its writes before it ends');
  console.log('opencode-vfs-exit-ordering: every disposition ends after its writes are in the session');
}
