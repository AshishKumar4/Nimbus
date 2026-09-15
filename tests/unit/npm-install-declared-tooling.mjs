#!/usr/bin/env bun
// npm-install-declared-tooling — what a project declares gets installed.
//
// SKIP_PACKAGES used to name build tools (typescript, eslint, prettier,
// postcss, tailwindcss, husky, @types/* …) and buildSpecs filtered the
// project's OWN package.json through it: `git clone <ts project> && npm
// install` reported Done! with no node_modules/.bin/tsc, no @types, no
// eslint. None of those can't run here — they are JavaScript. The list is
// empty now; what truly cannot run (node-pty, sharp, canvas) is a REJECT
// with a stated reason: a declared one is left out with that reason on
// the log and the rest installs, an explicit `npm install sharp` still
// fails with it. The retired 'warn' toolchain entries — wrangler,
// @cloudflare/vite-plugin, parcel, node-gyp — are plain JS and install
// like anything else.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { PACKAGE_ABI_POLICY, lookupReject } from '../../packages/worker/src/facets/wasm-swap-registry.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;

function resolvedResult(name, version, overrides = {}) {
  return {
    pkg: {
      name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: 'sha512-fixture',
      dependencies: {}, exports: null, main: 'index.js', module: '', bin: {}, ...overrides,
    },
    deps: {}, peerDeps: {}, optionalDeps: {}, allPeerDependencies: {},
    cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
  };
}

function makeInstaller(pkgJson, resultFor) {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(NM, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify(pkgJson));
  const log = [];
  const shardsSeen = [];
  const env = {
    LOADER: { get() { return {}; } },
    NIMBUS_SESSION: {
      idFromName(name) { return { toString: () => name, name }; },
      get() {
        return {
          async _rpcFanoutExecute(_fnSource, args) {
            if (args[0] && Array.isArray(args[0].packages)) {
              // The install shard: write each package's package.json so the
              // tree is real for the on-disk assertions below.
              return { results: args.map((shard) => {
                shardsSeen.push(...shard.packages.map((p) => p.name));
                for (const p of shard.packages) {
                  root.mkdir(`${NM}/${p.name}`, { recursive: true });
                  root.writeFile(`${NM}/${p.name}/package.json`, JSON.stringify({ name: p.name, version: p.version }));
                }
                return {
                  perPackage: shard.packages.map((p) => ({ name: p.name, version: p.version, fileCount: 1, bytesWritten: 40, elapsed: 1, warnings: [] })),
                  elapsed: 1,
                  facetCounters: { tarballsCompleted: 0, cumulativeBytesDecoded: 0, peakInFlight: 1, pipelinedTarballRaceWins: 0, pipelinedTarballRaceLosses: 0 },
                  cacheStatEvents: [],
                };
              }) };
            }
            return { results: args.map((spec) => resultFor(spec.name)) };
          },
        };
      },
    },
  };
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = new NpmInstaller(vfs, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });
  return { installer, log, root, shardsSeen };
}

// ── the policy itself ───────────────────────────────────────────────────────
{
  assert.deepEqual(PACKAGE_ABI_POLICY.skipPackages, [], 'nothing is silently skipped');
  assert.deepEqual(PACKAGE_ABI_POLICY.skipPrefixes, []);
  assert.ok(
    !PACKAGE_ABI_POLICY.rejects.some((r) => r.transitive === 'warn'),
    'no warn-transitive entries remain',
  );
  for (const name of ['wrangler', '@cloudflare/vite-plugin', 'parcel', 'node-gyp', 'node-pre-gyp']) {
    assert.equal(lookupReject(name), undefined, `${name} has no reject entry`);
  }
  console.log('  policy: empty skip list, no warn rejects');
}

// ── a cloned TypeScript project installs its tooling ────────────────────────
//
// `wrangler` is a declared devDependency the policy no longer refuses:
// it is plain JS, so it installs with the rest and lands on disk.
// Nothing the project declares is silently left out.
{
  const { installer, log, root, shardsSeen } = makeInstaller(
    {
      // Six names so the resolve layer takes the peer-DO topology the
      // harness fakes (width >= IN_DO_THRESHOLD), the path a real clone hits.
      name: 'cloned', dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      devDependencies: { typescript: '^5.4.0', '@types/node': '^22.0.0', eslint: '^9.0.0', prettier: '^3.0.0', wrangler: '^4.0.0' },
    },
    (name) => resolvedResult(name, '1.0.0', name === 'typescript' ? { bin: { tsc: 'bin/tsc', tsserver: 'bin/tsserver' } } : {}),
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');
  for (const name of ['react', 'react-dom', 'typescript', '@types/node', 'eslint', 'prettier', 'wrangler']) {
    assert.ok(result.installed.some((entry) => entry.startsWith(`${name}@`)), `${name} installed (installed=${JSON.stringify(result.installed)})`);
    assert.ok(root.exists(`${NM}/${name}/package.json`), `${name} is on disk`);
  }
  assert.ok(root.exists(`${NM}/.bin/tsc`), 'node_modules/.bin/tsc exists');
  assert.equal(result.failed.length, 0, `nothing failed (failed=${JSON.stringify(result.failed)})`);
  assert.ok(shardsSeen.includes('wrangler'), 'wrangler was dispatched like any package');
  console.log('  declared typescript/@types/eslint/wrangler all install');
}

// ── an explicit request for a refused package fails without aborting ──────
//
// G2: even `npm install sharp` installs what it can (nothing else was
// asked for here) and reports the refusal as a failed package with the
// per-package `[skip]` line — never as an install-level throw. The shell
// maps the non-empty `failed` list to exit 1.
{
  const { installer, log } = makeInstaller({ name: 'x', dependencies: { a: '1', b: '1', c: '1', d: '1', e: '1', f: '1' } }, (name) => resolvedResult(name, '1.0.0'));
  const result = await installer.install(PROJ, { packages: ['sharp'] });
  const output = log.join('\n');
  assert.ok(result.failed.includes('sharp'), `the refusal lands in failed (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*sharp — /.test(output), `the log carries the skip line:\n${output}`);
  assert.ok(/1 required package is not supported on Nimbus: sharp/.test(output), `the closing summary names it:\n${output}`);
  assert.ok(!/\bDone!/.test(output), `no success line on a refused install:\n${output}`);
  console.log('  an explicit npm install sharp fails with the reason, nothing aborts');
}


console.log('npm-install-declared-tooling: ok');
