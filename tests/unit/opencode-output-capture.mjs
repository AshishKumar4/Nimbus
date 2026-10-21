#!/usr/bin/env bun
// What a process prints reaches whoever reads it, whole and once, through
// the complete generated entry that runs it, each with a program of its own:
//
//   - the opencode one-shot runner answers its run with what the program
//     printed: bytes split across writes decode to whole characters, one
//     decoder per stream; the exact allowance (1 MiB a stream) fits, and one
//     byte more is refused with EFBIG, through process.stdout and through
//     the process module alike; a program that catches the refusal still
//     answers exit 1 and names the overflow; and the error report keeps the
//     last 64 KiB of a longer error;
//   - the attached opencode runner, a one-shot node and a resident node send
//     what the program prints live to SUPERVISOR, byte for byte and once;
//   - a one-shot node and a resident node, while the program is still
//     running, hold no copy of what they sent live: 64 MiB printed leaves
//     the heap, after a full collection, within 16 MiB of where it was.
//
// Each program runs in a child process of its own (runScenarios): a runner
// replaces the realm's process, console and timers.

import assert from 'node:assert/strict';
import { runScenarios } from './lib/resident-body.mjs';
import { facetStorage } from './lib/fake-do-kv.mjs';

const CAP = 1024 * 1024;
const TAIL = 64 * 1024;
const LIVE = `console.log("L".repeat(${256 * 1024})); console.error("error");`;
// A program that, when the test asks (after it has looked at the heap),
// writes 64 MiB in distinct 1 MiB writes, and runs on until the test ends it.
const FLOOD = `
const running = setInterval(() => {}, 1000);
globalThis.__flood = {
  start() { for (let i = 0; i < 64; i++) process.stdout.write(String(i).padStart(4, "0") + "x".repeat(1024 * 1024 - 4)); },
  end() { clearInterval(running); },
};`;
const FLOODED = 64 * 1024 * 1024;

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

/**
 * The bytes between `begin` and `end` in `bytes`, when each appears exactly
 * once and in that order; null otherwise (a frame missing, or sent twice).
 */
function framed(bytes, begin, end) {
  const text = Buffer.from(bytes).toString('latin1');
  const once = (mark) => text.split(mark).length === 2;
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  return once(begin) && once(end) && from + begin.length <= to ? [...Buffer.from(text.slice(from + begin.length, to), 'latin1')] : null;
}

/**
 * How far the heap grows while the running FLOOD program writes 64 MiB:
 * measured, after a full collection, from just before the test starts the
 * flood to when every byte has been delivered. `delivered()` counts them.
 */
async function floodGrowth(delivered) {
  const { until } = await import('./lib/resident-body.mjs');
  await until(() => globalThis.__flood !== undefined, 'the program to start', 30_000);
  const before = heap();
  globalThis.__flood.start();
  await until(() => delivered() === FLOODED, '64 MiB delivered', 30_000);
  const grown = heap() - before;
  globalThis.__flood.end();
  return grown;
}

// The test process's own, taken before a runner replaces the realm's process.
const memoryUsage = process.memoryUsage.bind(process);
const { gc } = Bun;

/** The heap's size after a full collection. */
const heap = () => { gc(true); return memoryUsage().heapUsed; };

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
  const response = await runner.default.fetch(new Request('http://facet/run', { method: 'POST', body: JSON.stringify({ env: {} }) }), { SUPERVISOR: supervisor });
  let caught = null;
  try { caught = authority.read('home/user/caught.txt'); } catch { /* the program wrote none */ }
  return { result: await response.json(), caught };
}

/**
 * A one-shot node exec of `program` over the session's supervisor; each
 * write goes to `onWrite(stream, bytes)`, by default kept in `sent`.
 */
async function nodeOneShot(program, onWrite = null) {
  const { createAuthority } = await import('./lib/resident-body.mjs');
  const { adoptSessionSupervisor, oneShotManager, runnerLoader } = await import('./lib/one-shot-runner.mjs');
  const { host, rawVfs } = createAuthority();
  const sent = { stdout: [], stderr: [] };
  adoptSessionSupervisor(host, (_text, stream, bytes) => (onWrite ? onWrite(stream, bytes) : sent[stream].push(bytes)));
  const manager = oneShotManager('output-capture', { host, rawVfs, loader: runnerLoader('output-capture') });
  const run = manager.exec(program, { filename: '/home/user/live.js', dirname: '/home/user', cwd: '/home/user', captureOutput: false });
  return { run, sent };
}

const bytesOf = (chunks) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

await runScenarios(import.meta.path, {
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
    assert.equal(answer.result.stdout, 'A'.repeat(CAP), 'the exact allowance fits');
    assert.equal(answer.result.stderr, 'EFBIG: opencode one-shot stdout result exceeds 1048576 bytes\n');
  },
  async 'opencode one-shot: stderr past its allowance is refused, and the report keeps its tail'() {
    const answer = await opencodeOneShot(overflows('stderr'));
    assert.equal(answer.caught, 'EFBIG');
    assert.equal(answer.result.exitCode, 1);
    const report = 'EFBIG: opencode one-shot stderr result exceeds 1048576 bytes\n';
    assert.equal(answer.result.stderr, 'A'.repeat(TAIL - report.length) + report, 'the report is the last 64 KiB of stderr');
  },
  async 'opencode one-shot: a long error report keeps its last 64 KiB'() {
    const answer = await opencodeOneShot(opencodeProgram(`throw new Error("HEAD-MARK" + "D".repeat(${2 * TAIL}) + "TAIL-MARK");`));
    assert.equal(answer.result.exitCode, 1);
    assert.equal(answer.result.stderr.length, TAIL);
    assert.ok(!answer.result.stderr.includes('HEAD-MARK') && answer.result.stderr.includes('DTAIL-MARK'), 'the end of the error survives, not its start');
  },
  async 'opencode attached: live bytes reach SUPERVISOR exactly, once'() {
    const { createAuthority, facetSql, CRED } = await import('./lib/resident-body.mjs');
    const { opSender, supervisorDouble } = await import('./lib/supervisor-double.mjs');
    const { importOpencodeRunner } = await import('./lib/opencode-runner-module.mjs');
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
        process.stdout.write("<OUT>");
        process.stdout.write(new Uint8Array([0xc3]));
        process.stdout.write(new Uint8Array([0xa9]));
        process.stdout.write("</OUT>");
        builtins.process.stderr.write("<ERR>");
        builtins.process.stderr.write("error");
        builtins.process.stderr.write("</ERR>");
        process.exit(0);
      `),
      terminal: { NIMBUS_ATTACHED_TTY: '1', NIMBUS_CP_CHILD_PID: String(pid) },
      vfsCursor: JSON.stringify(authority.cursor()),
    });
    await new runner.NimbusProcess({ storage: facetStorage(facetSql()), waitUntil() {}, id: { toString: () => 'output-capture' } }, { SUPERVISOR: supervisor }).startProcess({ env: {} });
    assert.equal(await exited.promise, 0);
    // The TUI draws on the terminal too: what the program printed is what lies between its own marks.
    assert.deepEqual(framed(sent.stdout, '<OUT>', '</OUT>'), [0xc3, 0xa9]);
    assert.deepEqual(framed(sent.stderr, '<ERR>', '</ERR>'), [...Buffer.from('error')]);
  },
  async 'node one-shot: live output reaches SUPERVISOR exactly, once'() {
    const { run, sent } = await nodeOneShot(LIVE);
    const result = await run;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual([bytesOf(sent.stdout).toString(), bytesOf(sent.stderr).toString()], [`${'L'.repeat(256 * 1024)}\n`, 'error\n']);
  },
  async 'node one-shot: a running program holds no copy of what it sent live'() {
    let delivered = 0;
    // Counted, not kept: what the test holds is not the program's.
    const { run } = await nodeOneShot(FLOOD, (stream, bytes) => { if (stream === 'stdout') delivered += bytes.byteLength; });
    const grown = await floodGrowth(() => delivered);
    assert.equal((await run).exitCode, 0);
    assert.ok(grown < 16 * 1024 * 1024, `64 MiB sent live grew the heap by ${(grown / 2 ** 20).toFixed(1)} MiB`);
  },
  async 'node resident: live output reaches SUPERVISOR exactly, once'() {
    const { createAuthority, facetSupervisor, launchResident, until } = await import('./lib/resident-body.mjs');
    const authority = createAuthority();
    const { supervisor, log } = facetSupervisor(authority);
    await launchResident({ program: LIVE, env: { SUPERVISOR: supervisor }, authority });
    await until(() => log.stderr === 'error\n', 'the resident\'s stderr line', 10_000);
    assert.deepEqual([log.stdout, log.stderr], [`${'L'.repeat(256 * 1024)}\n`, 'error\n']);
  },
  async 'node resident: a running program holds no copy of what it sent live'() {
    const { createAuthority, facetSupervisor, launchResident } = await import('./lib/resident-body.mjs');
    const authority = createAuthority();
    let delivered = 0;
    // Counted, not kept: what the test holds is not the program's.
    const { supervisor } = facetSupervisor(authority, { stdout: async (bytes) => { delivered += bytes.byteLength; } });
    await launchResident({ program: FLOOD, env: { SUPERVISOR: supervisor }, authority });
    const grown = await floodGrowth(() => delivered);
    assert.ok(grown < 16 * 1024 * 1024, `64 MiB sent live grew the heap by ${(grown / 2 ** 20).toFixed(1)} MiB`);
  },
});
console.log('opencode-output-capture: what a program prints reaches its reader whole and once, through every entry, and is not kept');
