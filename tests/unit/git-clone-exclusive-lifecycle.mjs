#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { registerGitCommands } from '../../packages/worker/src/git/commands.ts';

function registerCloneHarness() {
  let gitCommand;
  const registry = {
    register(name, command) {
      if (name === 'git') gitCommand = command;
    },
  };
  const activeOwners = new Set();
  const acquiredRoots = [];
  const acquisitionOptions = [];
  const releasedOwners = [];
  const vfs = {
    acquireExclusiveMutation(path, options) {
      const owner = `owner-${acquiredRoots.length + 1}`;
      acquiredRoots.push(path);
      acquisitionOptions.push(options);
      activeOwners.add(owner);
      return { root: path.replace(/^\/+/, ''), owner };
    },
    releaseExclusiveMutation(owner) {
      releasedOwners.push(owner);
      activeOwners.delete(owner);
    },
  };
  const waitUntilPromises = [];
  const doCtx = {
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    },
  };
  registerGitCommands(registry, vfs, doCtx, {});
  assert.equal(typeof gitCommand, 'function');
  return {
    gitCommand,
    activeOwners,
    acquiredRoots,
    acquisitionOptions,
    releasedOwners,
    waitUntilPromises,
  };
}

function commandContext(args) {
  return {
    args,
    cwd: '/home/user',
    env: {},
    stdout: { write() {} },
    stderr: { write() {} },
  };
}

{
  const harness = registerCloneHarness();
  const exitCode = await harness.gitCommand(commandContext([
    'clone',
    'https://example.invalid/repo.git',
    '/home/user/foreground',
  ]));
  assert.equal(exitCode, 1, 'foreground clone must propagate the facet failure status');
  assert.deepEqual(harness.acquiredRoots, ['/home/user/foreground']);
  assert.deepEqual(harness.acquisitionOptions, [{ includeMissingAncestors: true }]);
  assert.deepEqual(harness.releasedOwners, ['owner-1']);
  assert.equal(harness.activeOwners.size, 0);
  assert.equal(harness.waitUntilPromises.length, 0);
}

{
  const harness = registerCloneHarness();
  const exitCode = await harness.gitCommand(commandContext([
    'clone',
    'https://example.invalid/repo.git',
    '/home/user/background',
    '&',
  ]));
  assert.equal(exitCode, 0);
  assert.deepEqual(harness.acquiredRoots, ['/home/user/background']);
  assert.deepEqual(harness.acquisitionOptions, [{ includeMissingAncestors: true }]);
  assert.equal(harness.waitUntilPromises.length, 1, 'background clone was not owned by DO waitUntil');
  await harness.waitUntilPromises[0];
  assert.deepEqual(harness.releasedOwners, ['owner-1']);
  assert.equal(harness.activeOwners.size, 0);
}

console.log('git clone exclusive lifecycle: ok');
