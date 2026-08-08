#!/usr/bin/env bun
// computesdk-provider — the @computesdk/nimbus adapter, driven through the
// ComputeSDK provider interface against a recording fake of the Nimbus
// remote RPC wire.
//
// Every assertion checks the ops that actually crossed the wire, not just
// the value returned. A provider that resolved without calling Nimbus
// would satisfy the return types and fail these tests.

import assert from 'node:assert/strict';
import { nimbus } from '../../packages/computesdk-nimbus/src/index.ts';

const ENDPOINT = 'https://nimbus.test';

/**
 * Stands in for the Nimbus deployment. `handlers` maps an op name to a
 * result (or a function of the args); every call is recorded. A handler
 * value of `undefined` is the void wire shape (`{ok:true}` with no
 * `result`); note `writeFile` is NOT void — the DO answers with the byte
 * count it wrote, so its handlers return a number.
 */
function fakeNimbus(handlers = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), op: body.op, args: body.args, root: body.root, tenant: body.tenant });

    if (!Object.hasOwn(handlers, body.op)) {
      return new Response(JSON.stringify({ ok: false, error: `unhandled op: ${body.op}` }), { status: 500 });
    }
    const handler = handlers[body.op];
    const result = typeof handler === 'function' ? handler(body.args) : handler;
    // Void ops answer `{ok:true}` with no `result` key.
    const payload = result === undefined ? { ok: true } : { ok: true, result };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return { calls, ops: () => calls.map((c) => c.op), fetchImpl };
}

function withFetch(fetchImpl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

const execResult = (over = {}) => ({
  command: 'node -v',
  exitCode: 0,
  success: true,
  stdout: 'v22.0.0\n',
  stderr: '',
  duration: 12,
  timestamp: Date.now(),
  ...over,
});

// create() materializes the Durable Object and marks ownership.
{
  const fake = fakeNimbus({ ready: { ok: true, preinstalled: [] }, writeFile: 12 });
  const provider = nimbus({ endpoint: ENDPOINT, token: 't' });

  const sandbox = await withFetch(fake.fetchImpl, () => provider.sandbox.create());

  assert.deepEqual(fake.ops(), ['ready', 'writeFile'], 'create must materialize then mark');
  const [, write] = fake.calls;
  assert.equal(write.args[0], '/home/user/.computesdk/sandbox.json', 'marker is root-absolute');
  const marker = JSON.parse(write.args[1]);
  assert.equal(typeof marker.createdAt, 'number');
  assert.ok(marker.createdAt > 0, 'marker records a real creation time');
  assert.ok(sandbox.sandboxId.startsWith('csdk-'));
  assert.match(sandbox.sandboxId, /^[a-z0-9-]+$/, 'id stays preview-host safe');
}

// A caller-supplied name is used verbatim as the sandbox id.
{
  const fake = fakeNimbus({ ready: { ok: true, preinstalled: [] }, writeFile: 12 });
  const provider = nimbus({ endpoint: ENDPOINT });
  const sandbox = await withFetch(fake.fetchImpl, () => provider.sandbox.create({ name: 'my-box' }));
  assert.equal(sandbox.sandboxId, 'my-box');
  assert.ok(fake.calls[0].url.endsWith('/api/nimbus/v1/sandboxes/my-box/rpc'));
}

// Templates and snapshots are refused, not silently ignored.
{
  const fake = fakeNimbus({});
  const provider = nimbus({ endpoint: ENDPOINT });
  await withFetch(fake.fetchImpl, async () => {
    await assert.rejects(
      () => provider.sandbox.create({ templateId: 'ubuntu' }),
      /does not support templates or snapshots/,
    );
  });
  assert.deepEqual(fake.calls, [], 'an unsupported option must not reach the wire');
}

// getById on an id that was never created reports a miss and cleans up the
// Durable Object the probe itself materialized.
{
  const fake = fakeNimbus({
    ready: { ok: true, preinstalled: [] },
    readFile: null,
    destroy: { ok: true, killed: 0, destroyedAt: Date.now(), reason: 'computesdk-getbyid-miss' },
  });
  const provider = nimbus({ endpoint: ENDPOINT });

  const found = await withFetch(fake.fetchImpl, () => provider.sandbox.getById('ghost'));

  assert.equal(found, null, 'a missing marker is a miss');
  assert.ok(fake.ops().includes('destroy'), 'the probe must not leak a Durable Object');
}

// getById on a real sandbox reports the creation time the marker recorded.
{
  const createdAt = 1_700_000_000_000;
  const fake = fakeNimbus({
    ready: { ok: true, preinstalled: [] },
    readFile: JSON.stringify({ createdAt, envs: { FOO: 'bar' } }),
  });
  const provider = nimbus({ endpoint: ENDPOINT });

  const sandbox = await withFetch(fake.fetchImpl, () => provider.sandbox.getById('real-box'));
  assert.ok(sandbox, 'a present marker is a hit');
  assert.equal(sandbox.sandboxId, 'real-box');

  const info = await sandbox.getInfo();
  assert.equal(info.provider, 'nimbus');
  assert.equal(info.status, 'running');
  assert.equal(
    info.createdAt.getTime(),
    createdAt,
    'createdAt comes from the marker, not from the time getInfo was called',
  );
}

// list() refuses rather than returning an empty array that reads as "none".
{
  const provider = nimbus({ endpoint: ENDPOINT });
  await assert.rejects(() => provider.sandbox.list(), /does not support listing sandboxes/);
}

// runCommand maps the Nimbus exec result, carrying its measured duration.
{
  const fake = fakeNimbus({
    ready: { ok: true, preinstalled: [] },
    writeFile: 12,
    exec: execResult({ duration: 34, stdout: 'v22.0.0\n' }),
  });
  const provider = nimbus({ endpoint: ENDPOINT });

  const result = await withFetch(fake.fetchImpl, async () => {
    const sandbox = await provider.sandbox.create();
    return sandbox.runCommand('node -v');
  });

  assert.equal(result.stdout, 'v22.0.0\n');
  assert.equal(result.exitCode, 0);
  assert.equal(result.durationMs, 34, 'durationMs is Nimbus’s measurement, not a re-timing');
  const exec = fake.calls.find((c) => c.op === 'exec');
  assert.equal(exec.args[0], 'node -v');
}

// A non-zero exit is reported as a result, not thrown.
{
  const fake = fakeNimbus({
    ready: { ok: true, preinstalled: [] },
    writeFile: 12,
    exec: execResult({ exitCode: 127, success: false, stdout: '', stderr: 'not found\n' }),
  });
  const provider = nimbus({ endpoint: ENDPOINT });

  const result = await withFetch(fake.fetchImpl, async () => {
    const sandbox = await provider.sandbox.create();
    return sandbox.runCommand('nope');
  });

  assert.equal(result.exitCode, 127);
  assert.equal(result.stderr, 'not found\n');
}

// The environment given to create is re-applied on later commands, because
// Nimbus has no persistent per-sandbox environment.
{
  const fake = fakeNimbus({
    ready: { ok: true, preinstalled: [] },
    writeFile: 12,
    exec: execResult(),
  });
  const provider = nimbus({ endpoint: ENDPOINT });

  await withFetch(fake.fetchImpl, async () => {
    const sandbox = await provider.sandbox.create({ envs: { TOKEN: 'abc' } });
    await sandbox.runCommand('env', { env: { EXTRA: '1' } });
  });

  const exec = fake.calls.find((c) => c.op === 'exec');
  assert.deepEqual(exec.args[1].env, { TOKEN: 'abc', EXTRA: '1' });
}

// Filesystem paths resolve against the sandbox root; a missing file is ENOENT.
{
  const fake = fakeNimbus({
    ready: { ok: true, preinstalled: [] },
    writeFile: 12,
    readFile: (args) => (args[0] === '/home/user/app.js' ? 'console.log(1)' : null),
  });
  const provider = nimbus({ endpoint: ENDPOINT });

  await withFetch(fake.fetchImpl, async () => {
    const sandbox = await provider.sandbox.create();
    assert.equal(await sandbox.filesystem.readFile('app.js'), 'console.log(1)');
    await assert.rejects(() => sandbox.filesystem.readFile('missing.js'), /ENOENT/);
  });
}

// An absolute path is left alone, and a custom root is honoured.
{
  const fake = fakeNimbus({
    ready: { ok: true, preinstalled: [] },
    writeFile: 12,
    readFile: 'x',
  });
  const provider = nimbus({ endpoint: ENDPOINT, root: '/workspace' });

  await withFetch(fake.fetchImpl, async () => {
    const sandbox = await provider.sandbox.create();
    await sandbox.filesystem.readFile('src/a.ts');
    await sandbox.filesystem.readFile('/etc/hosts');
  });

  const reads = fake.calls.filter((c) => c.op === 'readFile').map((c) => c.args[0]);
  assert.deepEqual(reads, ['/workspace/src/a.ts', '/etc/hosts']);
  const marker = fake.calls.find((c) => c.op === 'writeFile');
  assert.equal(marker.args[0], '/workspace/.computesdk/sandbox.json');
}

// readdir maps entry types without inventing size or modification time.
{
  const fake = fakeNimbus({
    ready: { ok: true, preinstalled: [] },
    writeFile: 12,
    readdir: [{ name: 'src', type: 'directory' }, { name: 'a.ts', type: 'file' }],
  });
  const provider = nimbus({ endpoint: ENDPOINT });

  const entries = await withFetch(fake.fetchImpl, async () => {
    const sandbox = await provider.sandbox.create();
    return sandbox.filesystem.readdir('.');
  });

  assert.deepEqual(entries, [
    { name: 'src', type: 'directory' },
    { name: 'a.ts', type: 'file' },
  ]);
  assert.equal(fake.calls.filter((c) => c.op === 'stat').length, 0, 'no N+1 stat storm');
}

// getUrl exposes the port and returns the host-form preview origin.
{
  const fake = fakeNimbus({
    ready: { ok: true, preinstalled: [] },
    writeFile: 12,
    exposePort: { port: 3000, listening: true, pid: 7, registeredAt: Date.now() },
  });
  const provider = nimbus({
    endpoint: ENDPOINT,
    previewHostSuffix: 'nimbus-os.dev',
  });

  const url = await withFetch(fake.fetchImpl, async () => {
    const sandbox = await provider.sandbox.create({ name: 'web-app' });
    return sandbox.getUrl({ port: 3000 });
  });

  assert.equal(url, 'https://3000--web-app.nimbus-os.dev/');
  assert.ok(fake.ops().includes('exposePort'), 'the port must actually be exposed');
}

// Without a preview suffix the URL falls back to the endpoint-relative form.
{
  const fake = fakeNimbus({
    ready: { ok: true, preinstalled: [] },
    writeFile: 12,
    exposePort: { port: 8080, listening: true, pid: 7, registeredAt: Date.now() },
  });
  const provider = nimbus({ endpoint: ENDPOINT });

  const url = await withFetch(fake.fetchImpl, async () => {
    const sandbox = await provider.sandbox.create({ name: 'web-app' });
    return sandbox.getUrl({ port: 8080 });
  });

  assert.equal(url, `${ENDPOINT}/s/web-app/port/8080/`);
}

// destroy reaches Nimbus with a reason.
{
  const fake = fakeNimbus({
    destroy: { ok: true, killed: 2, destroyedAt: Date.now(), reason: 'computesdk-destroy' },
  });
  const provider = nimbus({ endpoint: ENDPOINT });

  await withFetch(fake.fetchImpl, () => provider.sandbox.destroy('doomed'));

  assert.deepEqual(fake.ops(), ['destroy']);
  assert.ok(fake.calls[0].url.endsWith('/sandboxes/doomed/rpc'));
}

// A missing endpoint fails with setup guidance rather than a network error.
{
  await assert.rejects(() => nimbus({}).sandbox.create(), /Missing Nimbus endpoint/);
}

console.log('computesdk-provider: all assertions passed');
