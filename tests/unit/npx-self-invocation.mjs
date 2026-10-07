#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { formatNpxHelp, parseNpxInvocation } from '../../packages/worker/src/npm/npx-install.ts';

const parse = (args) => parseNpxInvocation(args);
assert.equal(parse([]).self, 'missing');
assert.equal(parse(['--version']).self, 'version');
assert.equal(parse(['-y', '--help']).self, 'help');
assert.equal(parse(['vite', '--version']).command, 'vite');
assert.deepEqual(parse(['vite', '--version']).args, ['--version']);
assert.equal(parse(['-y', 'vite', '--host', '0.0.0.0']).command, 'vite');
assert.deepEqual(parse(['-y', 'vite', '--host', '0.0.0.0']).args, ['--host', '0.0.0.0']);
assert.equal(parse(['-y', 'vite']).yes, true);
assert.equal(parse(['--package', '@vitejs/create-app', 'create-vite', 'app']).command, 'create-vite');
assert.deepEqual(parse(['--package', '@vitejs/create-app', 'create-vite', 'app']).args, ['app']);
assert.equal(parse(['--package', '@vitejs/create-app', 'create-vite', 'app']).packageOverride, '@vitejs/create-app');
assert.equal(parse(['--package=cowsay', 'cowsay']).packageOverride, 'cowsay');
// A --package with no value names nothing to run.
assert.equal(parse(['--package']).self, 'missing');
assert.match(formatNpxHelp(), /^Usage: npx /);

console.log('npx-self-invocation: ok');
