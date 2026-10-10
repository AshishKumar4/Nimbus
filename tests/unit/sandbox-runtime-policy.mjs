import assert from 'node:assert/strict';
import { defineNimbusConfig } from '../../packages/config/src/sandbox.ts';
import { Nimbus } from '../../packages/sdk/src/sandbox.ts';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';
import { FakeNamespace } from '../behavioral/sdk/_fake-session.mjs';

const config = defineNimbusConfig({ sandboxes: { default: { runtimes: {
  allow: ['python', 'ruby'], onDemand: false, preinstall: ['python@3.13.14'],
} } } });
const calls = [];
const result = { command: 'code', exitCode: 0, success: true, duration: 0, timestamp: 0, stdout: 'ok\n', stderr: '' };
const binding = new FakeNamespace({
  async _rpcReady(options) { calls.push(['ready', options]); return { ok: true, preinstalled: options.preinstall }; },
  async _rpcRunCode(code, options) { calls.push(['code', options.language]); return result; },
  async _rpcInstallRuntime(spec) { calls.push(['install', spec]); return { spec, exitCode: 0 }; },
});
const env = { JWT_SECRET: 'policy-behavior-secret', NIMBUS_SESSION: binding };
const local = Nimbus.fromEnv(env, config).sandbox('policy-local');
for (const language of ['javascript', 'typescript', 'shell']) {
  await assert.rejects(local.runCode('code', { language }), /not allowed by sandbox profile/);
}
assert.equal(calls.length, 0, 'refused code never reaches readiness or execution');
assert.equal((await local.runCode('code', { language: 'python', install: 'ifMissing' })).stdout, 'ok\n');
assert.deepEqual(calls[0], ['ready', { preinstall: ['python@3.13.14'] }]);
await assert.rejects(local.runCode('code', { language: 'ruby', install: 'ifMissing' }), /on-demand runtime installs are disabled/);
assert.equal((await local.runCode('code', { language: 'ruby' })).stdout, 'ok\n');
await assert.rejects(local.runtimes.install('ruby@3.3.4'), /on-demand runtime installs are disabled/);
await local.runtimes.install('python@another-build');
assert.deepEqual(calls.at(-1), ['install', 'python@another-build'], 'a versioned preinstall authorizes its runtime name');

const handler = createNimbusHandler({ sdk: { remote: true, config } });
const token = await issueNimbusToken(env, { tn: 'policy', scopes: ['sandbox:use'] });
async function request(body) {
  return handler.fetch(new Request('https://policy.test/api/nimbus/v1/sandboxes/policy-remote/rpc', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env, { waitUntil() {} });
}
for (const language of ['javascript', 'typescript', 'shell']) {
  const response = await request({ op: 'runCode', args: ['code', { language }] });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'E_RUNTIME_NOT_ALLOWED');
}
const denied = await request({ op: 'runCode', args: ['code', { language: 'ruby', install: 'ifMissing' }] });
assert.equal(denied.status, 403);
assert.equal((await denied.json()).code, 'E_RUNTIME_ON_DEMAND_DISABLED');
const allowed = await request({ op: 'runCode', args: ['code', { language: 'python', install: 'ifMissing' }] });
assert.equal(allowed.status, 200);
assert.equal((await allowed.json()).result.stdout, 'ok\n');
await request({ op: 'ready', args: [{ preinstall: ['ruby'] }] });
assert.deepEqual(calls.at(-1), ['ready', { preinstall: ['python@3.13.14'] }], 'the server retains its authoritative preinstall selection');
console.log('sandbox-runtime-policy: ok');
