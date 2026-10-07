#!/usr/bin/env bun
// `npm init` writes the package.json npm 10.9.8 writes, byte for byte, and
// prints what npm prints (npm-init.ts): name, version, description, main,
// scripts.test, keywords, author and license in npm's order, and from the
// directory what npm reads of it (its .js files, bin/, lib/ and test/,
// node_modules, .git/config's origin, server.js, binding.gyp, a README, a
// .d.ts), merged into a package.json that is there in its own indent.
//
// The shell's npm wrote `type: "module"`, Vite's scripts, license MIT and
// empty dependency maps, and refused an existing package.json without -y;
// `npm init <initializer>` never reached `npm create`. Without -y the
// shell writes the same: it asks nothing, as npm asks nothing with -y.
//
// Each fixture is made twice: real npm runs `npm init -y` in one (with no
// user or global npmrc), and npmInitPackage reads the other.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { npmInitPackage } from '../../packages/core/src/substrate/lifo/commands/system/npm-init.ts';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const fixtures = {
  'My_App': {},
  'node-thing.js': {
    'lib/x.txt': '', 'test/t.txt': '', 'bin/cli.js': '', 'z.js': '', 'a.js': '',
    'node_modules/left-pad/package.json': '{"name":"left-pad","version":"1.3.0"}',
    'node_modules/mocha/package.json': '{"name":"mocha","version":"10.0.0"}',
    'node_modules/@s/x/package.json': '{"name":"@s/x","version":"1.0.0"}',
    'node_modules/.bin/mocha': '',
  },
  'g': { '.git/config': '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:u/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' },
  's': { 'server.js': '', 'binding.gyp': '', 'README.md': '# Title\n\nA small thing\nthat does stuff.\n\nMore.\n' },
  'typed': { 'index.js': '', 'index.d.ts': '', 'node_modules/left-pad/package.json': '{"name":"left-pad","version":"1.3.0"}' },
  'kept': { 'package.json': '{\n    "name": "Kept",\n    "version": "nope",\n    "scripts": {"build": "x"}\n}\n' },
  'compact': { 'package.json': '{"name":"t","bin":"./cli.js","dependencies":{"a":"1"},"version":"v2.0.0","scripts":{"x":"node_modules/.bin/foo"}}' },
  'tabs': { 'package.json': '{\n\t"name": "q",\n\t"repository": "https://gitlab.com/a/b",\n\t"keywords": "x, y"\n}\n' },
};

const disk = mkdtempSync(join(tmpdir(), 'npm-init-'));
try {
  // No npmrc (an init-author-name, a scope) changes what npm writes.
  writeFileSync(join(disk, 'user-npmrc'), '');
  writeFileSync(join(disk, 'global-npmrc'), '');
  const npmEnv = {
    ...process.env, npm_config_userconfig: join(disk, 'user-npmrc'), npm_config_globalconfig: join(disk, 'global-npmrc'),
    npm_config_update_notifier: 'false', npm_config_fund: 'false',
  };
  const version = spawnSync('npm', ['--version'], { encoding: 'utf8', env: npmEnv }).stdout.trim();
  assert.equal(version, '10.9.8', 'premise: npm is 10.9.8');

  for (const [name, files] of Object.entries(fixtures)) {
    const trees = [join(disk, 'npm', name), join(disk, 'ours', name)];
    for (const tree of trees) {
      mkdirSync(tree, { recursive: true });
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(tree, rel)), { recursive: true });
        writeFileSync(join(tree, rel), text);
      }
    }
    const npm = spawnSync('npm', ['init', '-y'], { cwd: trees[0], encoding: 'utf8', env: npmEnv });
    assert.equal(npm.status, 0, `npm init -y in ${name}: ${npm.stderr}`);
    const vfs = {
      readFileString: async (path) => readFileSync(path, 'utf8'),
      readdir: async (path) => readdirSync(path).map((entry) => ({ name: entry })),
      exists: async (path) => existsSync(path),
    };
    const ours = await npmInitPackage(vfs, trees[1]);
    assert.equal(ours.text, readFileSync(join(trees[0], 'package.json'), 'utf8'), `${name}: the package.json npm writes`);
    assert.equal(ours.message.replaceAll(trees[1], trees[0]), npm.stdout, `${name}: what npm prints`);
  }

  // The shell's command, `npm init` and `npm init -y`, in a session: a new
  // directory, and one whose package.json it merges into.
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel));
  const fs = ws.vfs.as(CRED_KERNEL);
  for (const [name, args] of [['My_App', 'init -y'], ['My_App', 'init'], ['kept', 'init']]) {
    const dir = `/home/user/${args.replace(/\W/g, '')}/${name}`;
    const existing = fixtures[name]['package.json'];
    const made = await ws.exec(`mkdir -p ${dir}` + (existing ? ` && printf '%s' '${existing}' > ${dir}/package.json` : ''));
    assert.equal(made.exitCode, 0, made.stderr);
    const run = await ws.exec(`cd ${dir} && npm ${args}`);
    assert.equal(run.exitCode, 0, `npm ${args} in ${name}: ${run.stderr}`);
    const npmDir = join(disk, 'npm', name);
    assert.equal(fs.readFileString(`${dir}/package.json`), readFileSync(join(npmDir, 'package.json'), 'utf8'), `npm ${args} in ${name} writes npm's package.json`);
    assert.equal(run.stdout.replaceAll(dir, npmDir), spawnSync('npm', ['init', '-y'], { cwd: join(disk, 'ours', name), encoding: 'utf8', env: npmEnv }).stdout.replaceAll(join(disk, 'ours', name), npmDir), `npm ${args} prints npm's message`);
  }
} finally {
  rmSync(disk, { recursive: true, force: true });
}

console.log(`npm-init-matches-npm: ${Object.keys(fixtures).length} directories, the package.json and message npm 10.9.8 writes`);
