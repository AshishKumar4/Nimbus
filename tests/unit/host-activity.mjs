import assert from 'node:assert/strict';
import { HostActivity, HOST_INCARNATION_HEADER } from '../../packages/fabric/src/host-activity.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { testBox } from './lib/test-box.mjs';

const turns = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup() {
  const activity = new HostActivity();
  const calls = [], failures = [];
  let incarnation = 'one';
  const remove = activity.observe(async (signal) => {
    const call = { signal, cancelled: false, controller: null };
    calls.push(call);
    return new Response(new ReadableStream({ start(controller) { call.controller = controller; }, cancel() { call.cancelled = true; } }), {
      headers: { [HOST_INCARNATION_HEADER]: incarnation },
    });
  }, (error) => failures.push(error));
  return { activity, calls, failures, remove, change() { incarnation = 'two'; } };
}

{
  const t = setup();
  await turns();
  assert.equal(t.calls.length, 0, 'idle registration starts no I/O');
  const first = t.activity.acquire(), second = t.activity.acquire();
  await Promise.all([first.ready, second.ready]);
  assert.equal(t.calls.length, 1, 'overlapping work shares its observation');
  first.release(); await turns(); assert.equal(t.calls[0].signal.aborted, false);
  second.release(); await turns();
  assert.equal(t.calls[0].signal.aborted, true);
  assert.equal(t.calls[0].cancelled, true);
  assert.deepEqual(t.failures, [], 'idle cancellation is not host loss');
  t.change();
  let admitted = false;
  await assert.rejects(t.activity.run(() => { admitted = true; }), /restarted without its process/);
  assert.equal(admitted, false, 'wake validates the old incarnation before new work');
  assert.equal(t.failures.length, 1);
  t.remove();
}
{
  const t = setup(), lease = t.activity.acquire();
  await lease.ready;
  const error = new Error('host reset during active work');
  t.calls[0].controller.error(error);
  await turns();
  assert.deepEqual(t.failures, [error]);
  lease.release(); t.remove();
}
{
  const t = setup(), processes = new SessionProcessSupervisor();
  processes.setWorkObservation(() => t.activity.acquire());
  const abort = new AbortController();
  const work = processes.holdWork(100, () => {}, abort.signal);
  await work.ready;
  abort.abort(); await turns();
  assert.equal(t.calls[0].signal.aborted, true, 'cancelled work releases observation before uncooperative cleanup');
  work(); t.remove();
}
{
  const t = setup(), a = t.activity.acquire(); await a.ready;
  t.activity.close(); await turns();
  assert.equal(t.calls[0].signal.aborted, true);
  const b = t.activity.acquire(); await b.ready;
  a.release(); assert.equal(t.calls[1].signal.aborted, false, 'old leases cannot release a new session generation');
  b.release(); t.remove();
}
console.log('host-activity: idle, shared active watches, abort, wake validation and host loss');

{
  const t = setup(), processes = new SessionProcessSupervisor();
  const abort = new AbortController();
  const work = processes.holdWork(100, () => {}, abort.signal);
  abort.abort();
  processes.setWorkObservation(() => t.activity.acquire());
  await turns();
  assert.equal(t.calls.length, 0, 'late runtime composition cannot reactivate cancelled work');
  work(); t.remove();
}
{
  const activity = new HostActivity(), response = Promise.withResolvers();
  activity.observe(() => response.promise, () => assert.fail('closure is not host loss'));
  let admitted = false;
  const work = activity.run(() => { admitted = true; });
  await turns();
  activity.close();
  response.resolve(new Response(new ReadableStream(), { headers: { [HOST_INCARNATION_HEADER]: 'late' } }));
  await assert.rejects(work, /abort/i);
  assert.equal(admitted, false, 'session close cannot turn cancelled validation into admission');
}

{
  const t = setup(), box = await testBox();
  box.workspace.processes.setWorkObservation(() => t.activity.acquire());
  const first = await box.workspace.exec('echo admitted');
  assert.equal(first.exitCode, 0, first.stderr);
  t.change();
  const next = await box.workspace.exec('echo wrong > /home/user/after-lost-host');
  assert.notEqual(next.exitCode, 0, 'the shell refuses work from a lost incarnation');
  assert.match(next.stderr, /host.*restarted|restarted.*process/i);
  assert.equal(await box.fs.exists('/home/user/after-lost-host'), false, 'redirection cannot run before host validation');
  t.remove(); await box.workspace.close();
}
