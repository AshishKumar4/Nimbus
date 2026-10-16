// A RubyGems API, served to a workspace's network in-process, and a gem home
// to install into.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { ISOLATE_NETWORK } from '../../../packages/core/src/_shared/workspace-network.ts';
import { NimbusWorkspace } from '../../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

/** A .gem archive holding `files` (path → text) as its data. */
async function gemArchive(files) {
  const dir = await mkdtemp(join(tmpdir(), 'nimbus-gem-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(dir, 'data', path, '..'), { recursive: true });
      await writeFile(join(dir, 'data', path), text);
    }
    for (const argv of [['tar', '-czf', 'data.tar.gz', '-C', 'data', 'lib'], ['tar', '-cf', 'out.gem', 'data.tar.gz']]) {
      assert.equal(Bun.spawnSync(argv, { cwd: dir }).exitCode, 0, argv.join(' '));
    }
    return await readFile(join(dir, 'out.gem'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * RubyGems' API for `gems` (name → version → runtime dependencies), each
 * gem's archive a lib file. A version is a pure-Ruby build unless
 * `platforms` names another (`<name>-<version>` → platform).
 */
export async function rubyGemsRegistry(gems, platforms = {}) {
  const responses = new Map();
  const platformOf = (name, version) => platforms[`${name}-${version}`] ?? 'ruby';
  for (const [name, versions] of Object.entries(gems)) {
    responses.set(`https://rubygems.org/api/v1/versions/${name}.json`, () => Response.json(Object.keys(versions).map((number) => ({ number, platform: platformOf(name, number), prerelease: false }))));
    for (const [version, runtime] of Object.entries(versions)) {
      const gem = await gemArchive({ [`lib/${name}.rb`]: `# ${name} ${version}\n`, [`lib/${name}/version.rb`]: `V = "${version}"\n` });
      responses.set(`https://rubygems.org/api/v2/rubygems/${name}/versions/${version}.json`, () => Response.json({ name, version, platform: platformOf(name, version), gem_uri: `https://rubygems.org/gems/${name}-${version}.gem`, dependencies: { runtime } }));
      responses.set(`https://rubygems.org/gems/${name}-${version}.gem`, () => new Response(gem));
    }
  }
  return { ...ISOLATE_NETWORK, fetch: async (url) => (responses.get(String(url)) ?? (() => new Response(null, { status: 404 })))() };
}

/** A fresh workspace's filesystem, as the kernel. */
export async function gemWorkspace() {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  return ws.filesystem.view({ pid: 900, cred: CRED_KERNEL });
}
