import assert from 'node:assert/strict';
import { HostActivity, HOST_INCARNATION_HEADER, SentRequests } from '../../packages/fabric/src/host-activity.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { testBox } from './lib/test-box.mjs';

const turns = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup() {
  const activity = new HostActivity();
  const calls = [], failures = [];
  let incarnation = 'one';
  const target = activity.observe(async (signal) => {
    const call = { signal, cancelled: false, controller: null };
    calls.push(call);
    return new Response(new ReadableStream({ start(controller) { call.controller = controller; }, cancel() { call.cancelled = true; } }), {
      headers: { [HOST_INCARNATION_HEADER]: incarnation },
    });
  }, (error) => failures.push(error), 'one');
  return { activity, target, calls, failures, remove: target.close, change() { incarnation = 'two'; } };
}

{
  const t = setup();
  await turns();
  assert.equal(t.calls.length, 0, 'idle registration starts no I/O');
  const first = t.target.acquire(), second = t.target.acquire();
  await Promise.all([first.ready, second.ready]);
  assert.equal(t.calls.length, 1, 'overlapping work shares its observation');
  first.release(); await turns(); assert.equal(t.calls[0].signal.aborted, false);
  second.release(); await turns();
  assert.equal(t.calls[0].signal.aborted, true);
  assert.equal(t.calls[0].cancelled, true);
  assert.deepEqual(t.failures, [], 'idle cancellation is not host loss');
  t.change();
  let admitted = false;
  const lease = t.target.acquire();
  try { await assert.rejects(lease.ready.then(() => { admitted = true; }), /restarted without its process/); }
  finally { lease.release(); }
  assert.equal(admitted, false, 'wake validates the old incarnation before new work');
  assert.equal(t.failures.length, 1);
  t.remove();
}
{
  const t = setup(), lease = t.target.acquire();
  await lease.ready;
  const error = new Error('host reset during active work');
  t.calls[0].controller.error(error);
  await turns();
  assert.deepEqual(t.failures, [error]);
  lease.release(); t.remove();
}
{
  const t = setup(), processes = new SessionProcessSupervisor();
  processes.setWorkObservation(() => t.target.acquire());
  const abort = new AbortController();
  const work = processes.holdWork(100, () => {}, abort.signal);
  await turns();
  assert.equal(t.calls.length, 1, 'held work observes its residents');
  abort.abort(); await turns();
  assert.equal(t.calls[0].signal.aborted, true, 'cancelled work releases observation before uncooperative cleanup');
  work(); t.remove();
}
{
  const t = setup(), a = t.target.acquire(); await a.ready;
  t.activity.close(); await turns();
  assert.equal(t.calls[0].signal.aborted, true);
  const b = t.target.acquire(); await b.ready;
  a.release(); assert.equal(t.calls[1].signal.aborted, false, 'old leases cannot release a new session generation');
  b.release(); t.remove();
}
{
  // A request that was not delivered is abandoned; an abandon that does not
  // arrive (its target busy, not gone) rides the next request instead of
  // being reported ended, which would make the leaf forget it unabandoned.
  const sent = new SentRequests(), abandons = [];
  const first = sent.send();
  assert.deepEqual(first, { id: 0, ended: [], abandoned: [] });
  sent.settled(first.id, true, async () => {});
  const second = sent.send(), third = sent.send();
  sent.settled(second.id, false, async (id) => { abandons.push(id); throw new Error('overloaded'); });
  sent.settled(third.id, false, async (id) => { abandons.push(id); });
  await turns();
  assert.deepEqual(abandons, [1, 2]);
  const carrying = sent.send();
  assert.deepEqual(carrying, { id: 3, ended: [0, 2], abandoned: [1] });
  sent.settled(carrying.id, true, async () => {});
  // The call that carried them failed: the next one carries them again.
  sent.unsent(carrying);
  assert.deepEqual(sent.send(), { id: 4, ended: [3, 0, 2], abandoned: [1] });
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
  const target = activity.observe(() => response.promise, () => assert.fail('closure is not host loss'), 'late');
  let admitted = false;
  const lease = target.acquire();
  const work = lease.ready.then(() => { admitted = true; });
  await turns();
  activity.close();
  response.resolve(new Response(new ReadableStream(), { headers: { [HOST_INCARNATION_HEADER]: 'late' } }));
  await assert.rejects(work, /abort/i);
  lease.release();
  assert.equal(admitted, false, 'session close cannot turn cancelled validation into admission');
}

{
  const t = setup(), box = await testBox();
  box.workspace.processes.setWorkObservation(() => t.activity.acquire());
  const first = await box.workspace.exec('echo admitted');
  assert.equal(first.exitCode, 0, first.stderr);
  t.change();
  const next = await box.workspace.exec('echo wrong > /home/user/after-lost-host');
  assert.equal(next.exitCode, 0, 'a lost resident does not refuse unrelated shell work');
  assert.equal(await box.fs.exists('/home/user/after-lost-host'), true, 'unrelated redirection remains usable');
  await turns();
  assert.equal(t.failures.length, 1, 'the loss is still reported to the process that owns the observation');
  t.remove(); await box.workspace.close();
}
