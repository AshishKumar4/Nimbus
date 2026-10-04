#!/usr/bin/env bun
// Before a release publishes anything: every package whose version is
// already on npm must pack to exactly what npm holds for that version.
//
// The publish skips a version npm already has. A package whose files
// changed without a version bump was therefore skipped while a dependent
// that needed the change went out: worker 0.13.0 imported
// recordSupervisorAnswer, which platform 0.7.0 on npm lacked, because
// platform's source gained it after 0.7.0 was published. This check refuses
// that state and names the package to bump.
//
// Usage: bun scripts/check-published.mjs   (exit 1 names each package to bump)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const REGISTRY = 'https://registry.npmjs.org';

/** The packages a release publishes: each runs the publish gate before npm packs it. */
async function releasePackages() {
  const found = [];
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, 'packages', entry.name);
    let manifest;
    try { manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (manifest.private || !manifest.scripts?.prepublishOnly?.includes('dist-integrity.mjs --publish')) continue;
    found.push({ dir, name: manifest.name, version: manifest.version });
  }
  return found;
}

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], timeout: 300_000 });

/** Every file of an unpacked tarball (its `package/` directory) as path → sha256. */
async function fileDigests(dir) {
  const digests = new Map();
  const walk = async (at) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else digests.set(relative(dir, path), createHash('sha256').update(await readFile(path)).digest('hex'));
    }
  };
  await walk(dir);
  return digests;
}

/** A tarball's files, the manifest compared as data (a packer may format it differently). */
async function unpack(tarball, into) {
  run('tar', ['-xzf', tarball, '-C', into], into);
  const dir = join(into, 'package');
  const digests = await fileDigests(dir);
  digests.set('package.json', JSON.stringify(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))));
  return digests;
}

const differences = (published, packed) => [...new Set([...published.keys(), ...packed.keys()])]
  .filter((path) => published.get(path) !== packed.get(path))
  .sort()
  .map((path) => (!published.has(path) ? `+ ${path}` : !packed.has(path) ? `- ${path}` : `~ ${path}`));

const work = await mkdtemp(join(tmpdir(), 'nimbus-check-published-'));
const stale = [];
try {
  for (const { dir, name, version } of await releasePackages()) {
    const answer = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}/${version}`);
    if (answer.status === 404) { console.log(`new       ${name}@${version}`); continue; }
    if (!answer.ok) throw new Error(`${name}@${version}: the registry answered ${answer.status}`);
    const { dist } = await answer.json();
    const published = join(work, `${name.replace('/', '__')}-published`);
    const packed = join(work, `${name.replace('/', '__')}-packed`);
    await mkdir(published); await mkdir(packed);
    const tarball = join(published, 'package.tgz');
    await Bun.write(tarball, await (await fetch(dist.tarball)).arrayBuffer());
    run('bun', ['pm', 'pack', '--destination', packed, '--quiet'], dir);
    const packedTarball = (await readdir(packed)).find((file) => file.endsWith('.tgz'));
    if (!packedTarball) throw new Error(`${name}: bun pm pack wrote no tarball to ${packed}`);
    const changed = differences(await unpack(tarball, published), await unpack(join(packed, packedTarball), packed));
    if (changed.length === 0) { console.log(`published ${name}@${version} (unchanged)`); continue; }
    stale.push(name);
    console.log(`CHANGED   ${name}@${version} differs from what npm holds for that version; bump its version:`);
    for (const line of changed.slice(0, 20)) console.log(`            ${line}`);
    if (changed.length > 20) console.log(`            ... and ${changed.length - 20} more`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
if (stale.length > 0) {
  console.error(`\nrefusing: ${stale.join(', ')} changed since their version was published. Bump each, move the ranges that need the change, then publish.`);
  process.exit(1);
}
console.log('\nevery package npm already holds packs to what it holds');
