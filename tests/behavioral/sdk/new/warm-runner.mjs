#!/usr/bin/env bun
// sdk/new/warm-runner — a runner (`sandbox.runner()`) runs short programs warm:
// each call is a line of the node REPL in one warm process, so what one call
// declares the next call finds. The checks, end to end over the remote SDK:
//   - state persists across calls (globals, top-level `let`, top-level await),
//     and stdout, stderr, the value and a thrown error (a SyntaxError too)
//     come back per call, the runner keeping its state;
//   - files are coherent both ways: a call reads what the session wrote after
//     the runner started, and the session reads what a call wrote as soon as
//     the call answers, without waiting where a call wrote often;
//   - more than ten idle runners in one session stay warm and callable: an
//     idle runner holds none of the Durable Object's ten Dynamic Workers;
//   - a runaway call (a loop that never yields) ends with a defined error at
//     its CPU limit, the session still answers, and the next call is fresh;
//     so does a call past its wall limit or one that calls process.exit, and
//     close ends a call the runner is running; a closed runner starts fresh.
// It also records what a warm call costs beside a warm `node -e` one-shot.

import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('sdk/new/warm-runner');
console.log(`sdk/new/warm-runner — BASE=${BASE}`);

const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');

// Past this a call that should have answered is reported hung, not awaited:
// a runaway the platform does not end would otherwise hold the probe for the
// process facets' 300 s limit (Kinu saw 339 s).
const HUNG_MS = 60_000;
// A warm call's own cost in the session (its `ms`), which a call that loads
// its module map again (a one-shot's 130-300 ms) would exceed.
const WARM_MS_BOUND = 60;
// The runaway call's limit, and how long past it its answer may come.
const RUNAWAY_CPU_MS = 1_000;
const RUNAWAY_ANSWER_MS = 10_000;
// One more than the platform's ten Dynamic Workers in flight per object.
const IDLE_RUNNERS = 12;
const SAMPLES = 25;

const box = Nimbus.connect({
  endpoint: BASE,
  ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}),
}).sandbox(`runner-${Date.now()}`);

/** `promise`, or the string 'hung' once HUNG_MS pass. */
async function bounded(promise) {
  let timer;
  const hung = new Promise((resolve) => { timer = setTimeout(() => resolve('hung'), HUNG_MS); });
  try { return await Promise.race([promise, hung]); } finally { clearTimeout(timer); }
}

/** One call on `runner`, or 'hung' (bounded). */
const call = (runner, code, options) => bounded(runner.run(code, options));

/** `run`, timed on this side too. */
async function timed(run) {
  const began = performance.now();
  const result = await bounded(run());
  return { result, wallMs: Math.round(performance.now() - began) };
}

function stats(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, median: at(0.5), p90: at(0.9), min: sorted[0], max: sorted[sorted.length - 1] };
}

const show = (value) => JSON.stringify(value);

try {
  await box.exec('mkdir -p /home/user/runner && echo base > /home/user/runner/edited.txt');
  const runner = box.runner({ cwd: '/home/user/runner' });

  const cold = await timed(() => runner.run('globalThis.x = 40; let y = 2; x + y'));
  a.check('the first call runs, in a fresh runner, and answers its value',
    cold.result !== 'hung' && cold.result.value === '42' && cold.result.fresh === true && cold.result.error === undefined, show(cold));
  a.record('coldRunner', { wallMs: cold.wallMs, ms: cold.result?.ms });

  const again = await runner.run('x + y');
  a.check('a later call finds what the first declared, in the same runner',
    again.value === '42' && again.fresh === false, show(again));

  await runner.run('const z = await Promise.resolve(5)');
  const awaited = await runner.run('z * 2');
  a.check('top-level await works, and its declaration is there for the next call',
    awaited.value === '10' && awaited.fresh === false, show(awaited));

  const printed = await runner.run('console.log("out"); console.error("err"); "done"');
  a.check('a call answers what it wrote to stdout and stderr, and its value',
    printed.stdout === 'out\n' && printed.stderr === 'err\n' && printed.value === "'done'", show(printed));
  const quiet = await runner.run('1');
  a.check("a call's output is its own: the next call's starts empty",
    quiet.stdout === '' && quiet.stderr === '' && quiet.value === '1', show(quiet));

  const thrown = await runner.run('throw new TypeError("boom")');
  a.check('a thrown error comes back by name, message and stack, with no value',
    thrown.error?.name === 'TypeError' && thrown.error.message === 'boom' && typeof thrown.error.stack === 'string'
      && thrown.value === undefined && thrown.fresh === false, show(thrown));
  const survived = await runner.run('x');
  a.check('the runner keeps its state after a thrown error', survived.value === '40' && survived.fresh === false, show(survived));
  const typo = await runner.run('foo(');
  const afterTypo = await runner.run('x');
  a.check('code that does not parse answers a SyntaxError, and the runner keeps its state',
    typo.error?.name === 'SyntaxError' && typo.fresh === false && afterTypo.value === '40' && afterTypo.fresh === false, show({ typo, afterTypo }));

  // The session to the runner: files written after the runner started.
  await box.files.write('/home/user/runner/later.js', 'module.exports = { v: 9 };\n');
  const required = await runner.run('require("./later.js").v');
  a.check('require reads a module the session wrote after the runner started',
    required.value === '9', show(required));
  const before = await runner.run('require("fs").readFileSync("/home/user/runner/edited.txt", "utf8")');
  await box.files.write('/home/user/runner/edited.txt', 'changed');
  const after = await runner.run('require("fs").readFileSync("/home/user/runner/edited.txt", "utf8")');
  a.check("a call reads a file's current content after the session changes it",
    before.value === "'base\\n'" && after.value === "'changed'", show({ before, after }));

  // The runner to the session.
  const wrote = await runner.run('require("fs").writeFileSync("/home/user/runner/out.txt", "from-runner"); "ok"');
  const read = await box.files.read('/home/user/runner/out.txt');
  a.check('the session reads what a call wrote as soon as the call answers',
    wrote.value === "'ok'" && read === 'from-runner', show({ wrote, read }));

  // A call that writes one directory often enough that a process would
  // hold it (a delegation) must leave nothing the idle runner would have to
  // give back: the session writes there at once, and the runner lives on.
  await runner.run([
    'require("fs").mkdirSync("/home/user/runner/many", { recursive: true });',
    'for (let i = 0; i < 20; i++) require("fs").writeFileSync("/home/user/runner/many/" + i + ".txt", String(i));',
  ].join('\n'));
  const busyWrite = await timed(() => box.files.write('/home/user/runner/many/session.txt', 'session'));
  const afterBusy = await runner.run('require("fs").readFileSync("/home/user/runner/many/session.txt", "utf8") + ":" + x');
  a.check('the session writes where a call wrote often without waiting, and the runner lives on',
    busyWrite.wallMs < 2_000 && afterBusy.value === "'session:40'" && afterBusy.fresh === false, show({ busyWrite, afterBusy }));

  // Warm calls beside warm one-shots, measured the same way from here.
  await box.exec('node -e 1');
  const runnerCalls = [];
  const oneShots = [];
  for (let i = 0; i < SAMPLES; i++) {
    runnerCalls.push(await timed(() => runner.run('x + 1')));
    oneShots.push(await timed(() => box.exec('node -e 1')));
  }
  const warm = stats(runnerCalls.map((call) => call.result.ms));
  a.record('warmRunner', { ms: warm, wallMs: stats(runnerCalls.map((call) => call.wallMs)) });
  a.record('warmOneShot', { wallMs: stats(oneShots.map((call) => call.wallMs)) });
  a.check(`a warm call costs the session under ${WARM_MS_BOUND} ms at the median`,
    runnerCalls.every((call) => call.result.value === '41' && call.result.fresh === false) && warm.median < WARM_MS_BOUND, show(warm));

  // More idle runners than the object has Dynamic Workers.
  const idle = Array.from({ length: IDLE_RUNNERS }, () => box.runner({ cwd: '/home/user/runner' }));
  const made = [];
  for (const [i, each] of idle.entries()) made.push(await bounded(each.run(`globalThis.n = ${i}`)));
  a.check(`${IDLE_RUNNERS} runners start, one after another`,
    made.every((result, i) => result !== 'hung' && result.value === String(i) && result.fresh === true), show(made));
  const kept = [];
  for (const each of idle) kept.push(await timed(() => each.run('n')));
  a.check(`all ${IDLE_RUNNERS} idle runners stay warm and keep their own state`,
    kept.every(({ result }, i) => result !== 'hung' && result.value === String(i) && result.fresh === false), show(kept));
  a.record('afterIdleRunners', { ms: stats(kept.map(({ result }) => result.ms)), wallMs: stats(kept.map(({ wallMs }) => wallMs)) });
  const first = await runner.run('x');
  a.check(`the first runner still answers warm with ${IDLE_RUNNERS} more in the session`,
    first.value === '40' && first.fresh === false, show(first));

  // A runaway call.
  const runaway = await timed(() => runner.run('for (;;) {}', { cpuMs: RUNAWAY_CPU_MS }));
  a.record('runaway', { cpuMs: RUNAWAY_CPU_MS, wallMs: runaway.wallMs, ms: runaway.result?.ms, error: runaway.result?.error });
  a.check(`a loop that never yields ends at its ${RUNAWAY_CPU_MS} ms CPU limit with ERR_NIMBUS_RUNNER_CPU_LIMIT, within ${RUNAWAY_ANSWER_MS} ms`,
    runaway.result !== 'hung' && runaway.result.error?.code === 'ERR_NIMBUS_RUNNER_CPU_LIMIT' && runaway.wallMs < RUNAWAY_ANSWER_MS, show(runaway));
  const alive = await bounded(box.exec('echo alive'));
  a.check('the session answers after the runaway', alive !== 'hung' && alive.stdout === 'alive\n', show(alive));
  const restarted = await bounded(runner.run('typeof x'));
  a.check('the call after the runaway runs in a fresh runner, without the old state',
    restarted !== 'hung' && restarted.fresh === true && restarted.value === "'undefined'", show(restarted));
  const sibling = await idle[0].run('n');
  a.check('the runaway ended only its own runner', sibling.value === '0' && sibling.fresh === false, show(sibling));

  const defaultLimit = await timed(() => runner.run('for (;;) {}'));
  a.record('runawayDefault', { wallMs: defaultLimit.wallMs, ms: defaultLimit.result?.ms });
  a.check('a runaway with no cpuMs ends at the default limit, with the same error',
    defaultLimit.result !== 'hung' && defaultLimit.result.error?.code === 'ERR_NIMBUS_RUNNER_CPU_LIMIT', show(defaultLimit));

  await runner.run('globalThis.kept = 1');
  const waited = await timed(() => runner.run('await new Promise(() => {})', { timeoutMs: 500 }));
  a.check('a call that waits past its timeoutMs ends with ERR_NIMBUS_RUNNER_TIMEOUT',
    waited.result !== 'hung' && waited.result.error?.code === 'ERR_NIMBUS_RUNNER_TIMEOUT' && waited.wallMs < RUNAWAY_ANSWER_MS, show(waited));
  const afterTimeout = await runner.run('typeof kept');
  a.check('the call after a timeout is fresh', afterTimeout.fresh === true && afterTimeout.value === "'undefined'", show(afterTimeout));

  const exited = await call(runner, 'process.exit(3)');
  a.check('process.exit ends the runner with ERR_NIMBUS_RUNNER_EXITED', exited.error?.code === 'ERR_NIMBUS_RUNNER_EXITED', show(exited));
  await call(runner, 'globalThis.kept = 1');
  const slept = await call(runner, 'await new Promise((resolve) => setTimeout(resolve, 50)); "slept"', { timeoutMs: 10_000 });
  a.check('a call can await a timer', slept.value === "'slept'" && slept.fresh === false, show(slept));
  const probeExit = await call(runner, 'setTimeout(() => { globalThis.t1 = 1; try { process.exit(4); } catch (e) { globalThis.t2 = String(e && e.message); } }, 0); await new Promise((r) => globalThis.__nimbusRawSetTimeout(r, 300)); JSON.stringify([globalThis.t1, globalThis.t2, process.exitCode, process._exiting])', { timeoutMs: 10_000 });
  a.record('probeExit', probeExit);
  await call(runner, 'globalThis.kept = 1');
  const exitedLater = await call(runner, 'setTimeout(() => process.exit(4), 0); await new Promise(() => {})', { timeoutMs: 10_000 });
  const afterExit = await call(runner, 'typeof kept');
  a.check('process.exit from a callback ends the runner too',
    exitedLater.error?.code === 'ERR_NIMBUS_RUNNER_EXITED' && afterExit.fresh === true && afterExit.value === "'undefined'", show({ exitedLater, afterExit }));

  const waiting = idle[1];
  const pending = timed(() => waiting.run('await new Promise(() => {})'));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const closedWhileRunning = await waiting.close();
  const abandoned = await pending;
  a.check('close ends a call the runner is running, with ERR_NIMBUS_RUNNER_CLOSED',
    closedWhileRunning === true && abandoned.result !== 'hung' && abandoned.result.error?.code === 'ERR_NIMBUS_RUNNER_CLOSED', show({ closedWhileRunning, abandoned }));

  // A kill of the runner's process between calls ends that runner; the next call starts a new one.
  const victim = box.runner({ cwd: '/home/user/runner' });
  await call(victim, 'globalThis.kept = 1');
  const listed = (await box.processes.list()).find((process) => process.command === `node (runner ${victim.id})` && process.state === 'running');
  const killed = listed === undefined ? null : await box.processes.kill(listed.pid);
  const afterKill = await call(victim, 'typeof kept');
  const ended = listed === undefined ? undefined : (await box.processes.list()).find((process) => process.pid === listed.pid);
  a.check("a kill of an idle runner's process ends it: the process reads ended, and the next call is fresh",
    killed?.ok === true && ended?.state !== 'running' && afterKill.fresh === true && afterKill.value === "'undefined'", show({ listed, killed, ended, afterKill }));
  await victim.close();

  // A new runner closed after its first call: the same id runs fresh, in a new worker.
  const once = box.runner({ cwd: '/home/user/runner' });
  await call(once, 'globalThis.kept = 1');
  await once.close();
  const reused = await call(once, 'typeof kept');
  a.check('a runner closed after its first call starts fresh under the same id',
    reused.fresh === true && reused.value === "'undefined'", show(reused));
  await once.close();

  await call(runner, 'globalThis.kept = 1');
  const closed = await runner.close();
  const reopened = await call(runner, 'typeof kept');
  a.check('close ends the runner: the same id starts fresh',
    closed === true && reopened.fresh === true && reopened.value === "'undefined'", show({ closed, reopened }));
  for (const each of idle) await each.close();
  await runner.close();
} finally {
  // The probe made this sandbox, so its cleanup is the probe's.
  const destroyed = await box.destroy({ reason: 'runner-complete' })
    .then((result) => result, (error) => ({ ok: false, error: String(error?.message ?? error) }));
  a.check('the sandbox is destroyed', destroyed.ok === true && typeof destroyed.destroyedAt === 'number', JSON.stringify(destroyed));
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
