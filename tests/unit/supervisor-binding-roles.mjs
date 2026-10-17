#!/usr/bin/env bun
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { supervisorBindingProps, mintProcessSupervisor } from '../../packages/fabric/src/supervisor-props.ts';
mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } }));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
const { adoptCtxExports } = await import('../../packages/fabric/src/composition.ts');
const { PROCESS_HOST_MODES, createCtxExports, createFacetWorld, createProcessHost } = await import('./lib/facet-host-harness.mjs');
const { runnerLoader } = await import('./lib/one-shot-runner.mjs');
const { missingAssets } = await import('./lib/staged-assets.mjs');
const state = { id: { toString: () => 'session' } };
assert.throws(() => supervisorBindingProps(state, 7, { network: ISOLATE_NETWORK }), /requires a run/);
assert.throws(() => supervisorBindingProps(state, 7, { writerId: '', network: ISOLATE_NETWORK }), /requires a run/);
const props = supervisorBindingProps(state, 7, { writerId: 'one-run', network: ISOLATE_NETWORK });
assert.equal(props.bindingKind, 'process');
assert.equal(props.writerId, 'one-run');
const sent = [];
const capability = mintProcessSupervisor(({ props }) => { sent.push(props); return { props }; }, props);
assert.equal(capability.props.writerId, 'one-run');
assert.throws(() => mintProcessSupervisor(() => {}, { doId: 's', pid: 7, bindingKind: 'infrastructure' }), /cannot hand a process/);
assert.throws(() => mintProcessSupervisor(() => {}, { ...props, writerId: undefined }), /cannot hand a process/);
const received = [];
const env = { NIMBUS_SESSION: { idFromName: (id) => id, idFromString: (id) => id, get: () => ({ supervisorOp: async (e) => { received.push(e); return true; } }) } };
const guest = new SupervisorRPC({ props }, env);
await guest.cpKill(8, 'SIGTERM');
assert.equal(received.at(-1).run, 'one-run');
for (const badProps of [{ doId: 's', pid: 7 }, { doId: 's', pid: 7, bindingKind: 'process' }, { doId: 's', pid: 7, bindingKind: 'infrastructure' }]) {
  const bad = new SupervisorRPC({ props: badProps }, env);
  await assert.rejects(bad.cpSpawn({ command: 'node' }), /run|guest-originated/);
  await assert.rejects(bad.stdinFileRead('/input', 0, 1), /run|guest-originated/);
  await assert.rejects(bad.stdout(new Uint8Array([1])), /run|guest-originated/);
  const before = received.length;
  await assert.rejects(bad.cpReadStdin(7,8000,undefined,1), /run|guest-originated/, 'a wrong-role fd0 read refuses, never enters its long poll');
  assert.equal(received.length,before,'the refusal is at the caller, before a host request or timeout');
}
// Every SUPERVISOR and globalOutbound binding a host hands a resident or a
// one-shot, on either substrate, carries the run it was opened for (a staged
// one-shot's: staged-one-shot-run). The no-run bindings a host mints (a
// peer's reads of a process's boot images) never reach a process.
const image = new TextEncoder().encode('export class NimbusProcess {}');
const reader = createCtxExports(() => image).SupervisorRPC;
const minted = [];
adoptCtxExports({ SupervisorRPC: (options) => { const binding = reader(options); minted.push(binding); return binding; } });
const runOf = (binding) => binding && ({ bindingKind: binding.props.bindingKind, writerId: binding.props.writerId, pid: binding.props.pid, doId: binding.props.doId });
const handedOnly = (handed) => minted.filter((binding) => binding.props.bindingKind !== 'process').every((binding) => !handed.includes(binding));
for (const mode of PROCESS_HOST_MODES) {
  minted.length = 0;
  const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; } }));
  const coordDoId = `roles-${mode}-coordinator`;
  const host = createProcessHost(mode, world, { readFile: () => image }, { coordDoId });
  const writerId = crypto.randomUUID();
  const boot = { kind: 'code', code: { compatibilityDate: '2026-09-26', compatibilityFlags: [], mainModule: 'worker.js', modules: { 'worker.js': 'export class NimbusProcess {}' } } };
  const hosted = await host.open({ pid: 11, writerId, workerKey: `roles-${mode}`, boot, startArgs: {} });
  try {
    await hosted.started;
    const { config } = world.boots.at(-1);
    assert.deepEqual(runOf(config.env.SUPERVISOR), { bindingKind: 'process', writerId, pid: 11, doId: coordDoId }, `${mode}: a resident's SUPERVISOR is its run, reaching its coordinator`);
    assert.ok(handedOnly([...Object.values(config.env), config.globalOutbound]), `${mode}: no no-run binding reaches the resident`);
  } finally {
    await hosted.release();
  }

  let loaded;
  const oneShotHost = createProcessHost(mode, createFacetWorld(() => ({})), { readFile: () => image }, {
    coordDoId,
    env: { ASSETS: missingAssets, LOADER: runnerLoader(`roles-${mode}`, { rewrite: (config) => (loaded = config) }) },
  });
  const oneShotRun = crypto.randomUUID();
  // The program answers with the props of the SUPERVISOR it was handed.
  const handed = await oneShotHost.runOnce({
    pid: 12, writerId: oneShotRun, outbound: true, onWriterActivated() {},
    request: new Request('http://run.local/', { method: 'POST' }),
    code: async () => ({ compatibilityDate: '2026-09-26', compatibilityFlags: [], mainModule: 'runner.js', modules: { 'runner.js': 'export default { fetch: (_request, env) => Response.json({ props: env.SUPERVISOR.props }) };' } }),
  }, (response) => response.json());
  const run = { bindingKind: 'process', writerId: oneShotRun, pid: 12, doId: coordDoId };
  assert.deepEqual(runOf(handed), run, `${mode}: a one-shot is handed its run`);
  assert.deepEqual(runOf(loaded.globalOutbound), run, `${mode}: and its network is its run's`);
}
console.log('supervisor-binding-roles: every process capability has a run; no-run infrastructure refuses guest ops');
