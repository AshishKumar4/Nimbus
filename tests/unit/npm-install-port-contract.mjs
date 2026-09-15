#!/usr/bin/env bun
//
// The `npm install` command contract after the port refactor: core owns the
// parse, the pre-checks, the prefix derivation, and the summary text; the
// host owns the install engine behind a spec-shaped port.
//
// What this pins:
//   - pre-checks fire before any install work (missing package.json, -g
//     without a name) and the text matches what the worker's wrapper
//     printed;
//   - the port receives the invocation as a spec: projectDir, packages,
//     global, globalBinDir derived from --prefix/npm_config_prefix, and a
//     per-invocation onProgress channel;
//   - the summary lines come from the command, not the port;
//   - onProgress lines route to this invocation's stdout — no cross-talk
//     through a shared installer.

import assert from 'node:assert/strict';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const vfs = ws.vfs.as(CRED_KERNEL);

// Fake port: records the spec, emits two progress lines, returns a result.
const calls = [];
ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel, {
  installer: {
    async install(spec) {
      calls.push(spec);
      spec.onProgress?.('Resolving 1 dependency');
      spec.onProgress?.('Fetching example');
      return { installed: ['example'], failed: [], totalFiles: 4, fromCacheHits: 1 };
    },
  },
}));

// ── Local install spec ──────────────────────────────────────────────────
await ws.exec('mkdir -p /proj');
await ws.exec('sh -c \'echo "{\\"name\\":\\"p\\",\\"dependencies\\":{}}" > /proj/package.json\'');
{
  const r = await ws.exec('cd /proj && npm install example');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(calls.at(-1).projectDir, '/proj');
  assert.deepEqual(calls.at(-1).packages, ['example']);
  assert.equal(calls.at(-1).global, false);
  assert.equal(calls.at(-1).globalBinDir, undefined);
  assert.match(r.stdout, /\[npm\] Resolving 1 dependency/);
  assert.match(r.stdout, /\[npm\] Fetching example/);
  assert.match(r.stdout, /added 1 packages \(4 files\) in \d+\.\ds/);
  assert.match(r.stdout, /\(1 from cache\)/);
}

await ws.exec('mkdir -p /nopkg');
{
  const before = calls.length;
  const r = await ws.exec('cd /nopkg && npm install');
  assert.equal(r.exitCode, 1);
  assert.equal(calls.length, before, 'pre-check must not reach the port');
  assert.match(r.stderr, /npm ERR! no package\.json found/);
}

// ── Global install: --prefix is honoured in the spec ────────────────────
{
  const r = await ws.exec('cd /proj && npm install -g example --prefix /custom');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(calls.at(-1).global, true);
  assert.equal(calls.at(-1).globalBinDir, '/custom/bin');
}

// npm_config_prefix is the fallback when --prefix is absent.
{
  const r = await ws.exec('cd /proj && npm_config_prefix=/envpfx npm install -g example');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(calls.at(-1).globalBinDir, '/envpfx/bin');
}

// Default prefix.
{
  const r = await ws.exec('cd /proj && npm install -g example');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(calls.at(-1).globalBinDir, '/usr/local/bin');
}

// ── Global install with no name: worker's exact error text ──────────────
{
  const before = calls.length;
  const r = await ws.exec('cd /proj && npm install -g');
  assert.equal(r.exitCode, 1);
  assert.equal(calls.length, before);
  assert.match(r.stderr, /npm ERR! missing package name for global install/);
}

// ── Failed install: red Failed line, yellow summary, exit 1 ─────────────
ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel, {
  installer: {
    async install() {
      return { installed: ['example'], failed: ['example'], totalFiles: 2, linkedBins: 1 };
    },
  },
}));
{
  const r = await ws.exec('cd /proj && npm install -g example');
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /Failed: example/);
  assert.match(r.stdout, /added 1 packages \(2 files\) in \d+\.\ds \(1 failed, see above\)/);
  assert.match(r.stdout, /linked 1 bin into \/usr\/local\/bin/);
}

// ── --loglevel routes npm-protocol lines to stderr ──────────────────────
{
  let sawLog;
  ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel, {
    installer: {
      async install(spec) {
        sawLog = spec.npmLog;
        spec.npmLog?.('http', 'npm http fetch GET https://registry.npmjs.org/example 42ms');
        return { installed: ['example'], failed: [], totalFiles: 1 };
      },
    },
  }));
  const r = await ws.exec('cd /proj && npm install --loglevel=http example');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(typeof sawLog, 'function', 'npmLog is handed to the port');
  assert.match(r.stderr, /npm http fetch GET/);
}

console.log('npm-install-port-contract: ok');
harness.db.close();
