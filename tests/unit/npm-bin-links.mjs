#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  createNpmBinManifest,
  materializeNpmBinShims,
  npmBinManifestPath,
  resolveNpmBin,
  resolveNpmBinFromPath,
} from '../../packages/worker/src/npm/bin-links.ts';

class FakeVfs {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files));
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

console.log('npm-bin-links: ok');
