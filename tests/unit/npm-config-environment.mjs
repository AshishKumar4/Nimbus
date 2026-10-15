#!/usr/bin/env bun
// npm's definitions take some defaults from npm's own environment (omit from
// NODE_ENV, editor, shell, unicode, color): here that is the command's, never
// the Worker's own. Red before: a Worker built with NODE_ENV=production made
// every `npm install` omit devDependencies (a scaffold's vite, its whole
// toolchain), whatever the session's environment said.

import assert from 'node:assert/strict';

// The isolate's own environment, as a production build leaves it, before npm's libraries load.
process.env.NODE_ENV = 'production';
process.env.EDITOR = 'worker-editor';
const { loadNpmConfig } = await import('../../packages/core/src/substrate/lifo/commands/system/npm-config.ts');
const { npmInstallInvocation } = await import('../../packages/core/src/substrate/lifo/commands/system/npm-install-args.ts');

const vfs = {
  async exists(path) { return path === '/home/user/app/package.json'; },
  async readFileString(path) { throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }); },
};
const load = (env, args = ['install']) => loadNpmConfig(vfs, '/home/user/app', { HOME: '/home/user', ...env }, args);

{
  const plain = await load({});
  assert.deepEqual(plain.get('omit'), [], 'the Worker\'s NODE_ENV omitted devDependencies');
  assert.equal(npmInstallInvocation(plain).production, false);
  assert.equal(plain.get('editor'), 'vi');
  assert.equal(plain.get('unicode'), false);
  assert.equal(plain.get('color'), true);
}
{
  const production = await load({ NODE_ENV: 'production', EDITOR: 'nano', SHELL: '/bin/bash', LANG: 'en_US.UTF-8', NO_COLOR: '1' });
  assert.deepEqual(production.get('omit'), ['dev'], 'the command\'s NODE_ENV=production omits them, as npm does');
  assert.equal(npmInstallInvocation(production).production, true);
  assert.deepEqual(npmInstallInvocation(await load({ NODE_ENV: 'production' }, ['install', '--include=dev'])).production, false, '--include=dev wins');
  assert.equal(production.get('editor'), 'nano');
  assert.equal(production.get('shell'), '/bin/bash');
  assert.equal(production.get('unicode'), true);
  assert.equal(production.get('color'), false);
  assert.deepEqual(production.default('omit'), ['dev']);
}
console.log('npm-config-environment: ok');
