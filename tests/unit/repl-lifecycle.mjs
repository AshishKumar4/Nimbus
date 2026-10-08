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

// The first prompt is a readiness signal, not a promise to boot on the first line.
{
  const view = capture();
  const ready = Promise.withResolvers();
  const calls = [];
  const run = new ReplSession({
    ...baseAdapter,
    initialize: () => ready.promise,
    push: async (line) => { calls.push(line); return output('FIRST\n'); },
  }, view.terminal).run();
  try {
    await Promise.resolve();
    assert.doesNotMatch(view.text(), />>>/, 'a prompt was published before the interpreter and driver were ready');
    view.terminal.sendData('first\r');
    assert.deepEqual(calls, [], 'input was evaluated before startup finished');
    ready.resolve(output('BOOT\n'));
    await view.seen('FIRST');
    assert.deepEqual(calls, ['first'], 'input received during startup did not run once after readiness');
    assert.ok(view.text().indexOf('BOOT') < view.text().indexOf('>>>'), 'startup output did not precede the first prompt');
  } finally {
    ready.resolve(output());
    await bounded(view.terminal.disposeRepl(), 'starting REPL cleanup hung');
    await bounded(run, 'starting REPL run did not end');
    view.terminal.close();
  }
}

// Shell paste predates WebSocket input received during initialization.
{
  const view = capture();
  const ready = Promise.withResolvers();
  const calls = [];
  const run = new ReplSession({
    ...baseAdapter,
    initialize: () => ready.promise,
    push: async (line) => { calls.push(line); return output(`ran ${line}\n`); },
  }, view.terminal, { takeQueuedInput: () => ['x = 1'] }).run();
  try {
    view.terminal.sendData('x = 2\r');
    ready.resolve(output());
    await view.seen('ran x = 1');
    await view.seen('ran x = 2');
    assert.deepEqual(calls, ['x = 1', 'x = 2'], 'later WebSocket input overtook the earlier shell paste');
  } finally {
    ready.resolve(output());
    await view.terminal.disposeRepl();
    await run;
    view.terminal.close();
  }
}

// Failed startup never claims to be ready, and still closes the adapter.
{
  const view = capture();
  let closes = 0;
  const run = new ReplSession({
    ...baseAdapter,
    initialize: async () => { throw new Error('interpreter bootstrap failed'); },
    push: async () => { throw new Error('input reached an unready interpreter'); },
    close: async () => { closes++; },
  }, view.terminal).run();
  try {
    assert.equal(await bounded(run, 'failed startup did not end'), 1);
    assert.doesNotMatch(view.text(), />>>/);
    assert.match(view.text(), /interpreter bootstrap failed/);
    assert.equal(closes, 1);
  } finally {
    await view.terminal.disposeRepl();
    view.terminal.close();
  }
}

// Teardown owns the startup lifetime too, and cannot publish a late prompt.
{
  const view = capture();
  const started = Promise.withResolvers();
  const ready = Promise.withResolvers();
  let closes = 0;
  const run = new ReplSession({
    ...baseAdapter,
    initialize: () => { started.resolve(); return ready.promise; },
    push: async () => output(),
    close: async () => { closes++; },
  }, view.terminal).run();
  await bounded(started.promise, 'startup did not start');
  const disposed = view.terminal.disposeRepl();
  let finished = false;
  disposed.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false, 'teardown abandoned an interpreter still starting');
  ready.resolve(output('STALE BOOT\n'));
  await bounded(disposed, 'starting interpreter teardown did not finish');
  assert.equal(await bounded(run, 'starting interpreter run did not finish'), 0);
  assert.equal(closes, 1);
  assert.doesNotMatch(view.text(), />>>|STALE BOOT/);
  view.terminal.close();
}

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
