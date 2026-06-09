#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { parseNpmInstallInvocation } from '../../packages/worker/src/npm/install-args.ts';

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

console.log('npm-install-args: ok');
