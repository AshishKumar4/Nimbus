import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { WebSocketTerminal } from '../../packages/worker/src/facets/ws-terminal.ts';
import { testBox } from './lib/test-box.mjs';

const { NimbusSession } = await importWorkerBundle({ 'packages/worker/src/session/nimbus-session.ts': ['NimbusSession'] });
const input = [], replies = [];
let minted = 0, disposed = 0;
const env = { NIMBUS_SESSION: {
  idFromName: (id) => id, idFromString: (id) => id,
  get() {
    minted++;
    return {
      _rpcTerminalInput(frame, terminalId) {
        const reply = Promise.withResolvers();
        input.push([frame, terminalId]); replies.push(reply);
        return reply.promise;
      },
      [Symbol.dispose]() { disposed++; },
    };
  },
} };
const session = Object.assign(Object.create(NimbusSession.prototype), {
  ctx: { id: 'session' }, env, terminal: { id: 'terminal', signal: new AbortController().signal, writeln() {} },
  terminalInputDispatcher: null, terminalInputPending: 0,
});
const turns = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
session.dispatchTerminalInput('first');
session.dispatchTerminalInput('second');
await turns();
assert.equal(minted, 1, 'overlapping inputs share the FIFO stub');
assert.deepEqual(input, [['first', 'terminal'], ['second', 'terminal']]);
replies[1].resolve(); await turns();
assert.equal(disposed, 0, 'one unfinished input still owns the stub');
replies[0].resolve(); await turns();
assert.equal(disposed, 1, 'all completed inputs release their native RPC owner');
session.dispatchTerminalInput('third'); await turns();
assert.equal(minted, 2, 'an idle input batch cannot keep a native context alive');
replies[2].resolve(); await turns();
assert.equal(disposed, 2);

{
  const box = await testBox(), waiting = Promise.withResolvers(), entered = Promise.withResolvers();
  const frames = [], requests = [];
  const terminal = new WebSocketTerminal({ readyState: 1, send(value) { frames.push(JSON.parse(value)); }, close() {} });
  box.shell.bindTerminal(terminal);
  let observations = 0, released = 0;
  box.workspace.processes.setWorkObservation(() => {
    if (observations++ === 0) { entered.resolve(); return { ready: waiting.promise, release() {} }; }
    return { release() {} };
  });
  const owner = Object.assign(Object.create(NimbusSession.prototype), {
    ctx: { id: 'admission' }, terminal, shell: box.shell, terminalInputDispatcher: null, terminalInputPending: 0,
    env: { NIMBUS_SESSION: { idFromName: id => id, idFromString: id => id, get() { return {
      _rpcTerminalInput(frame, id) { const pending = Promise.resolve().then(() => owner._rpcTerminalInput(frame, id)); requests.push(pending); return pending; },
      [Symbol.dispose]() { released++; },
    }; } } },
  });
  const send = (data, submissionId) => owner.dispatchTerminalInput(JSON.stringify({ type: 'input', data, submissionId }));
  try {
    send('echo NEVER_ADMITTED\r', 'blocked'); await entered.promise;
    send('echo QUEUED_ADMITTED\r', 'queued'); await turns();
    send('\x03', 'interrupt'); await turns();
    const finished = await Promise.race([Promise.all(requests).then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]);
    assert.equal(finished, true, 'interrupted admission settles queued submission RPCs');
    await turns(); terminal.flushNow();
    assert.equal(owner.terminalInputPending, 0);
    assert.equal(released, 1, 'the whole input batch releases its FIFO RPC owner');
    const completed = frames.filter(frame => frame.type === 'shell-integration' && frame.event === 'complete');
    assert.ok(completed.some(frame => frame.submissionId === 'blocked' && frame.status === 130), JSON.stringify(frames));
    assert.ok(completed.some(frame => frame.submissionId === 'queued' && frame.status === 0), JSON.stringify(frames));
  } finally { waiting.resolve(); terminal.close(); await box.workspace.close(); }
}
