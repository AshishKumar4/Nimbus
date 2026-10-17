#!/usr/bin/env node
/**
 * check-runtime-packages.mjs — the `prepublishOnly` gate of core, the worker
 * and the CLI.
 *
 * A core release names runner keys (BASH_RUNNER and friends), and a runtime
 * package on npm names the runner it was built for. The worker's runtime specs
 * and the CLI's `nimbus runtime sync` publish a runtime Nimbus builds from its
 * npm package, at the spec's version, so they need it there too. core 0.11.0 shipped
 * `bash-runner@2` while npm still served the `bash-runner` build, and every
 * embedder's `bash` became "command not found". So core does not publish
 * until, for every runtime spec with an `npm` entry
 * (packages/worker/scripts/runtime-specs.mjs):
 *
 *   - the package this tree builds (`bundle-runtime.mjs --npm-package`, the
 *     real path) is on the registry at its version, with the same
 *     manifest.json bytes;
 *   - `dist-tags.latest` is that version: `5.2.37-2` sorts below `5.2.37`,
 *     and a range that admits one build admits the other, so a consumer gets
 *     the new build only because `latest` points at it;
 *   - the built package installs through the core being published, whose
 *     create refuses a package naming a runner it does not provide.
 *
 * Each failure prints the command that fixes it; the exit status is non-zero.
 * Run under node, `@nimbus-sh/core` resolves to dist — what the tarball
 * ships, which `prepublishOnly` first proves is the committed fixpoint of src
 * with scripts/dist-integrity.mjs. Under bun (the unit test) it resolves to src.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readableStreamToAsyncIterable, streamPackageEntries } from '@nimbus-sh/core/_shared/tarball-stream.js';

const WORKER = fileURLToPath(new URL('../../worker/', import.meta.url));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const publishCommand = (dir) =>
  `cd ${dir} && npm publish --tag latest --access public --auth-type=web`;

/**
 * The verdict on one runtime package. `registry.packument(name)` answers the
 * registry document or null for an unknown package;
 * `registry.manifestSha256(versionRecord)` the sha256 of `package/manifest.json`
 * in that version's tarball. `runThroughCore(dir)` throws when the core
 * refuses the package. Returns the problems, each with its fix.
 */
export async function checkRuntimePackage({ name, version, dir, registry, runThroughCore, tarball }) {
  const problems = [];
  const built = sha256(readFileSync(join(dir, 'manifest.json')));
  const archive = tarball ? await unpackRuntime(tarball) : null;

  try {
    try {
      await runThroughCore(archive?.dir ?? dir);
    } catch (error) {
      problems.push({
        problem: `the core being published refuses it: ${error instanceof Error ? error.message : error}`,
        fix: 'no publish fixes this: rebuild the runtime for this core\'s runner contract '
          + '(a new build number in packages/worker/scripts/runtime-specs.mjs), or do not ship the runner change',
      });
    }
    if (archive) {
      // Packing validates the actual artifact; signing confirms these same bytes as latest before core is signed.
      const pkg = JSON.parse(readFileSync(join(archive.dir, 'package.json'), 'utf8'));
      if (pkg.name !== name || pkg.version !== version) problems.push({ problem: `${tarball} is not ${name}@${version}`, fix: 'pack the runtime built by this commit' });
      const packed = sha256(readFileSync(join(archive.dir, 'manifest.json')));
      if (packed !== built) problems.push({ problem: `${tarball} carries manifest.json sha256 ${packed}; this tree builds ${built}`, fix: 'pack the runtime built by this commit' });
      return problems;
    }

    const packument = await registry.packument(name);
    const record = packument?.versions?.[version];
    if (!record) {
      problems.push({ problem: `${name}@${version} is not on the registry`, fix: publishCommand(dir) });
      return problems;
    }
    const published = await registry.manifestSha256(record);
    if (published !== built) {
      problems.push({
        problem: `${name}@${version} on the registry carries manifest.json sha256 ${published}; `
          + `this tree builds ${built}`,
        fix: 'a published version cannot be replaced: give the spec a new build number in '
          + 'packages/worker/scripts/runtime-specs.mjs, then rerun this check for the publish command',
      });
      return problems;
    }
    const latest = packument['dist-tags']?.latest;
    if (latest !== version) {
      problems.push({ problem: `dist-tags.latest of ${name} is ${latest ?? '(unset)'}, not ${version}`, fix: `npm dist-tag add ${name}@${version} latest --auth-type=web` });
    }
    return problems;
  } finally {
    if (archive) rmSync(archive.dir, { recursive: true, force: true });
  }
}

async function unpackRuntime(tarball) {
  const dir = mkdtempSync(join(tmpdir(), 'nimbus-runtime-tarball-'));
  try {
    const tar = async function* () {
      for await (const chunk of createReadStream(tarball).pipe(createGunzip())) yield new Uint8Array(chunk);
    };
    for await (const entry of streamPackageEntries(tar())) {
      const path = join(dir, entry.name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, entry.data);
    }
    return { dir };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** The public registry, read-only. */
export function npmRegistry(base = 'https://registry.npmjs.org') {
  return {
    async packument(name) {
      // The abbreviated document: versions with their dist, and dist-tags.
      const response = await fetch(`${base}/${name.replace('/', '%2f')}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GET ${name}: HTTP ${response.status}`);
      return response.json();
    },
    async manifestSha256(record) {
      const response = await fetch(record.dist.tarball);
      if (!response.ok) throw new Error(`GET ${record.dist.tarball}: HTTP ${response.status}`);
      const tar = response.body.pipeThrough(new DecompressionStream('gzip'));
      for await (const entry of streamPackageEntries(readableStreamToAsyncIterable(tar))) {
        if (entry.name === 'manifest.json') return sha256(entry.data);
      }
      throw new Error(`${record.dist.tarball} carries no manifest.json`);
    },
  };
}

/** Install the package at `dir` through the core `@nimbus-sh/core` resolves to. */
export async function runThroughCore(dir) {
  const { ISOLATE_NETWORK, NimbusWorkspace, localFacetHost } = await import('@nimbus-sh/core');
  const { DatabaseSync } = await import('node:sqlite');
  const { default: runtimePackage } = await import(pathToFileURL(join(dir, 'index.js')).href);
  const db = new DatabaseSync(':memory:');
  const transactions = {
    storage: {
      transactionSync(callback) {
        db.exec('BEGIN');
        try {
          const result = callback();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
  };
  try {
    const workspace = await NimbusWorkspace.create({
      sql: { exec: (query, ...bindings) => db.prepare(query).all(.../** @type {import('node:sqlite').SQLInputValue[]} */ (bindings)) },
      transactions,
      generation: 1,
      facets: localFacetHost(ISOLATE_NETWORK),
      runtimes: [runtimePackage],
    });
    await workspace.close();
  } finally {
    db.close();
  }
}

/**
 * The verdict on every runtime package of `specs` (npmRuntimeSpecs): each
 * built into a directory under `root` by `build(spec, dir)` (an error's
 * text when it fails) and checked (checkRuntimePackage). `prepared`: a
 * runtime the caller built already, at `dir`, and packed into `tarball`
 * (publish-pack's signing artifact): its directory is that build, and the
 * tarball is what is checked, its manifest against the directory's.
 */
export async function checkRuntimePackages({ specs, registry, root, build, prepared }) {
  const verdicts = [];
  for (const spec of specs) {
    const { runtime, version, name, npmVersion } = spec;
    const own = prepared?.runtime === runtime ? prepared : null;
    const dir = own?.dir ?? join(root, name.split('/').pop());
    const failure = own ? null : build(spec, dir);
    const problems = failure === null
      ? await checkRuntimePackage({ name, version: npmVersion, dir, registry, runThroughCore, tarball: own?.tarball })
      : [{ problem: `building it failed:\n${failure}`, fix: `cd ${WORKER} && node ${buildArgs(runtime, version, dir).join(' ')}` }];
    verdicts.push({ name, npmVersion, dir, prepared: own !== null, problems });
  }
  return verdicts;
}

const buildArgs = (runtime, version, dir) => ['scripts/bundle-runtime.mjs', runtime, version, '--npm-package', dir];

/** `bundle-runtime.mjs --npm-package` of `spec` into `dir`: null, or what it printed when it failed. */
function buildRuntimePackage({ runtime, version }, dir) {
  const run = spawnSync('node', buildArgs(runtime, version, dir), { cwd: WORKER, encoding: 'utf8', maxBuffer: 1 << 26 });
  return run.status === 0 ? null : `${run.stdout}${run.stderr}`;
}

async function main() {
  const args = process.argv.slice(2);
  const usage = 'usage: check-runtime-packages.mjs [--runtime-tarball <CPython tgz> --runtime-dir <its package directory>]';
  if (args.length !== 0 && (args.length !== 4 || args[0] !== '--runtime-tarball' || args[2] !== '--runtime-dir')) throw new Error(usage);
  const prepared = args.length === 0 ? undefined : { runtime: 'cpython', tarball: args[1], dir: args[3] };
  const { npmRuntimeSpecs } = await import('../../worker/scripts/runtime-specs.mjs');
  const root = mkdtempSync(join(tmpdir(), 'nimbus-runtime-release-'));
  // A check that throws is a failure too: say where its packages were kept, as a FAIL does.
  process.once('exit', (code) => {
    if (code && existsSync(root)) console.error(`Built packages kept under ${root}.`);
  });
  const verdicts = await checkRuntimePackages({ specs: npmRuntimeSpecs(), registry: npmRegistry(), root, build: buildRuntimePackage, prepared });
  let failed = 0;
  for (const { name, npmVersion, dir, prepared: theirs, problems } of verdicts) {
    if (problems.length === 0) {
      console.log(`ok    ${name}@${npmVersion}`);
      // The caller's build is the caller's to remove.
      if (!theirs) rmSync(dir, { recursive: true, force: true });
      continue;
    }
    failed++;
    console.error(`FAIL  ${name}@${npmVersion}`);
    for (const { problem, fix } of problems) {
      console.error(`      ${problem}`);
      console.error(`      fix: ${fix}`);
    }
  }
  if (failed === 0) {
    rmSync(root, { recursive: true, force: true });
    return;
  }
  console.error(`\n${failed} runtime package(s) not released; core must not publish ahead of them.`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
