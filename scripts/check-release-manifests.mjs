#!/usr/bin/env bun
// Read release versions from manifests; exercise the scaffolder without installing or building.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../packages/cli/src/commands/scaffold.ts';
import { CLI_VERSION } from '../packages/cli/src/version.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifests = [];
for (const base of ['packages', 'apps']) {
  for (const entry of await readdir(join(root, base), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, base, entry.name, 'package.json');
    try { manifests.push(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
const versions = new Map(manifests.map((m) => [m.name, m.version]));
let edges = 0;
const check = (owner, name, range) => {
  if (!versions.has(name)) return;
  const version = versions.get(name);
  const constraint = range.startsWith('workspace:') ? range.slice('workspace:'.length) : range;
  assert.ok(['*', '^', '~'].includes(constraint) || Bun.semver.satisfies(version, constraint),
    `${owner}: ${name}@${range} excludes workspace ${version}`);
  edges++;
};
for (const manifest of manifests) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) check(`${manifest.name}.${field}`, name, range);
  }
}
assert.equal(CLI_VERSION, versions.get('@nimbus-sh/cli'), 'CLI --version must identify the release being packed');
const scratch = await mkdtemp(join(tmpdir(), 'nimbus-release-manifests-'));
try {
  const project = join(scratch, 'app');
  assert.equal(await scaffold([project]), 0);
  const generated = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  for (const name of ['@nimbus-sh/config', '@nimbus-sh/worker', '@nimbus-sh/sdk']) {
    assert.ok(generated.dependencies[name], `fresh bootstrap must install ${name}`);
    check('scaffold', name, generated.dependencies[name]);
  }
  console.log(`release-manifests: ${manifests.length} manifests, ${edges} compatible internal edges; fresh scaffold targets this release`);
} finally { await rm(scratch, { recursive: true, force: true }); }
