import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bounded, captureTerminal } from './lib/terminal-capture.mjs';

const root = process.argv[2] ? pathToFileURL(`${resolve(process.argv[2])}/`) : new URL('../../', import.meta.url);
const { WebSocketTerminal } = await import(new URL('packages/worker/src/facets/ws-terminal.ts', root));
const { ReplSession } = await import(new URL('packages/worker/src/runtime/repl-session.ts', root));

const capture = () => captureTerminal(WebSocketTerminal);

const output = (stdout = '') => ({ kind: 'output', stdout, stderr: '' });
const baseAdapter = { ps1: '>>> ', ps2: '... ', banner: () => '', close: async () => {} };

/** `text` without the notice a Ctrl-C prints on the line after `line`, which must be there. */
const withoutNotice = (text, line) => {
  const lines = text.split('\r\n');
  const at = lines.indexOf(line) + 1;
  assert.ok(at > 0 && lines[at].length > 0, `a Ctrl-C after ${JSON.stringify(line)} prints a notice`);
  lines.splice(at, 1);
  return lines.join('\r\n');
};

// Editing stays at the end, including after history, cancellation and a block.
{
  const view = capture();
  const calls = [];
  const run = new ReplSession({
    ...baseAdapter,
    push: async (line) => {
      calls.push(line);
      return line === 'block' ? { kind: 'incomplete' } : output(`EVAL ${calls.length}\n`);
    },
  }, view.terminal).run();
  try {
    view.reset();
    view.terminal.sendData('\x1b[A\x1b[B\b\x7fabc\b\x7fD\x1b[DX\x1b[CY\t\x04\r');
    await view.seen('EVAL 1');
    assert.equal(view.text(), 'abc\b \b\b \bDXY\r\nEVAL 1\r\n>>> ', 'end-only editing echoes each change once');
    view.terminal.sendData('two\r');
    await view.seen('EVAL 2');
    for (const [input, expected] of [
      ['draft\x1b[A', 'draft' + '\b'.repeat(5) + ' '.repeat(5) + '\b'.repeat(5) + 'two'],
      ['\x1b[A', '\b'.repeat(3) + ' '.repeat(3) + '\b'.repeat(3) + 'aDXY'],
      ['\x1b[B', '\b'.repeat(4) + ' '.repeat(4) + '\b'.repeat(4) + 'two'],
      ['\x1b[B', '\b'.repeat(3) + ' '.repeat(3) + '\b'.repeat(3)],
    ]) {
      view.reset();
      view.terminal.sendData(input);
      await view.seen(expected, 'history replacement');
      assert.equal(view.text(), expected, 'history replaces the displayed line without leaving a tail');
    }
    view.reset();
    view.terminal.sendData('fresh\bZ\r');
    await view.seen('EVAL 3');
    assert.equal(view.text(), 'fresh\b \bZ\r\nEVAL 3\r\n>>> ');
    view.terminal.sendData('\x1b[A\b!\r');
    await view.seen('EVAL 4');
    view.reset();
    view.terminal.sendData('discard\x03kept\r');
    await view.seen('EVAL 5');
    assert.equal(withoutNotice(view.text(), 'discard'), 'discard\r\n>>> kept\r\nEVAL 5\r\n>>> ');
    view.reset();
    view.terminal.sendData('block\r');
    await view.seen('... ');
    const beforeEof = view.text();
    view.terminal.sendData('\x04');
    assert.equal(view.text(), beforeEof, 'Ctrl-D inside an incomplete block neither redraws nor closes it');
    assert.deepEqual(calls, ['aDXY', 'two', 'fresZ', 'fres!', 'kept', 'block']);
    view.terminal.sendData('tailX\b\r');
    await view.seen('EVAL 7');
    view.reset();
    view.terminal.sendData('block\r');
    await view.seen('... ');
    view.terminal.sendData('abandoned\x03last\r');
    await view.seen('EVAL 9');
    assert.equal(withoutNotice(view.text(), '... abandoned'), 'block\r\n... abandoned\r\n>>> last\r\nEVAL 9\r\n>>> ');
    assert.deepEqual(calls, ['aDXY', 'two', 'fresZ', 'fres!', 'kept', 'block', 'block\ntail', 'block', 'last']);
    view.terminal.sendData('\x04');
    assert.equal(await bounded(run, 'empty-line Ctrl-D did not close the editor'), 0);
  } finally {
    await bounded(view.terminal.disposeRepl(), 'editing REPL cleanup hung');
    await bounded(run, 'editing REPL run did not end');
    view.terminal.close();
  }
}

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
    assert.ok(!view.text().includes(baseAdapter.ps1), 'interrupt reported readiness while evaluation remained active');
    assert.deepEqual(calls, ['first']);
    finished.resolve(output('STALE\n'));
    await view.seen('SECOND');
    assert.deepEqual(calls, ['first', 'second']);
    assert.doesNotMatch(view.text(), /STALE/);
    assert.equal(view.text().split(baseAdapter.ps1).length - 1, 2, 'each settled evaluation publishes one prompt');
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
    assert.ok(!view.text().includes(baseAdapter.ps1), 'unsupported or failed interrupt reported readiness');
    finished.resolve(output('PRESERVED\n'));
    await view.seen('PRESERVED');
    assert.equal(view.text().split(baseAdapter.ps1).length - 1, 1);
    assert.equal(view.text().split('PRESERVED').length - 1, 1);
    if (interrupt) assert.ok(view.text().includes('cannot cancel'), 'the adapter failure remains visible');
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
  await assert.rejects(view.terminal.disposeRepl(), (error) => error instanceof AggregateError
    && error.errors.length === 1 && error.errors[0].message === 'cleanup broke');
  view.terminal.close();
}

console.log('repl-lifecycle: all assertions passed');
