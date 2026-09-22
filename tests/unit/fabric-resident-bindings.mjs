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

// A wasm member is handed to the loader as the read's OWN buffer when the
// read fits it exactly, and copied only when the read is a view into a
// larger one. These are the largest members a spec carries (ruby's 34.3 MiB
// interpreter, esbuild's 13.3 MiB image); an unconditional slice held both
// copies at once in the coordinator's 128 MiB isolate, at the one moment the
// module map is also resident.
{
  const exact = new Uint8Array(new ArrayBuffer(16)).fill(7);
  const backing = new Uint8Array(64);
  for (let i = 0; i < backing.length; i++) backing[i] = i;
  const view = backing.subarray(8, 24);
  const disk = {
    readFile: (path) => {
      if (path === '/img/exact.wasm') return exact;
      if (path === '/img/view.wasm') return view;
      throw new Error(`unexpected read: ${path}`);
    },
  };
  const config = await residentLoaderConfig(
    ResidentCodeSpecSchema.parse({
      ...BASE,
      vfsWasmModules: { 'exact.wasm': '/img/exact.wasm', 'view.wasm': '/img/view.wasm' },
    }),
    disk,
  );
  assert.equal(config.modules['exact.wasm'].wasm, exact.buffer,
    'an exact-fit read is passed through as its own buffer, not copied');
  const copied = config.modules['view.wasm'].wasm;
  assert.notEqual(copied, backing.buffer, 'a view into a larger buffer must not leak the whole buffer');
  assert.equal(copied.byteLength, 16);
  assert.deepEqual([...new Uint8Array(copied)], [...view], 'the copy carries exactly the viewed bytes');
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

// An outbound binding is a capability, so validation must not clone it.
{
  const outbound = { fetch: async () => new Response('mediated') };
  for (const value of [null, outbound]) {
    const boot = residentBootSpecSchema(z.unknown()).parse({
      kind: 'code', code: { ...BOUND_SPEC, globalOutbound: value },
    });
    assert.equal(boot.code.globalOutbound, value);
    const config = await residentWorkerConfig({}, () => DISK, SUPERVISOR, boot);
    assert.equal(config.globalOutbound, value);
    assert.equal('SUPERVISOR' in config.env, false);
    if (value !== null) assert.equal(await (await config.globalOutbound.fetch('https://test/')).text(), 'mediated');
  }
  for (const invalid of [false, 'inherit', 1, {}, { fetch: 'not callable' }]) {
    assert.equal(ResidentCodeSpecSchema.safeParse({ ...BASE, globalOutbound: invalid }).success, false);
  }
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

// Default supervisor injection must retain an independently selected outbound policy.
{
  const config = await residentWorkerConfig({}, () => DISK, SUPERVISOR, {
    kind: 'code', code: ResidentCodeSpecSchema.parse({ ...BASE, globalOutbound: null }),
  });
  assert.equal(config.globalOutbound, null);
  assert.deepEqual(config.env.SUPERVISOR, { __supervisor: SUPERVISOR });
}

console.log('fabric-resident-bindings: ok');
