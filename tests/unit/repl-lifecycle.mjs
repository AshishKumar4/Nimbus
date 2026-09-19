import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ? pathToFileURL(`${resolve(process.argv[2])}/`) : new URL('../../', import.meta.url);
const { WebSocketTerminal } = await import(new URL('packages/worker/src/facets/ws-terminal.ts', root));
const { ReplSession } = await import(new URL('packages/worker/src/runtime/repl-session.ts', root));

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

function capture() {
  const chunks = [];
  const listeners = new Set();
  const terminal = new WebSocketTerminal(null, (text) => {
    chunks.push(text);
    for (const listener of listeners) listener();
  });
  return {
    terminal,
    text() { terminal.flushNow(); return chunks.join(''); },
    reset() { terminal.flushNow(); chunks.length = 0; },
    seen(text) {
      terminal.flushNow();
      if (chunks.join('').includes(text)) return Promise.resolve();
      return bounded(new Promise((done) => {
        const listener = () => {
          if (!chunks.join('').includes(text)) return;
          listeners.delete(listener);
          done();
        };
        listeners.add(listener);
      }), `missing terminal output ${JSON.stringify(text)}`);
    },
  };
}

const output = (stdout = '') => ({ kind: 'output', stdout, stderr: '' });
const baseAdapter = { ps1: '>>> ', ps2: '... ', banner: () => '', close: async () => {} };

// An abort acknowledgement cannot release the input queue before push settles.
{
  const view = capture();
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const calls = [];
  const adapter = {
    ...baseAdapter,
    push(line) {
      calls.push(line);
      if (line === 'first') { entered.resolve(); return finished.promise; }
      return Promise.resolve(output('SECOND\n'));
    },
    interrupt: () => aborted.promise,
  };
  const session = new ReplSession(adapter, view.terminal);
  const run = session.run();
  view.reset();
  try {
    view.terminal.sendData('first\r');
    await bounded(entered.promise, 'first evaluation did not start');
    view.terminal.sendData('\x03second\r');
    aborted.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.doesNotMatch(view.text(), />>>|state reset/, 'interrupt reported readiness while evaluation remained active');
    assert.deepEqual(calls, ['first']);
    finished.resolve(output('STALE\n'));
    await view.seen('SECOND');
    assert.deepEqual(calls, ['first', 'second']);
    assert.doesNotMatch(view.text(), /STALE/);
    assert.equal((view.text().match(/state reset/g) ?? []).length, 1);
  } finally {
    finished.resolve(output());
    aborted.resolve();
    await bounded(view.terminal.disposeRepl(), 'interrupted REPL cleanup hung');
    await bounded(run, 'REPL run did not end');
    view.terminal.close();
  }
}

// Unsupported and failed interrupts preserve the running evaluation's output.
for (const interrupt of [undefined, () => { throw new Error('cannot cancel'); }, () => Promise.reject(new Error('cannot cancel'))]) {
  const view = capture();
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const adapter = { ...baseAdapter, push: () => { entered.resolve(); return finished.promise; } };
  if (interrupt) adapter.interrupt = interrupt;
  const run = new ReplSession(adapter, view.terminal).run();
  view.reset();
  try {
    view.terminal.sendData('first\r');
    await bounded(entered.promise, 'evaluation did not start');
    view.terminal.sendData('\x03');
    await Promise.resolve();
    await Promise.resolve();
    assert.doesNotMatch(view.text(), />>>|state reset/, 'unsupported or failed interrupt reported readiness');
    finished.resolve(output('PRESERVED\n'));
    await view.seen('PRESERVED');
    assert.doesNotMatch(view.text(), /state reset/);
    if (interrupt) assert.match(view.text(), /interrupt failed: cannot cancel/);
  } finally {
    finished.resolve(output());
    await bounded(view.terminal.disposeRepl(), 'REPL cleanup hung');
    await bounded(run, 'REPL run did not end');
    view.terminal.close();
  }
}

// Explicit teardown is shared and cannot finish while a push remains active.
{
  const view = capture();
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const closing = Promise.withResolvers();
  let closes = 0;
  const run = new ReplSession({
    ...baseAdapter,
    push: () => { entered.resolve(); return finished.promise; },
    close: async () => { closes++; closing.resolve(); },
  }, view.terminal).run();
  view.terminal.sendData('first\r');
  await bounded(entered.promise, 'evaluation did not start');
  const first = view.terminal.disposeRepl();
  const second = view.terminal.disposeRepl();
  assert.equal(first, second, 'concurrent teardown did not share completion');
  let disposed = false;
  first.then(() => { disposed = true; });
  await bounded(closing.promise, 'adapter close not called');
  await Promise.resolve();
  assert.equal(disposed, false, 'teardown finished before push settled');
  finished.resolve(output('STALE\n'));
  await bounded(first, 'teardown did not finish');
  assert.equal(closes, 1);
  assert.equal(await bounded(run, 'run did not finish'), 0);
  assert.doesNotMatch(view.text(), /STALE/);
  view.terminal.close();
}

// Nested scopes retain their own disposal, including out-of-order detach.
{
  const view = capture();
  const calls = [];
  view.terminal.onData(() => calls.push('shell'));
  const outer = view.terminal.attachRepl(() => calls.push('outer'), async () => calls.push('close outer'));
  view.terminal.attachRepl(() => calls.push('inner'), async () => calls.push('close inner'));
  outer();
  view.terminal.sendData('x');
  await view.terminal.disposeRepl();
  view.terminal.sendData('x');
  assert.deepEqual(calls, ['inner', 'close inner', 'shell']);
  view.terminal.attachRepl(() => {}, async () => { throw new Error('cleanup broke'); });
  await assert.rejects(view.terminal.disposeRepl(), /REPL cleanup failed/);
  view.terminal.close();
}

console.log('repl-lifecycle: all assertions passed');
