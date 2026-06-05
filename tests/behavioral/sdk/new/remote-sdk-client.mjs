#!/usr/bin/env bun
// sdk/new/remote-sdk-client — Nimbus.connect uses the same sandbox
// handle API as Nimbus.fromEnv and transports binary file payloads safely.

import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('sdk/new/remote-sdk-client');
const { Nimbus, NimbusRemoteError } = await import('../../../../packages/sdk/src/index.ts');

const calls = [];
const fetchImpl = async (url, init) => {
  const headers = new Headers(init.headers);
  const body = JSON.parse(init.body);
  calls.push({ url, headers, body });

  if (body.op === 'readFileBytes') {
    return Response.json({
      ok: true,
      result: { __nimbusWireType: 'bytes', base64: 'AP8=' },
    });
  }
  if (body.op === 'stat') {
    return Response.json({
      ok: true,
      result: { type: 'file', size: 2, mtime: 1, mode: 420 },
    });
  }
  if (body.op === 'exec') {
    return Response.json({
      ok: true,
      result: {
        command: body.args[0],
        exitCode: 0,
        success: true,
        stdout: '4\n',
        stderr: '',
        duration: 1,
        timestamp: 1,
      },
    });
  }
  if (body.op === 'installRuntime') {
    return Response.json({
      ok: false,
      error: 'blocked',
      code: 'E_RUNTIME_ON_DEMAND_DISABLED',
    }, { status: 403 });
  }
  return Response.json({ ok: true, result: { ok: true, preinstalled: [] } });
};

const nimbus = Nimbus.connect({
  endpoint: 'https://nimbus.example.com/',
  token: 'jwt',
  headers: { 'X-Trace': 'abc' },
  fetch: fetchImpl,
  config: {
    sandboxes: {
      default: {
        root: '/home/user/project',
        runtimes: {
          preinstall: ['python'],
          onDemand: false,
          allow: ['node', 'python', 'shell'],
        },
      },
    },
  },
});

const box = nimbus.sandbox('job-123');
await box.files.write('/home/user/blob.bin', new Uint8Array([0, 255]));
const bytes = await box.files.readBytes('/home/user/blob.bin');
const stat = await box.files.stat('/home/user/blob.bin');
const result = await box.exec('node -e "console.log(4)"');

a.check('remote URL is versioned and sandbox-scoped',
  calls[0].url === 'https://nimbus.example.com/api/nimbus/v1/sandboxes/job-123/rpc',
  calls[0].url);
a.check('remote client sends bearer token',
  calls[0].headers.get('Authorization') === 'Bearer jwt');
a.check('remote client preserves custom headers',
  calls[0].headers.get('X-Trace') === 'abc');
a.check('ready is the first remote operation',
  calls[0].body.op === 'ready');
a.check('writeFile encodes bytes',
  calls.find((c) => c.body.op === 'writeFile')?.body.args[1]?.__nimbusWireType === 'bytes');
a.check('readFileBytes decodes bytes',
  bytes instanceof Uint8Array && bytes.length === 2 && bytes[0] === 0 && bytes[1] === 255);
a.check('files.stat calls remote stat operation',
  stat?.type === 'file' && calls.find((c) => c.body.op === 'stat')?.body.args[0] === '/home/user/blob.bin');
a.check('exec result is decoded unchanged',
  result.success === true && result.stdout === '4\n');
a.check('exec cwd defaults to profile root',
  calls.find((c) => c.body.op === 'exec')?.body.args[1]?.cwd === '/home/user/project');

let blocked = false;
try {
  await box.runtimes.install('python');
} catch (e) {
  blocked = e instanceof NimbusRemoteError
    && e.status === 403
    && e.code === 'E_RUNTIME_ON_DEMAND_DISABLED';
}
a.check('remote errors use NimbusRemoteError', blocked);

const originalFetch = globalThis.fetch;
let defaultFetchThis = null;
try {
  globalThis.fetch = function (_url, _init) {
    defaultFetchThis = this;
    return Response.json({ ok: true, result: { ok: true, preinstalled: [] } });
  };
  await Nimbus.connect({ endpoint: 'https://nimbus.example.com' })
    .sandbox('bind-test')
    .ready();
  a.check('default fetch is bound for Workers runtime',
    defaultFetchThis === globalThis);
} finally {
  globalThis.fetch = originalFetch;
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
