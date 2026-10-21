#!/usr/bin/env bun
// Node's child_process (node-compat/child_process.ts) over stand-in start
// faces, for what a real session rarely shows:
//   - an AbortSignal's abort, before the start answers and once it runs, is
//     the 'error' event's AbortError (and exec's callback's), the child killed;
//   - stdin written before a start that is refused hears that it was not;
//   - an output lost while the child runs ends it (SIGKILL) and is its error;
//   - spawn(file, undefined, options) keeps its options;
//   - kill takes every Linux signal by name and number, and 0 sends nothing.
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { createNodeChildProcess } from '../../packages/core/src/node-compat/child_process.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A start face whose programs run until killed; each start, its kills and its program are recorded. */
function runningFace({ refuse, output } = {}) {
  const starts = [];
  const start = async (program, cancel) => {
    await sleep(10);
    if (cancel.aborted) throw Object.assign(new Error('spawn: operation canceled'), { code: 'ECANCELED', errno: -125 });
    if (refuse) throw Object.assign(new Error(`spawn ${program.argv[0]} ENOENT`), { code: 'ENOENT', errno: -2, syscall: `spawn ${program.argv[0]}`, path: program.argv[0] });
    let end;
    const exit = new Promise((resolve) => { end = resolve; });
    const kills = [];
    const started = {
      pid: 7,
      program,
      kills,
      output: output ?? new ReadableStream({ start(c) { exit.then(() => c.close()); } }),
      exit,
      kill: (signal) => { kills.push(signal); if (signal !== 'SIGUSR2') end({ code: null, signal }); },
    };
    starts.push(started);
    return started;
  };
  return { start, starts };
}

const failures = [];
const check = async (name, body) => {
  try {
    await body();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
};

await check('an abort before the start answers', async () => {
  const { start } = runningFace();
  const cp = createNodeChildProcess(start, { cwd: '/w' });
  const controller = new AbortController();
  const child = cp.spawn('sleep', ['9'], { signal: controller.signal });
  const errors = [];
  child.on('error', (error) => errors.push(error));
  controller.abort('enough');
  await new Promise((resolve) => child.on('close', resolve));
  assert.deepEqual(errors.map((e) => [e.name, e.code, e.cause]), [['AbortError', 'ABORT_ERR', 'enough']], 'one error, the AbortError');
});

await check('an abort once it runs, through exec', async () => {
  const { start, starts } = runningFace();
  const cp = createNodeChildProcess(start, { cwd: '/w' });
  const controller = new AbortController();
  const ran = promisify(cp.exec)('sleep 9', { signal: controller.signal });
  for (let i = 0; i < 100 && starts.length === 0; i++) await sleep(5);
  controller.abort();
  const error = await ran.then(() => null, (e) => e);
  assert.deepEqual([error?.name, error?.code, error?.cmd, starts[0]?.kills], ['AbortError', 'ABORT_ERR', 'sleep 9', ['SIGTERM']]);
});

await check('stdin written before a refused start', async () => {
  const { start } = runningFace({ refuse: true });
  const cp = createNodeChildProcess(start, { cwd: '/w' });
  const child = cp.spawn('nope');
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  const written = await new Promise((resolve) => child.stdin.write('lost', (error) => resolve(error ?? null)));
  assert.ok(written instanceof Error, 'its writer hears that it was not written');
});

await check('an output lost while it runs', async () => {
  const output = new ReadableStream({ pull(c) { c.error(new Error('the transport went away')); } });
  const { start, starts } = runningFace({ output });
  const cp = createNodeChildProcess(start, { cwd: '/w' });
  const child = cp.spawn('server');
  const errors = [];
  child.on('error', (error) => errors.push(error.message));
  const [code, signal] = await new Promise((resolve) => child.on('close', (...ended) => resolve(ended)));
  assert.deepEqual([errors, starts[0].kills, code, signal], [['the transport went away'], ['SIGKILL'], null, 'SIGKILL']);
});

await check('spawn with its args omitted keeps its options', async () => {
  const { start, starts } = runningFace();
  const cp = createNodeChildProcess(start, { cwd: '/w' });
  const child = cp.spawn('pwd', undefined, { cwd: '/elsewhere', env: { ONLY: '1' } });
  for (let i = 0; i < 100 && starts.length === 0; i++) await sleep(5);
  assert.deepEqual([starts[0]?.program.cwd, starts[0]?.program.env], ['/elsewhere', { ONLY: '1' }]);
  child.kill('SIGKILL');
});

await check('kill takes every signal, by name and number; 0 sends nothing', async () => {
  const { start, starts } = runningFace();
  const cp = createNodeChildProcess(start, { cwd: '/w' });
  const child = cp.spawn('sleep', ['9']);
  await new Promise((resolve) => child.on('spawn', resolve));
  assert.equal(child.kill(0), true);
  assert.equal(child.kill('SIGUSR2'), true);
  assert.throws(() => child.kill('SIGNOPE'), { code: 'ERR_UNKNOWN_SIGNAL' });
  assert.throws(() => child.kill('TERM'), { code: 'ERR_UNKNOWN_SIGNAL' }, 'as Node: a name with its SIG');
  assert.equal(child.kill(24), true, 'SIGXCPU by its number');
  assert.deepEqual(starts[0].kills, ['SIGUSR2', 'SIGXCPU']);
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(child.kill(), false, 'ended: nothing to signal');
});

assert.deepEqual(failures, []);
console.log('node-compat-child-process-faces: abort, refused stdin, lost output, args omitted and signals, as Node\'s');
