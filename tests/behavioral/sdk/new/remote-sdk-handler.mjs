#!/usr/bin/env bun
// sdk/new/remote-sdk-handler — createNimbusHandler exposes an
// authenticated remote sandbox API that delegates to NimbusSession RPC.

import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('sdk/new/remote-sdk-handler');
const { createNimbusHandler } = await import('../../../../packages/worker/src/router/index.ts');
const { issueNimbusToken } = await import('../../../../packages/worker/src/auth/token.ts');

class FakeNamespace {
  constructor(stub) {
    this.stub = stub;
    this.names = [];
  }
  idFromName(name) {
    this.names.push(name);
    return { name };
  }
  get(_id) {
    return this.stub;
  }
}

const calls = [];
const stub = {
  async _rpcReady(options) {
    calls.push(['ready', options]);
    return { ok: true, preinstalled: options?.preinstall ?? [] };
  },
  async _rpcExec(command, options) {
    calls.push(['exec', command, options]);
    return { command, exitCode: 0, success: true, stdout: 'ok\n', stderr: '', duration: 1, timestamp: 1 };
  },
  async _rpcWriteFile(path, content) {
    calls.push(['writeFile', path, content]);
  },
  async _rpcReadFileBytes(path) {
    calls.push(['readFileBytes', path]);
    return new Uint8Array([0, 255]);
  },
  async _rpcStat(path) {
    calls.push(['stat', path]);
    return { type: 'file', size: 2, mtime: 1, mode: 0o644 };
  },
  async _rpcInstallRuntime(spec, options) {
    calls.push(['installRuntime', spec, options]);
    return { spec, exitCode: 0 };
  },
  async _rpcDestroy(options) {
    calls.push(['destroy', options]);
    return { ok: true, killed: 0, destroyedAt: 1, reason: options?.reason ?? null };
  },
};

const env = {
  JWT_SECRET: 'remote-handler-secret',
  NIMBUS_SESSION: new FakeNamespace(stub),
};
const handler = createNimbusHandler({
  sdk: {
    remote: true,
    config: {
      sandboxes: {
        default: {
          root: '/home/user/default',
          runtimes: {
            preinstall: ['python'],
            onDemand: false,
            allow: ['node', 'python', 'ruby', 'shell'],
          },
        },
      },
    },
  },
});

async function rpc(sandboxId, token, body) {
  return handler.fetch(new Request(`https://nimbus.example.com/api/nimbus/v1/sandboxes/${sandboxId}/rpc`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }), env, { waitUntil() {} });
}

const missing = await rpc('job-123', null, { op: 'exec', args: ['echo nope'] });
const missingJson = await missing.json();
a.check('remote API rejects missing token',
  missing.status === 401 && missingJson.ok === false && missingJson.code === 'E_TOKEN_MALFORMED');

const wrongScopeToken = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['session:attach'],
  sid: 'job-123',
});
const wrongScope = await rpc('job-123', wrongScopeToken, { op: 'exec', args: ['echo nope'] });
const wrongScopeJson = await wrongScope.json();
a.check('remote API enforces sandbox scope',
  wrongScope.status === 403 && wrongScopeJson.code === 'E_SCOPE_MISSING');

const wrongSidToken = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['sandbox:use'],
  sid: 'other-job',
});
const wrongSid = await rpc('job-123', wrongSidToken, { op: 'exec', args: ['echo nope'] });
const wrongSidJson = await wrongSid.json();
a.check('remote API enforces sid pin',
  wrongSid.status === 403 && wrongSidJson.code === 'E_SESSION_PIN_MISMATCH');

const token = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['sandbox:use'],
  sid: 'job-123',
});
const exec = await rpc('job-123', token, { op: 'exec', args: ['echo ok'] });
const execJson = await exec.json();
a.check('remote API executes with valid token',
  exec.status === 200 && execJson.ok === true && execJson.result.stdout === 'ok\n');
a.check('remote API maps token to tenant-scoped DO name',
  env.NIMBUS_SESSION.names.at(-1) === 'acme:alice:job-123',
  env.NIMBUS_SESSION.names.at(-1));
a.check('remote API applies configured cwd',
  calls.find((c) => c[0] === 'exec')?.[2]?.cwd === '/home/user/default');

const write = await rpc('job-123', token, {
  op: 'writeFile',
  args: ['/home/user/blob.bin', { __nimbusWireType: 'bytes', base64: 'AP8=' }],
});
await write.json();
a.check('remote API decodes writeFile bytes',
  calls.find((c) => c[0] === 'writeFile')?.[2] instanceof Uint8Array
  && calls.find((c) => c[0] === 'writeFile')?.[2]?.[1] === 255);

const read = await rpc('job-123', token, { op: 'readFileBytes', args: ['/home/user/blob.bin'] });
const readJson = await read.json();
a.check('remote API encodes readFileBytes bytes',
  readJson.result.__nimbusWireType === 'bytes' && readJson.result.base64 === 'AP8=');

const stat = await rpc('job-123', token, { op: 'stat', args: ['/home/user/blob.bin'] });
const statJson = await stat.json();
a.check('remote API dispatches stat',
  stat.status === 200 && statJson.result?.type === 'file');

const blocked = await rpc('job-123', token, { op: 'installRuntime', args: ['ruby'] });
const blockedJson = await blocked.json();
a.check('remote API enforces server-side runtime policy',
  blocked.status === 403 && blockedJson.code === 'E_RUNTIME_ON_DEMAND_DISABLED');

const destroyMissingScope = await rpc('job-123', token, { op: 'destroy', args: [{ reason: 'test' }] });
const destroyMissingScopeJson = await destroyMissingScope.json();
a.check('remote API requires destructive scope for destroy',
  destroyMissingScope.status === 403 && destroyMissingScopeJson.code === 'E_SCOPE_MISSING');

const destroyToken = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['sandbox:use', 'session:destroy'],
  sid: 'job-123',
});
const destroy = await rpc('job-123', destroyToken, { op: 'destroy', args: [{ reason: 'test-cleanup' }] });
const destroyJson = await destroy.json();
a.check('remote API dispatches destroy with destructive scope',
  destroy.status === 200
  && destroyJson.ok === true
  && destroyJson.result?.reason === 'test-cleanup'
  && calls.find((c) => c[0] === 'destroy')?.[1]?.reason === 'test-cleanup');

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
