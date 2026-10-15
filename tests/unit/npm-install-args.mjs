#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { npmInstallInvocation } from '../../packages/core/src/substrate/lifo/commands/system/npm-install-args.ts';
import { loadNpmConfig } from '../../packages/core/src/substrate/lifo/commands/system/npm-config.ts';

/** `npm install <args>` as npm's configuration reads it, over `files` (path → text) with `env`. */
async function parseNpmInstallInvocation(args, files = {}, env = {}) {
  const vfs = {
    async exists(path) { return Object.keys(files).some((at) => at === path || at.startsWith(`${path}/`)); },
    async readFileString(path) {
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return files[path];
    },
  };
  return npmInstallInvocation(await loadNpmConfig(vfs, '/home/user/app', { HOME: '/home/user', ...env }, ['install', ...args]));
}

{
  const parsed = await parseNpmInstallInvocation([
    '-g',
    '--ignore-scripts',
    '--min-release-age=0',
    '--prefix',
    '/home/user/.local',
    '--no-fund',
    '--no-audit',
    '--loglevel=verbose',
    '--progress=false',
    '@earendil-works/pi-coding-agent',
  ]);

  assert.equal(parsed.global, true);
  assert.equal(parsed.prefix, '/home/user/.local');
  assert.deepEqual(parsed.packages, ['@earendil-works/pi-coding-agent']);
}

{
  const parsed = await parseNpmInstallInvocation([
    '--save-dev',
    'vite',
    '@vitejs/plugin-react',
  ]);

  assert.equal(parsed.global, false);
  assert.equal(parsed.prefix, null);
  assert.deepEqual(parsed.packages, ['vite', '@vitejs/plugin-react']);
}

// npm's options, as the install reads them.
{
  const plain = await parseNpmInstallInvocation(['xc']);
  assert.equal(plain.save, true, 'what is named is saved unless told not to');
  assert.equal(plain.savePrefix, '^');
  assert.deepEqual(plain.unsupported, []);
  assert.equal(await parseNpmInstallInvocation(['--no-save', 'xc']).save, false);
  assert.equal(await parseNpmInstallInvocation(['-E', 'xc']).savePrefix, '');
  assert.equal(await parseNpmInstallInvocation(['--save-prefix=~', 'xc']).savePrefix, '~');
  assert.equal(await parseNpmInstallInvocation(['--strict-peer-deps', 'xc']).strictPeerDeps, true);
  assert.equal(await parseNpmInstallInvocation(['--prefer-dedupe', 'xc']).preferDedupe, true);
  const omits = await parseNpmInstallInvocation(['--omit=dev', '--omit=optional', '--omit', 'peer', '--include=optional']);
  assert.deepEqual([omits.production, omits.omitOptional, omits.omitPeer], [true, false, true], '--include wins over --omit');
}

// An option that changes the tree, and that this npm does not implement, is refused, not ignored; its value is not a package.
for (const args of [['--install-strategy=nested'], ['--global-style'], ['--legacy-bundling'], ['-w', 'pkg'], ['--workspaces'], ['--dry-run'],
  ['--package-lock-only'], ['--no-bin-links'], ['--before', '2020-01-01'], ['--cpu=arm64'], ['--os', 'darwin'], ['--libc=musl'], ['--engine-strict']]) {
  const parsed = await parseNpmInstallInvocation([...args, 'xc']);
  assert.equal(parsed.unsupported.length, 1, args.join(' '));
  assert.deepEqual(parsed.packages, ['xc'], args.join(' '));
}
// A global install is always shallow: the strategy asked for is npm's to ignore.
assert.deepEqual(await parseNpmInstallInvocation(['-g', '--install-strategy=nested', 'xc']).unsupported, []);
assert.deepEqual(await parseNpmInstallInvocation(['-g', '--global-style', 'xc']).unsupported, []);

console.log('npm-install-args: ok');

// The registry is npm's to configure, as everything else is: the command line, npm_config_registry, or an .npmrc. Red before: --registry was parsed and dropped.
{
  assert.equal((await parseNpmInstallInvocation(['xc'])).registry, null, 'npm\'s default names no registry of its own: the session\'s stands');
  assert.equal((await parseNpmInstallInvocation(['--registry=https://mirror.example/', 'xc'])).registry, 'https://mirror.example/');
  assert.equal((await parseNpmInstallInvocation(['--registry', 'https://mirror.example/', 'xc'])).registry, 'https://mirror.example/');
  assert.equal((await parseNpmInstallInvocation(['xc'], {}, { npm_config_registry: 'https://env.example/' })).registry, 'https://env.example/');
  const project = { '/home/user/app/package.json': '{}', '/home/user/app/.npmrc': 'registry=https://project.example/\n' };
  assert.equal((await parseNpmInstallInvocation(['xc'], project)).registry, 'https://project.example/');
  assert.equal((await parseNpmInstallInvocation(['--registry=https://cli.example/', 'xc'], project)).registry, 'https://cli.example/', 'the command line over the project');
  // And so is the rest: an .npmrc's save-exact, an explicit false on the command line.
  assert.equal((await parseNpmInstallInvocation(['xc'], { '/home/user/app/package.json': '{}', '/home/user/app/.npmrc': 'save-exact=true\n' })).savePrefix, '');
  assert.equal((await parseNpmInstallInvocation(['--global=false', 'xc'])).global, false);
  assert.equal((await parseNpmInstallInvocation(['--location=global', 'xc'])).global, true);
}
