#!/usr/bin/env node
/**
 * check-runtime-packages.mjs — core's `prepublishOnly` gate.
 *
 * A core release names runner keys (BASH_RUNNER and friends), and a runtime
 * package on npm names the runner it was built for. core 0.11.0 shipped
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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
export async function checkRuntimePackage({ name, version, dir, registry, runThroughCore }) {
  const problems = [];
  const built = sha256(readFileSync(join(dir, 'manifest.json')));

  try {
    await runThroughCore(dir);
  } catch (error) {
    problems.push({
      problem: `the core being published refuses it: ${error instanceof Error ? error.message : error}`,
      fix: 'no publish fixes this: rebuild the runtime for this core\'s runner contract '
        + '(a new build number in packages/worker/scripts/runtime-specs.mjs), or do not ship the runner change',
    });
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
    problems.push({
      problem: `dist-tags.latest of ${name} is ${latest ?? '(unset)'}, not ${version}`,
      fix: `npm dist-tag add ${name}@${version} latest --auth-type=web`,
    });
  }
  return problems;
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
  const { NimbusWorkspace, localFacetHost } = await import('@nimbus-sh/core');
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
      sql: { exec: (query, ...bindings) => db.prepare(query).all(...bindings) },
      transactions,
      generation: 1,
      facets: localFacetHost(),
      runtimes: [runtimePackage],
    });
    await workspace.close();
  } finally {
    db.close();
  }
}

async function main() {
  const { npmRuntimeSpecs } = await import('../../worker/scripts/runtime-specs.mjs');
  const registry = npmRegistry();
  const root = mkdtempSync(join(tmpdir(), 'nimbus-runtime-release-'));
  let failed = 0;
  for (const { runtime, version, name, npmVersion } of npmRuntimeSpecs()) {
    const dir = join(root, name.split('/').pop());
    const args = ['scripts/bundle-runtime.mjs', runtime, version, '--npm-package', dir];
    const build = spawnSync('node', args, { cwd: WORKER, encoding: 'utf8', maxBuffer: 1 << 26 });
    const problems = build.status === 0
      ? await checkRuntimePackage({ name, version: npmVersion, dir, registry, runThroughCore })
      : [{
        problem: `building it failed:\n${build.stdout}${build.stderr}`,
        fix: `cd ${WORKER} && node ${args.join(' ')}`,
      }];
    if (problems.length === 0) {
      console.log(`ok    ${name}@${npmVersion}`);
      rmSync(dir, { recursive: true, force: true });
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
  console.error(`Built packages kept under ${root}.`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
