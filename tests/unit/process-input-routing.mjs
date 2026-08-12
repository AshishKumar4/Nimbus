#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { parseProcessLogClientFrame } from '../../packages/core/src/runtime/process-io-protocol.ts';
import { applyProcessClientFrame } from '../../packages/core/src/runtime/process-input-routing.ts';

const processes = new SessionProcessSupervisor();
const pid = 42;
processes.openInput(pid);

{
  const frame = parseProcessLogClientFrame(JSON.stringify({ type: 'input', data: 'hello' }));
  assert.equal(frame?.type, 'input');
  const result = await applyProcessClientFrame(processes, pid, frame);
  assert.deepEqual(result, { ok: true, pid, type: 'input' });
  assert.deepEqual(await processes.readInput(pid, 0), { data: 'hello', ended: false });
}

{
  const frame = parseProcessLogClientFrame(JSON.stringify({ type: 'resize', columns: 120, rows: 40 }));
  assert.equal(frame?.type, 'resize');
  const result = await applyProcessClientFrame(processes, pid, frame);
  assert.deepEqual(result, { ok: true, pid, type: 'resize' });
  assert.deepEqual(processes.terminal(pid), { pid, attached: false, columns: 120, rows: 40 });
  assert.deepEqual(await processes.readInput(pid, 0), {
    data: '',
    ended: false,
    resize: { columns: 120, rows: 40 },
  });
}

{
  // Resize storms coalesce: only the final dimensions remain queued.
  for (const [columns, rows] of [[121, 41], [122, 42], [123, 43]]) {
    const frame = parseProcessLogClientFrame(JSON.stringify({ type: 'resize', columns, rows }));
    assert.equal(frame?.type, 'resize');
    const result = await applyProcessClientFrame(processes, pid, frame);
    assert.deepEqual(result, { ok: true, pid, type: 'resize' });
  }
  assert.deepEqual(processes.terminal(pid), { pid, attached: false, columns: 123, rows: 43 });
  assert.deepEqual(await processes.readInput(pid, 0), {
    data: '',
    ended: false,
    resize: { columns: 123, rows: 43 },
  });
  assert.deepEqual(await processes.readInput(pid, 0), { data: '', ended: false });
}

{
  const frame = parseProcessLogClientFrame(JSON.stringify({ type: 'signal', signal: 'SIGINT' }));
  assert.equal(frame?.type, 'signal');
  const result = await applyProcessClientFrame(processes, pid, frame);
  assert.deepEqual(result, { ok: true, pid, type: 'signal' });
  assert.deepEqual(await processes.readInput(pid, 0), {
    data: '',
    ended: false,
    signal: 'SIGINT',
  });
}

{
  assert.equal(
    parseProcessLogClientFrame(JSON.stringify({ type: 'signal', signal: 'SIGCUSTOM' })),
    null,
  );
}

{
  assert.equal(
    parseProcessLogClientFrame(JSON.stringify({ type: 'resize', columns: 0, rows: 24 })),
    null,
  );
}

{
  const frame = parseProcessLogClientFrame(JSON.stringify({ type: 'input', data: 'bad-pid' }));
  assert.equal(frame?.type, 'input');
  const result = await applyProcessClientFrame(processes, Number.NaN, frame);
  assert.deepEqual(result, { ok: false, pid: 0, type: 'input' });
}

{
  const unopenedPid = 99;
  const frame = parseProcessLogClientFrame(JSON.stringify({ type: 'input', data: 'missing-process' }));
  assert.equal(frame?.type, 'input');
  const result = await applyProcessClientFrame(processes, unopenedPid, frame);
  assert.deepEqual(result, { ok: false, pid: unopenedPid, type: 'input' });
  assert.equal(processes.hasInput(unopenedPid), false);
}

{
  const frame = parseProcessLogClientFrame(JSON.stringify({ type: 'stdin-end' }));
  assert.equal(frame?.type, 'stdin-end');
  const result = await applyProcessClientFrame(processes, Number.NaN, frame);
  assert.deepEqual(result, { ok: false, pid: 0, type: 'stdin-end' });
}

{
  const frame = parseProcessLogClientFrame(JSON.stringify({ type: 'stdin-end' }));
  assert.equal(frame?.type, 'stdin-end');
  const result = await applyProcessClientFrame(processes, pid, frame);
  assert.deepEqual(result, { ok: true, pid, type: 'stdin-end' });
  assert.deepEqual(await processes.readInput(pid, 0), { data: '', ended: true });
}

console.log('process-input-routing: ok');
