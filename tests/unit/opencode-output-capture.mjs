#!/usr/bin/env bun
// What a process prints reaches whoever reads it, whole and once, through
// the complete generated entry that runs it, each with a program of its own:
//
//   - the opencode one-shot runner answers its run with what the program
//     printed: bytes split across writes decode to whole characters, one
//     decoder per stream; the exact allowance (1 MiB a stream) fits, and one
//     byte more is refused with EFBIG, through process.stdout and through
//     the process module alike; a program that catches the refusal still
//     answers exit 1 and names the overflow; and the error report keeps its
//     own bounded tail (64 KiB) however long the error is;
//   - the attached opencode runner, a one-shot node and a resident node send
//     what the program prints live to SUPERVISOR, byte for byte, once, and a
//     one-shot node's run answers no second, whole-output copy of it.
//
// Each program runs in a child process of its own: a runner replaces the
// realm's process, console and timers.

import assert from 'node:assert/strict';

const realProcess = globalThis.process;
const realExit = realProcess.exit.bind(realProcess);
const realStdout = realProcess.stdout.write.bind(realProcess.stdout);
const realStderr = realProcess.stderr.write.bind(realProcess.stderr);

const CAP = 1024 * 1024;
const TAIL = 64 * 1024;
const LIVE = `console.log("L".repeat(${256 * 1024})); console.error("error");`;

// An opencode bundle's program: it reaches the runner's node builtins as opencode's own imports do.
const opencodeProgram = (body) => `
const builtins = globalThis.__nimbusOpencodeBuiltins;
export async function nimbusMain() {
${body}
}
`;
const overflows = (which) => opencodeProgram(`
  process.${which}.write(new Uint8Array(${CAP}).fill(65));
  let caught = 'nothing';
  try { builtins.process.${which}.write(new Uint8Array([66])); } catch (error) { caught = error.code; }
  builtins.fs.writeFileSync("/home/user/caught.txt", caught);
`);

/** Each case: run in its own child, it resolves to nothing or throws what it saw. */
const CASES = {
  async 'opencode one-shot: split bytes decode per stream'() {
    const answer = await opencodeOneShot(opencodeProgram(`
      process.stdout.write(new Uint8Array([0xc3]));
      process.stderr.write(new Uint8Array([0xe2, 0x82]));
      process.stdout.write(new Uint8Array([0xa9]));
      process.stderr.write(new Uint8Array([0xac]));
    `));
    assert.deepEqual(answer.result, { exitCode: 0, stdout: 'é', stderr: '€' });
  },
  async 'opencode one-shot: stdout past its allowance is refused, caught or not'() {
    const answer = await opencodeOneShot(overflows('stdout'));
    assert.equal(answer.caught, 'EFBIG', 'the process module refuses the byte past the allowance');
    assert.equal(answer.result.exitCode, 1, 'catching the refusal does not turn an oversized result into success');
    assert.equal(answer.result.stdout.length, CAP, 'the exact allowance fits');
    assert.match(answer.result.stderr, /^EFBIG: opencode one-shot stdout result exceeds 1048576 bytes\n$/);
  },
  async 'opencode one-shot: stderr past its allowance is refused, and the report keeps its tail'() {
    const answer = await opencodeOneShot(overflows('stderr'));
    assert.equal(answer.caught, 'EFBIG');
    assert.equal(answer.result.exitCode, 1);
    assert.equal(answer.result.stderr.length, TAIL, 'the report is the bounded tail of stderr');
    assert.match(answer.result.stderr, /^A+EFBIG: opencode one-shot stderr result exceeds 1048576 bytes\n$/);
  },
  async 'opencode one-shot: a long error report keeps its own bounded tail'() {
    const answer = await opencodeOneShot(opencodeProgram(`throw new Error("D".repeat(${2 * TAIL}));`));
    assert.equal(answer.result.exitCode, 1);
    assert.equal(answer.result.stderr.length, TAIL);
  },
  async 'opencode attached: live bytes reach SUPERVISOR whole and once'() {
    const { createAuthority } = await import('./lib/resident-body.mjs');
    const { opSender, supervisorDouble } = await import('./lib/supervisor-double.mjs');
    const { importOpencodeRunner } = await import('./lib/opencode-runner-module.mjs');
    const { facetSql, CRED } = await import('./lib/resident-body.mjs');
    const authority = createAuthority();
    const { pid } = authority.host.processes.spawn('opencode', ['opencode'], '/home/user', { cred: CRED, longRunning: true });
    const send = opSender((envelope) => authority.host.supervisorOp({ ...envelope, pid }));
    const sent = { stdout: [], stderr: [] };
    const exited = Promise.withResolvers();
    const supervisor = supervisorDouble(async (name, args) => {
      if (name === 'stdout' || name === 'stderr') { sent[name].push(...args[0]); return; }
      if (name === 'reportExit') { exited.resolve(args[0]); return; }
      return send(name, args);
    });
    const { runner } = await importOpencodeRunner({
      mode: 'attached',
      program: opencodeProgram(`
        process.stdout.write(new Uint8Array([0xc3]));
        process.stdout.write(new Uint8Array([0xa9]));
        builtins.process.stderr.write("error\\n");
        process.exit(0);
      `),
      env: { NIMBUS_ATTACHED_TTY: '1', NIMBUS_CP_CHILD_PID: String(pid) },
      vfsCursor: JSON.stringify(authority.cursor()),
    });
    await new runner.NimbusProcess({ storage: { sql: facetSql() }, waitUntil() {}, id: { toString: () => 'output-capture' } }, { SUPERVISOR: supervisor }).startProcess();
    assert.equal(await exited.promise, 0);
    // The attached TUI draws on its terminal too: what the program printed is in the stream, once.
    const text = (bytes) => new TextDecoder().decode(new Uint8Array(bytes));
    assert.equal(text(sent.stdout).split('é').length - 1, 1, `stdout carries the program's character once: ${JSON.stringify(text(sent.stdout).slice(-200))}`);
    assert.equal(text(sent.stderr).split('error\n').length - 1, 1, `stderr carries the program's line once: ${JSON.stringify(text(sent.stderr).slice(-200))}`);
  },
  async 'node one-shot: live output reaches SUPERVISOR once, and the run keeps no copy'() {
    const { createAuthority } = await import('./lib/resident-body.mjs');
    const { adoptSessionSupervisor, oneShotManager, runnerLoader } = await import('./lib/one-shot-runner.mjs');
    const { host, rawVfs } = createAuthority();
    const sent = { stdout: '', stderr: '' };
    adoptSessionSupervisor(host, (text, stream) => { sent[stream] += text; });
    const manager = oneShotManager('output-capture', { host, rawVfs, loader: runnerLoader('output-capture') });
    const result = await manager.exec(LIVE, { filename: '/home/user/live.js', dirname: '/home/user', cwd: '/home/user', captureOutput: false });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(sent, { stdout: `${'L'.repeat(256 * 1024)}\n`, stderr: 'error\n' });
    assert.deepEqual([result.stdout, result.stderr], ['', ''], 'the run answers no whole-output copy of what it sent live');
  },
  async 'node resident: live output reaches SUPERVISOR once'() {
    const { createAuthority, facetSupervisor, launchResident, until } = await import('./lib/resident-body.mjs');
    const authority = createAuthority();
    const { supervisor, log } = facetSupervisor(authority);
    await launchResident({ program: LIVE, env: { SUPERVISOR: supervisor }, authority });
    await until(() => log.stderr === 'error\n', 'the resident\'s stderr line', 10_000);
    assert.deepEqual([log.stdout, log.stderr], [`${'L'.repeat(256 * 1024)}\n`, 'error\n']);
  },
};

/** Run `program` as the opencode bundle of a one-shot runner: its answer, and what it caught. */
async function opencodeOneShot(program) {
  const { createAuthority, CRED } = await import('./lib/resident-body.mjs');
  const { opSender, supervisorDouble } = await import('./lib/supervisor-double.mjs');
  const { importOpencodeRunner } = await import('./lib/opencode-runner-module.mjs');
  const authority = createAuthority();
  const { pid } = authority.host.processes.spawn('opencode', ['opencode'], '/home/user', { cred: CRED });
  const send = opSender((envelope) => authority.host.supervisorOp({ ...envelope, pid }));
  const supervisor = supervisorDouble((name, args) => send(name, args));
  const { runner } = await importOpencodeRunner({ mode: 'oneshot', program, vfsCursor: JSON.stringify(authority.cursor()) });
  const response = await runner.default.fetch(new Request('http://facet/run', { method: 'POST' }), { SUPERVISOR: supervisor });
  let caught = null;
  try { caught = authority.read('home/user/caught.txt'); } catch { /* the program wrote none */ }
  return { result: await response.json(), caught };
}

const which = realProcess.env.NIMBUS_OUTPUT_CAPTURE_CASE;
if (which) {
  try {
    await CASES[which]();
    realStdout(`OUTPUT-CAPTURE-OK ${which}\n`);
    realExit(0);
  } catch (error) {
    realStderr(`OUTPUT-CAPTURE-FAILED ${which}\n${(error && error.stack) || error}\n`);
    realExit(1);
  }
} else {
  const failures = [];
  for (const name of Object.keys(CASES)) {
    const child = Bun.spawnSync({
      cmd: [realProcess.execPath, import.meta.path],
      env: { ...realProcess.env, NIMBUS_OUTPUT_CAPTURE_CASE: name },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    });
    const stdout = child.stdout.toString();
    if (child.exitCode === 0 && stdout.includes(`OUTPUT-CAPTURE-OK ${name}`)) {
      console.log(`  ok  ${name}`);
    } else {
      console.log(`  FAIL ${name} (exit ${child.exitCode})\n${stdout.slice(-2000)}${child.stderr.toString().slice(-4000)}`);
      failures.push(name);
    }
  }
  assert.deepEqual(failures, [], 'every entry delivers what its program printed');
  console.log('opencode-output-capture: what a program prints reaches its reader whole and once, through every entry');
}
