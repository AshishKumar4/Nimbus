#!/usr/bin/env bun
// A host Worker's isolates all evaluate, at startup, every module its
// re-exported RPC classes link statically (Kinu ask 56). Bundled as a Worker
// bundles them, with what loads at first use split into chunks of its own:
//
//   1. SupervisorRPC's static closure holds no part of the npm engine (core's
//      npm command, _shared/npm-*, semver) nor the npm cache client;
//   2. the session's RPC module's holds no opencode artifact staging;
//   3. the npm cache still works through SupervisorRPC: a tarball it stores
//      at its first use it reads back, verified, from the same bucket.
//
// Red before: supervisor-calls.ts linked npm/r2-cache.ts, and through it the
// npm engine; rpc.ts linked opencode-staging.ts, and the artifacts.

import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { packageTarball, sriOf } from './lib/tarball-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The inputs `entry` links statically, and their bundled bytes: its bundle
 * and the chunks it imports by statement, never those it loads with import().
 */
async function staticClosure(entry) {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'nimbus-startup-closure-'));
  try {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true, splitting: true, format: 'esm', platform: 'browser', outdir: scratch, metafile: true, logLevel: 'silent',
      conditions: ['workerd', 'worker', 'browser'],
      // The platform's own modules, and Node's under nodejs_compat, bare names too.
      external: ['cloudflare:*', 'node:*', ...builtinModules],
    });
    const outputs = result.metafile.outputs;
    const entryOutput = Object.keys(outputs).find((path) => outputs[path].entryPoint === entry);
    const reached = new Set();
    const visit = (path) => {
      if (reached.has(path) || outputs[path] === undefined) return;
      reached.add(path);
      for (const edge of outputs[path].imports) if (edge.kind === 'import-statement') visit(edge.path);
    };
    visit(entryOutput);
    return {
      inputs: [...reached].flatMap((path) => Object.keys(outputs[path].inputs)),
      bytes: [...reached].reduce((sum, path) => sum + outputs[path].bytes, 0),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ── 1. SupervisorRPC links no part of the npm engine ───────────────────────
{
  const { inputs, bytes } = await staticClosure('packages/worker/src/session/supervisor-rpc.ts');
  console.log(`  SupervisorRPC's static closure: ${inputs.length} modules, ${(bytes / 1024).toFixed(0)} KiB bundled`);
  assert.ok(inputs.some((input) => input.endsWith('session/supervisor-calls.ts')), 'the closure is SupervisorRPC\'s');
  const engine = inputs.filter((input) => /_shared\/npm-|commands\/system\/npm\.|npm\/r2-cache\.|node_modules\/semver\//.test(input));
  assert.deepEqual(engine, [], 'SupervisorRPC links no part of the npm engine, nor the npm cache client');
  console.log('  [1] none of them the npm engine');
}

// ── 2. the session's RPC module links no opencode artifact staging ─────────
{
  const { inputs, bytes } = await staticClosure('packages/worker/src/session/rpc.ts');
  console.log(`  the session RPC module's static closure: ${inputs.length} modules, ${(bytes / 1024).toFixed(0)} KiB bundled`);
  assert.ok(inputs.some((input) => input.endsWith('facets/opencode-stage-spec.ts')), 'it validates the stage it is handed');
  const staging = inputs.filter((input) => /facets\/opencode-staging\.|opencode-artifact|opentui-wasm/.test(input));
  assert.deepEqual(staging, [], 'and links none of the artifacts that build one');
  console.log('  [2] none of them opencode staging');
}

// ── 3. the npm cache loads at its first use, and works ─────────────────────
{
  const store = new Map();
  const bucket = {
    async get(key) {
      const value = store.get(key);
      return value ? { arrayBuffer: async () => value.slice().buffer } : null;
    },
    async put(key, body) { store.set(key, new Uint8Array(body)); },
    async delete(key) { store.delete(key); },
  };
  mock.module('cloudflare:workers', () => ({
    WorkerEntrypoint: class {
      constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    },
  }));
  const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
  // A binding no run acts through: its cache calls ask the session nothing.
  const rpc = new SupervisorRPC({ props: { doId: 'session', pid: 0, bindingKind: 'infrastructure' } }, { NPM_TARBALL_CACHE: bucket });
  const tarball = packageTarball({ 'package/package.json': '{"name":"first-use","version":"1.0.0"}' });
  const integrity = await sriOf(tarball);
  assert.equal(await rpc.putCachedTarball(integrity, tarball), true, 'the first cache call stores the tarball');
  assert.equal(store.size, 1);
  const { bytes } = await rpc.getCachedTarball(integrity);
  assert.deepEqual(bytes, tarball, 'and reads it back, verified, from the same bucket');
  console.log('  [3] the npm cache, loaded at its first use, stores and reads a tarball through SupervisorRPC');
}

console.log('supervisor-rpc-startup-closure: SupervisorRPC and the session RPC link neither the npm engine nor opencode staging');
