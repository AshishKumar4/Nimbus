import assert from 'node:assert/strict';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { _rpcUnregisterPort } from '../../packages/worker/src/session/rpc.ts';

// One session authority must assign distinct ports even when each guest's
// native allocator would independently choose the same listen(0) port.
const ports = new PortRegistry();
ports.register(49152, 11);
const first = ports.allocate(12);
const second = ports.allocate(13);
assert.notEqual(first, second);
assert.notEqual(first, 49152, 'an explicitly bound port is unavailable');
for (const port of [first, second]) assert.ok(port >= 49152 && port <= 65535);
assert.equal(ports.get(first).pid, 12);
assert.equal(ports.get(second).pid, 13);
ports.unregisterByPid(12);
assert.equal(ports.get(first), undefined, 'pid cleanup releases its reservation');
assert.equal(ports.get(second).pid, 13, 'other processes keep their listeners');
assert.equal(ports.get(49152).pid, 11);
const reused = ports.allocate(14);
assert.equal(reused, first, 'a released reservation is available again');
// Delayed close from an old process cannot revoke the current owner's route.
ports.register(7070, 20);
ports.register(7070, 21);
await _rpcUnregisterPort({ portRegistry: ports }, 20, 7070);
assert.equal(ports.get(7070).pid, 21);
await _rpcUnregisterPort({ portRegistry: ports }, 21, 7070);
assert.equal(ports.get(7070), undefined);
console.log('port-registry-ephemeral: session-wide allocation preserves ownership');
