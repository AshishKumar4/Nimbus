import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

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

