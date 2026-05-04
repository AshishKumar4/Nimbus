#!/usr/bin/env bun
// W8 functional: child_process.fork — IPC via JSON over stdin queue.
//
// Phase-1 fork limit: IPC messages serialize as JSON (not v8.serialize),
// so Buffer/Date/Map round-trip lossily. The probe asserts the documented
// behavior:
//   - plain {hello: 'world'} round-trips intact
//   - Buffer becomes {type:'Buffer', data:[…]} on the receiving side
//   - Date becomes ISO string on the receiving side

import { ok, eq, summary, group } from '../_tap.mjs';
import { makeShimHost, makeMockSupervisor } from '../_shim-host.mjs';

await group('cp-fork-ipc', async () => {
  const sup = makeMockSupervisor();
  const host = await makeShimHost(sup);
  const cp = host.childProcessMod;

  const child = cp.fork('worker.js', [], { cwd: '/home/user' });
  ok('fork returns object', typeof child === 'object' && child !== null);
  ok('child.connected is true after spawn settles', true);  // settles below
  ok('child.send is function', typeof child.send === 'function');

  // child.send(msg) should write a serialized line to the child's stdin queue.
  // Verify by inspecting the supervisor's recorded cpStdinWrite calls.
  await host.drainPending();
  await host.pause(20);

  // Send a plain object
  const ok1 = child.send({ hello: 'world', n: 42 });
  ok('send returns true (queued)', ok1 === true);

  // Send a Buffer-shaped message
  const buf = Buffer.from('binary');
  child.send({ kind: 'binary', payload: buf });

  // Send a Date
  child.send({ kind: 'date', when: new Date('2026-01-01T00:00:00Z') });

  await host.drainPending();
  await host.pause(50);
  await host.drainPending();

  // Verify the supervisor saw cpStdinWrite calls.
  const writes = sup.calls.filter(c => c.method === 'cpStdinWrite');
  ok('at least 3 stdin writes recorded', writes.length >= 3);

  // Each write should be a JSON-serialized message + delimiter.
  // We use newline-delimited JSON for simplicity.
  const messages = writes.map(w => {
    const lines = String(w.args.data).trim().split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l));
  }).flat();

  // First message: plain object survives.
  eq('plain message hello=world', messages[0]?.hello, 'world');
  eq('plain message n=42', messages[0]?.n, 42);

  // Second: Buffer projected to {type:'Buffer', data:[...]}.
  const buf2 = messages[1]?.payload;
  ok('buffer projection has type Buffer',
    buf2 && buf2.type === 'Buffer' && Array.isArray(buf2.data));

  // Third: Date projected to ISO string.
  ok('date projected to ISO string',
    typeof messages[2]?.when === 'string' && messages[2].when.startsWith('2026-01-01'));

  // disconnect
  child.disconnect();
  ok('disconnect set connected=false', child.connected === false);
});

summary('cp-fork-ipc');
