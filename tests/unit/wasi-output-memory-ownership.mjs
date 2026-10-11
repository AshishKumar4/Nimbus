import assert from 'node:assert/strict';
import { wasiOutputRelay } from '../../packages/core/src/runtime/wasi/stdio.ts';
let acknowledge;
const first = new Promise(resolve => { acknowledge = resolve; });
const received = [];
const relay = wasiOutputRelay({
  stdout(bytes) { received.push([...bytes]); return received.length === 1 ? first : undefined; },
  stderr(bytes) { received.push([...bytes]); },
});
relay.stdoutBytes(new Uint8Array([1]));
const guestMemory = new Uint8Array([65,66,67]);
relay.stderrBytes(guestMemory);
guestMemory.fill(88);
acknowledge();
await relay.drain();
assert.deepEqual(received, [[1],[65,66,67]], 'queued fd_write output owns its bytes before the guest reuses linear memory');
console.log('wasi-output-memory-ownership: pending output is immune to later guest memory writes');
