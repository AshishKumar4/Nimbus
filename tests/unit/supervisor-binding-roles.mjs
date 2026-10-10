#!/usr/bin/env bun
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock } from 'bun:test';
import { supervisorBindingProps, mintProcessSupervisor } from '../../packages/fabric/src/supervisor-props.ts';
mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } }));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
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
const allCapabilities = [];
for (const processKind of ['one-shot', 'resident', 'peer', 'globalOutbound']) {
  mintProcessSupervisor(({ props }) => { allCapabilities.push({ processKind, props }); return {}; }, props);
}
assert.ok(allCapabilities.every((cap) => cap.props.bindingKind === 'process' && cap.props.writerId === 'one-run'));
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
// All SUPERVISOR and globalOutbound capabilities of resident/one-shot
// processes use the checked mint; the infrastructure constructor stays local.
const hostSource = readFileSync(new URL('../../packages/fabric/src/workerd-facet-host.ts', import.meta.url), 'utf8');
assert.equal((hostSource.match(/mintProcessSupervisor\(supervisorRpc, supervisor\)/g) || []).length, 2);
assert.doesNotMatch(hostSource, /supervisorRpc\(\{ props/);
const poolSource = readFileSync(new URL('../../packages/fabric/src/isolate-pool.ts', import.meta.url), 'utf8');
assert.match(poolSource, /function infrastructureSupervisorProps/);
assert.doesNotMatch(poolSource, /export function infrastructureSupervisorProps/);
console.log('supervisor-binding-roles: every process capability has a run; no-run infrastructure refuses guest ops');
