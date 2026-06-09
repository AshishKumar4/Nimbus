#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  describeNpxSelfInvocation,
  formatNpxHelp,
  getNpxCommandArgs,
  getNpxCommandWord,
} from '../../packages/worker/src/npm/npx-install.ts';

assert.equal(describeNpxSelfInvocation([]), 'missing');
assert.equal(describeNpxSelfInvocation(['--version']), 'version');
assert.equal(describeNpxSelfInvocation(['-y', '--help']), 'help');
assert.equal(getNpxCommandWord(['vite', '--version']), 'vite');
assert.deepEqual(getNpxCommandArgs(['vite', '--version']), ['--version']);
assert.equal(getNpxCommandWord(['-y', 'vite', '--host', '0.0.0.0']), 'vite');
assert.deepEqual(getNpxCommandArgs(['-y', 'vite', '--host', '0.0.0.0']), ['--host', '0.0.0.0']);
assert.equal(getNpxCommandWord(['--package', '@vitejs/create-app', 'create-vite', 'app']), 'create-vite');
assert.deepEqual(getNpxCommandArgs(['--package', '@vitejs/create-app', 'create-vite', 'app']), ['app']);
assert.match(formatNpxHelp(), /^Usage: npx /);

console.log('npx-self-invocation: ok');
