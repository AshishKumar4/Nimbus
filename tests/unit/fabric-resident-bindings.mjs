#!/usr/bin/env bun
// fabric-resident-bindings — a resident `code` boot with an explicit env
// must reach the loader exactly as the embedder minted it: outbound denied,
// loopback stubs by reference, CPU/subrequest bounds intact, and no
// SUPERVISOR injection. An omitted env keeps the old default (inherited
// network plus a minted SUPERVISOR binding).

import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import {
  facetImageDigest,
  facetImagePath,
  residentBootSpecSchema,
  ResidentCodeSpecSchema,
  residentLoaderConfig,
} from '../../packages/fabric/src/process-fabric.ts';
import { residentWorkerConfig } from '../../packages/fabric/src/workerd-facet-host.ts';
import {
  adoptCtxExports,
  composeFabric,
} from '../../packages/fabric/src/composition.ts';

// Loopback-stub stand-ins: identity is the assertion, so they are objects
// no serializer could round-trip, the way real entrypoint stubs are.
const FILES = { read: async (p) => `contents:${p}` };
const WORKSPACE = { read: async () => ({ jobs: [] }) };

const BASE = {
  compatibilityDate: '2025-12-01',
  compatibilityFlags: ['nodejs_compat'],
  mainModule: 'server.js',
  modules: { 'server.js': 'export class Gadget {}' },
};

const GADGET_SPEC = {
  ...BASE,
  env: { FILES, WORKSPACE },
  globalOutbound: null,
  limits: { cpuMs: 2_000, subRequests: 64 },
  capabilities: { snapshot: ['vfs-read'] },
};

const DISK = {
  readFile: (path) => {
    assert.match(path, /^\/var\/lib\/nimbus\/facet-images\//);
    return new TextEncoder().encode(`image-bytes:${path}`);
  },
};

const SUPERVISOR = { doId: 'coordinator-do-id', pid: 7, writerId: 'writer-1' };

// The boot-spec union carries the gadget triple through validation, or the
// gadget load cannot express its current production bounds.
{
  const schema = residentBootSpecSchema(z.unknown());
  const boot = schema.parse({ kind: 'code', code: GADGET_SPEC });
  assert.equal(boot.kind, 'code');
  assert.equal(boot.code.env.FILES, FILES);
  assert.equal(boot.code.env.WORKSPACE, WORKSPACE);
  assert.equal(boot.code.globalOutbound, null);
  assert.deepEqual(boot.code.limits, { cpuMs: 2_000, subRequests: 64 });
  assert.deepEqual(boot.code.capabilities, { snapshot: ['vfs-read'] });
}

// A bare spec still parses, with every isolation field absent.
{
  const parsed = ResidentCodeSpecSchema.parse(BASE);
  assert.equal(parsed.env, undefined);
  assert.equal(parsed.globalOutbound, undefined);
  assert.equal(parsed.limits, undefined);
  assert.equal(parsed.capabilities, undefined);
}

// The loader config denies outbound, keeps the exact stubs, and retains
// the bounds and capabilities beside the resolved module map.
{
  const source = 'export const snapshot = 1;';
  const digest = await facetImageDigest(source);
  const textPath = facetImagePath(digest);
  const wasmBytes = new TextEncoder().encode('wasm-image');
  const disk = {
    readFile: (path) => {
      if (path === textPath) return new TextEncoder().encode(source);
      if (path === '/img/runtime.wasm') return wasmBytes;
      throw new Error(`unexpected read: ${path}`);
    },
  };
  const config = await residentLoaderConfig(
    ResidentCodeSpecSchema.parse({
      ...GADGET_SPEC,
      vfsTextModules: { 'snapshot.js': textPath },
      vfsWasmModules: { 'runtime.wasm': '/img/runtime.wasm' },
    }),
    disk,
  );
  assert.equal(config.env.FILES, FILES);
  assert.equal(config.env.WORKSPACE, WORKSPACE);
  assert.equal(config.globalOutbound, null);
  assert.deepEqual(config.limits, { cpuMs: 2_000, subRequests: 64 });
  assert.deepEqual(config.capabilities, { snapshot: ['vfs-read'] });
  assert.equal(config.modules['server.js'], 'export class Gadget {}');
  assert.equal(config.modules['snapshot.js'], source);
  assert.ok(config.modules['runtime.wasm'] instanceof Object);
}

// Explicit env needs no supervisor composition at all: this runs before
// any composeFabric/adoptCtxExports, so resolving proves residentWorkerConfig
// never consults the supervisor entrypoint on this path.
{
  const config = await residentWorkerConfig(
    {},
    () => DISK,
    SUPERVISOR,
    { kind: 'code', code: ResidentCodeSpecSchema.parse(GADGET_SPEC) },
  );
  assert.equal(config.env.FILES, FILES);
  assert.equal(config.env.WORKSPACE, WORKSPACE);
  assert.equal('SUPERVISOR' in config.env, false);
  assert.equal(config.globalOutbound, null);
  assert.deepEqual(config.limits, { cpuMs: 2_000, subRequests: 64 });
}

// An explicitly empty env is still explicit: nothing is injected into it.
{
  const config = await residentWorkerConfig(
    {},
    () => DISK,
    SUPERVISOR,
    { kind: 'code', code: ResidentCodeSpecSchema.parse({ ...BASE, env: {} }) },
  );
  assert.deepEqual(config.env, {});
  assert.equal('SUPERVISOR' in config.env, false);
}

// The default (no env) still needs the supervisor entrypoint: without a
// composition this rejects instead of booting supervisor-less.
{
  await assert.rejects(
    residentWorkerConfig(
      {},
      () => DISK,
      SUPERVISOR,
      { kind: 'code', code: ResidentCodeSpecSchema.parse(BASE) },
    ),
    /unavailable/,
  );
}

// With a composition, the default keeps the old behavior: inherited network
// (no globalOutbound key) plus a SUPERVISOR minted for the coordinator.
{
  composeFabric({ supervisorEntrypoint: 'SupervisorRPC' });
  adoptCtxExports({
    SupervisorRPC: ({ props }) => ({ __supervisor: props }),
  });
  const config = await residentWorkerConfig(
    {},
    () => DISK,
    SUPERVISOR,
    { kind: 'code', code: ResidentCodeSpecSchema.parse(BASE) },
  );
  assert.deepEqual(config.env.SUPERVISOR, { __supervisor: SUPERVISOR });
  assert.equal('globalOutbound' in config, false);
  assert.equal(config.compatibilityDate, '2025-12-01');
  assert.equal(config.mainModule, 'server.js');
}

console.log('fabric-resident-bindings: ok');
