import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BASE;
const token = process.env.NIMBUS_PROBE_TOKEN;
assert.ok(base && token, 'BASE and NIMBUS_PROBE_TOKEN must name the isolated library-host fixture');
const names = [];
const name = () => { const value = `lifecycle-${randomUUID()}`; names.push(value); return value; };
async function raw(workspace, path, method = 'GET', body) {
  return fetch(`${base}/workspaces/${workspace}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
}
async function json(workspace, path, method = 'GET', body) {
  const response = await raw(workspace, path, method, body);
  const text = await response.text();
  assert.ok(response.ok, `${path}: ${response.status} ${text}`);
  return JSON.parse(text);
}
async function evict(workspace) {
  // ctx.abort deliberately terminates this request with its incarnation.
  await raw(workspace, '/evict', 'POST').catch(() => {});
}
async function reserve(workspace, owner, port) {
  return json(workspace, '/apps/reserve', 'POST', { owner, preferredPort: port });
}
async function spawn(workspace, owner, port) {
  return json(workspace, '/apps/spawn', 'POST', { owner, port });
}
const route = (app, path = '/hello') => `/ports/${app.port}/${app.capability}${path}`;

try {
  const workspace = name();
  const app = await reserve(workspace, 'application', 20701);
  assert.deepEqual(await reserve(workspace, 'application', 20701), app);
  assert.equal((await raw(workspace, route(app))).status, 404, 'reservation is not a launch');
  const first = await spawn(workspace, 'application', app.port);
  assert.equal(first.boot.marker, 'first');
  assert.deepEqual(await json(workspace, route(app)), { marker: 'first', path: '/hello' });
  assert.deepEqual(await json(workspace, route(app, '/stream')), { marker: 'first', path: '/stream' }, 'a streamed body crosses the port hop');
  const generation = (await json(workspace, '/state')).generation;
  await evict(workspace);
  const recovered = await Promise.all([json(workspace, route(app)), json(workspace, route(app))]);
  assert.deepEqual(recovered, [{ marker: 'recovered', path: '/hello' }, { marker: 'recovered', path: '/hello' }]);
  assert.ok((await json(workspace, '/state')).generation > generation);
  assert.equal((await json(workspace, '/apps/resolver?owner=application')).calls, 1);
  assert.deepEqual(await reserve(workspace, 'application', 20701), app, 'cold relaunch preserves URL');
  await json(workspace, '/apps/unexpose', 'POST', { port: app.port });
  assert.equal((await raw(workspace, route(app))).status, 404);
  await evict(workspace);
  assert.equal((await raw(workspace, route(app))).status, 404, 'revoked URL cannot cold boot');
  assert.equal((await json(workspace, '/apps/resolver?owner=application')).calls, 1);
  // Ownership survives unexpose; the capability it answered with does not.
  const renewed = await json(workspace, '/apps/reserve', 'POST', { owner: 'application' });
  assert.equal(renewed.port, app.port, 'unexpose retains ownership of the port');
  assert.notEqual(renewed.capability, app.capability, 'a revoked capability is not handed out again');
  assert.deepEqual(await json(workspace, '/apps/remove', 'POST', { owner: 'application' }), {
    owner: 'application', removed: true, port: app.port,
  });
  console.log('PASS preboot reservation, first boot, single-flight cold relaunch, revocation and ownership');

  for (const mode of ['null', 'reject']) {
    const stopped = name();
    const held = await reserve(stopped, mode, 20703);
    await spawn(stopped, mode, held.port);
    await json(stopped, '/apps/resolver', 'POST', { owner: mode, mode });
    await evict(stopped);
    const response = await raw(stopped, route(held));
    assert.equal(response.status, mode === 'null' ? 404 : 503);
    assert.equal((await json(stopped, '/apps/resolver?owner=' + mode)).calls, 1);
    assert.equal((await json(stopped, '/state')).ports.length, 0, 'custom veto/error cannot silently use persisted fallback');
  }
  console.log('PASS custom resolver null veto and rejection do not fall back');

  const retry = name();
  const held = await reserve(retry, 'retry', 20704);
  await json(retry, '/file', 'PUT', {
    path: '/home/user/retry.js',
    content: 'require("node:http").createServer((req,res)=>res.end("retry-ok")).listen(20704);',
  });
  await json(retry, '/lifecycle/fail', 'POST', { reason: 'resident-launch' });
  const failed = await json(retry, '/exec', 'POST', { command: 'node /home/user/retry.js' });
  assert.notEqual(failed.exitCode, 0);
  assert.match(failed.stderr + failed.stdout, /fixture schedule rejected/);
  assert.deepEqual(await reserve(retry, 'retry', 20704), held);
  const retried = await json(retry, '/exec', 'POST', { command: 'node /home/user/retry.js' });
  assert.equal(retried.exitCode, 0, retried.stderr);
  assert.equal(await (await raw(retry, route(held))).text(), 'retry-ok');
  console.log('PASS asynchronous scheduling rejection and explicit public operation retry');

  for (const reason of ['log-flush', 'log-janitor']) {
    const logs = name();
    await json(logs, '/lifecycle/fail', 'POST', { reason });
    // Log flushing is scheduled by a background process's relayed output; a
    // foreground exec streams to its caller and keeps no process log.
    await json(logs, '/start', 'POST', { command: 'node -e "console.log(\'lifecycle-log\')"' });
    const deadline = Date.now() + 10_000;
    let state;
    do {
      state = await json(logs, '/state');
      if (state.lifecycleErrors.some(error => error.includes(reason))) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.ok(state.lifecycleErrors.some(error => error.includes(reason)), `${reason} rejection was not observed`);
    await json(logs, '/start', 'POST', { command: 'node -e "console.log(\'retry-log\')"' });
    await json(logs, '/host-alarm', 'POST');
    const closed = await json(logs, '/close', 'POST');
    assert.deepEqual(closed.hostRows, [{ id: 'keep', value: 'host-owned' }]);
    assert.deepEqual(closed.scheduled.map(task => task.reason), ['host']);
    assert.deepEqual(await json(logs, '/close', 'POST'), closed, 'close is idempotent');
  }
  console.log('PASS log scheduling errors are observable and close preserves host SQL/unrelated schedules');
} finally {
  for (const workspace of names) {
    const response = await raw(workspace, '/destroy', 'DELETE');
    assert.ok(response.ok, `fixture cleanup failed: ${response.status} ${await response.text()}`);
  }
}
