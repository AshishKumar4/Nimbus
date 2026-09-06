#!/usr/bin/env bun
// fabric-resident-bindings — a resident `code` boot with an explicit env
// must reach the loader exactly as the embedder minted it: loopback stubs by
// reference and no SUPERVISOR injection. An omitted env keeps the default
// (inherited network plus a minted SUPERVISOR binding).

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
  mainModule: 'app.js',
  modules: { 'app.js': 'export class App {}' },
};

const BOUND_SPEC = {
  ...BASE,
  env: { FILES, WORKSPACE },
};

const DISK = {
  readFile: (path) => {
    assert.match(path, /^\/var\/lib\/nimbus\/facet-images\//);
    return new TextEncoder().encode(`image-bytes:${path}`);
  },
};

const SUPERVISOR = { doId: 'coordinator-do-id', pid: 7, writerId: 'writer-1' };

// The boot-spec union carries an explicit env through validation by
// reference, or an embedder cannot hand an isolate the stubs it minted.
{
  const schema = residentBootSpecSchema(z.unknown());
  const boot = schema.parse({ kind: 'code', code: BOUND_SPEC });
  assert.equal(boot.kind, 'code');
  assert.equal(boot.code.env.FILES, FILES);
  assert.equal(boot.code.env.WORKSPACE, WORKSPACE);
}

// A bare spec still parses, with the env absent.
{
  const parsed = ResidentCodeSpecSchema.parse(BASE);
  assert.equal(parsed.env, undefined);
}

// The loader config keeps the exact stubs beside the resolved module map.
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
      ...BOUND_SPEC,
      vfsTextModules: { 'snapshot.js': textPath },
      vfsWasmModules: { 'runtime.wasm': '/img/runtime.wasm' },
    }),
    disk,
  );
  assert.equal(config.env.FILES, FILES);
  assert.equal(config.env.WORKSPACE, WORKSPACE);
  assert.equal('globalOutbound' in config, false);
  assert.equal(config.modules['app.js'], 'export class App {}');
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
    { kind: 'code', code: ResidentCodeSpecSchema.parse(BOUND_SPEC) },
  );
  assert.equal(config.env.FILES, FILES);
  assert.equal(config.env.WORKSPACE, WORKSPACE);
  assert.equal('SUPERVISOR' in config.env, false);
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
  assert.equal(config.mainModule, 'app.js');
}

console.log('fabric-resident-bindings: ok');
