#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  createNpmBinManifest,
  materializeNpmBinShims,
  npmBinManifestPath,
  resolveNpmBin,
  resolveNpmBinFromPath,
} from '../../packages/worker/src/npm/bin-links.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

class FakeVfs {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files));
    this.modes = new Map();
    this.dirs = new Set(['home', 'home/user', 'home/user/project', 'home/user/project/node_modules']);
    for (const path of this.files.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    }
  }

  exists(path) {
    return this.files.has(path) || this.dirs.has(path);
  }

  isDirectory(path) {
    return this.dirs.has(path);
  }

  readFileString(path) {
    if (!this.files.has(path)) throw new Error(`missing file: ${path}`);
    return this.files.get(path);
  }

  mkdir(path) {
    this.dirs.add(path);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
  }

  writeFile(path, content) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent) this.mkdir(parent);
    this.files.set(path, String(content));
    if (!this.modes.has(path)) this.modes.set(path, 0o644);
  }

  chmod(path, mode) {
    if (!this.files.has(path)) throw new Error(`ENOENT: ${path}`);
    this.modes.set(path, mode & 0o7777);
  }

  readdir(path) {
    const prefix = path ? `${path}/` : '';
    const seen = new Set();
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      seen.add(`${rest}:directory`);
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      seen.add(`${rest}:file`);
    }
    return Array.from(seen).sort().map((entry) => {
      const [name, type] = entry.split(':');
      return { name, type };
    });
  }
}

const nm = 'home/user/project/node_modules';
const manifestPath = npmBinManifestPath(nm);

{
  const vfs = new FakeVfs({
    [`${nm}/.bin/tool`]: '#!/usr/bin/env node\n',
    [manifestPath]: JSON.stringify(createNpmBinManifest([{
      name: 'tool',
      packageName: 'tool-pkg',
      packageVersion: '1.2.3',
      packagePath: `${nm}/tool-pkg`,
      targetPath: `${nm}/tool-pkg/bin/tool.js`,
    }])),
    [`${nm}/tool-pkg/bin/tool.js`]: 'console.log("ok")',
  });
  const resolved = resolveNpmBin(vfs, '/home/user/project', 'tool');
  assert.equal(resolved?.targetPath, `${nm}/tool-pkg/bin/tool.js`);
  assert.equal(resolved?.packageName, 'tool-pkg');
}

{
  const vfs = new FakeVfs({
    [`${nm}/.bin/scanned`]: '#!/usr/bin/env node\n',
    [manifestPath]: JSON.stringify({ version: 1, bins: {} }),
    [`${nm}/@scope/pkg/package.json`]: JSON.stringify({
      name: '@scope/pkg',
      version: '4.5.6',
      bin: { scanned: './cli' },
    }),
    [`${nm}/@scope/pkg/cli.js`]: 'console.log("ok")',
  });
  const resolved = resolveNpmBin(vfs, '/home/user/project', 'scanned');
  assert.equal(resolved?.targetPath, `${nm}/@scope/pkg/cli.js`);
  assert.equal(resolved?.packageName, '@scope/pkg');
}

{
  const vfs = new FakeVfs({
    [`${nm}/.bin/direct`]: '#!/usr/bin/env node\nconsole.log("direct")',
  });
  const resolved = resolveNpmBin(vfs, '/home/user/project', 'direct');
  assert.equal(resolved?.targetPath, `${nm}/.bin/direct`);
}

{
  const vfs = new FakeVfs({});
  assert.equal(resolveNpmBin(vfs, '/home/user/project', 'missing'), null);
}

{
  const vfs = new FakeVfs({
    [`${nm}/.bin/ancestor`]: '#!/usr/bin/env node\n',
    [manifestPath]: JSON.stringify(createNpmBinManifest([{
      name: 'ancestor',
      packageName: 'ancestor-pkg',
      packageVersion: '1.0.0',
      packagePath: `${nm}/ancestor-pkg`,
      targetPath: `${nm}/ancestor-pkg/cli.js`,
    }])),
    [`${nm}/ancestor-pkg/cli.js`]: 'console.log("ancestor")',
  });
  const resolved = resolveNpmBin(vfs, '/home/user/project/src/components', 'ancestor');
  assert.equal(resolved?.targetPath, `${nm}/ancestor-pkg/cli.js`);
}

{
  const prefixNm = 'home/user/.local/lib/node_modules';
  const vfs = new FakeVfs({
    [npmBinManifestPath(prefixNm)]: JSON.stringify(createNpmBinManifest([{
      name: 'pi',
      packageName: '@earendil-works/pi-coding-agent',
      packageVersion: '0.78.1',
      packagePath: `${prefixNm}/@earendil-works/pi-coding-agent`,
      targetPath: `${prefixNm}/@earendil-works/pi-coding-agent/dist/cli.js`,
    }])),
    [`${prefixNm}/.bin/pi`]: '#!/usr/bin/env node\n',
    [`${prefixNm}/@earendil-works/pi-coding-agent/dist/cli.js`]: 'console.log("0.78.1")',
  });

  const linked = materializeNpmBinShims(vfs, prefixNm, 'home/user/.local/bin');
  assert.equal(linked, 1);
  assert.equal(vfs.exists('home/user/.local/bin/pi'), true);
  // The on-PATH shim must be executable or the shell rejects it as
  // "command not found" — this is what left `pi` unusable after a
  // successful install.
  assert.equal(vfs.modes.get('home/user/.local/bin/pi'), 0o755, 'materialized shim is executable');

  const resolved = resolveNpmBinFromPath(
    vfs,
    '/home/user',
    '/home/user/.local/bin:/usr/bin',
    'pi',
  );
  assert.equal(resolved?.shimPath, 'home/user/.local/bin/pi');
  assert.equal(resolved?.targetPath, `${prefixNm}/@earendil-works/pi-coding-agent/dist/cli.js`);
  assert.equal(resolved?.packageName, '@earendil-works/pi-coding-agent');
}

// Multiple installed packages may publish the same command name. The bin
// manifest's last-writer-wins policy must also govern the streamed shim wave,
// so W7 receives one inode and one content chunk for that command path.
{
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const installer = new NpmInstaller(rawVfs, harness.sql);
  vfs.mkdir(`${nm}/sass`, { recursive: true });
  vfs.mkdir(`${nm}/sass-embedded/dist`, { recursive: true });
  vfs.writeFile(`${nm}/sass/sass.js`, '');
  vfs.writeFile(`${nm}/sass-embedded/dist/cli.js`, '');
  const resolved = new Map([
    ['sass', {
      name: 'sass', version: '1.0.0', bin: { sass: 'sass.js' },
    }],
    ['sass-embedded', {
      name: 'sass-embedded', version: '2.0.0', bin: { sass: 'dist/cli.js' },
    }],
  ]);

  await installer.linkBins(resolved, nm);

  const bin = resolveNpmBin(vfs, '/home/user/project', 'sass');
  assert.equal(bin?.packageName, 'sass-embedded');
  assert.equal(bin?.targetPath, `${nm}/sass-embedded/dist/cli.js`);
  assert.match(vfs.readFileString(`${nm}/.bin/sass`), /sass-embedded\/dist\/cli\.js/);
}

console.log('npm-bin-links: ok');
