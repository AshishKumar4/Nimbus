#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { parseNpmInstallInvocation } from '../../packages/core/src/substrate/lifo/commands/system/npm-install-args.ts';

{
  const parsed = parseNpmInstallInvocation([
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
  const parsed = parseNpmInstallInvocation([
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
  const plain = parseNpmInstallInvocation(['xc']);
  assert.equal(plain.save, true, 'what is named is saved unless told not to');
  assert.equal(plain.savePrefix, '^');
  assert.deepEqual(plain.unsupported, []);
  assert.equal(parseNpmInstallInvocation(['--no-save', 'xc']).save, false);
  assert.equal(parseNpmInstallInvocation(['-E', 'xc']).savePrefix, '');
  assert.equal(parseNpmInstallInvocation(['--save-prefix=~', 'xc']).savePrefix, '~');
  assert.equal(parseNpmInstallInvocation(['--strict-peer-deps', 'xc']).strictPeerDeps, true);
  assert.equal(parseNpmInstallInvocation(['--prefer-dedupe', 'xc']).preferDedupe, true);
  const omits = parseNpmInstallInvocation(['--omit=dev', '--omit=optional', '--omit', 'peer', '--include=optional']);
  assert.deepEqual([omits.production, omits.omitOptional, omits.omitPeer], [true, false, true], '--include wins over --omit');
}

// An option that changes the tree, and that this npm does not implement, is refused, not ignored; its value is not a package.
for (const args of [['--install-strategy=nested'], ['--global-style'], ['--legacy-bundling'], ['-w', 'pkg'], ['--workspaces'], ['--dry-run'],
  ['--package-lock-only'], ['--no-bin-links'], ['--before', '2020-01-01'], ['--cpu=arm64'], ['--os', 'darwin'], ['--libc=musl'], ['--engine-strict']]) {
  const parsed = parseNpmInstallInvocation([...args, 'xc']);
  assert.equal(parsed.unsupported.length, 1, args.join(' '));
  assert.deepEqual(parsed.packages, ['xc'], args.join(' '));
}
// A global install is always shallow: the strategy asked for is npm's to ignore.
assert.deepEqual(parseNpmInstallInvocation(['-g', '--install-strategy=nested', 'xc']).unsupported, []);
assert.deepEqual(parseNpmInstallInvocation(['-g', '--global-style', 'xc']).unsupported, []);

console.log('npm-install-args: ok');
