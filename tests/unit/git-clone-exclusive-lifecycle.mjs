#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { registerGitCommands } from '../../packages/worker/src/git/commands.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';

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
    as() {
      return {};
    },
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
    pid: 1,
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
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

{
  // --branch reaches the facet as the clone ref; the URL stays the URL.
  adoptCtxExports({
    SupervisorRPC() {
      return { async stdout() {}, [Symbol.dispose]() {} };
    },
  });
  const facetBodies = [];
  const env = {
    LOADER: {
      load() {
        return {
          getEntrypoint() {
            return {
              async fetch(request) {
                facetBodies.push(await request.json());
                return Response.json({ success: false, error: 'capture-only' });
              },
            };
          },
        };
      },
    },
  };
  const registry = {
    register(name, command) {
      if (name === 'git') registry.gitCommand = command;
    },
  };
  registerGitCommands(registry, {
    as() { return {}; },
    acquireExclusiveMutation(path) {
      return { root: path.replace(/^\/+/, ''), owner: 'owner-branch' };
    },
    releaseExclusiveMutation() {},
  }, { id: { toString: () => 'do-branch-test' }, waitUntil() {} }, env);
  const exitCode = await registry.gitCommand(commandContext([
    'clone',
    '--branch', 'dev',
    'https://example.invalid/repo.git',
    '/home/user/branched',
  ]));
  assert.equal(exitCode, 1, 'capture-only facet must surface as a failed clone');
  assert.ok(facetBodies.length >= 1, 'clone never reached the facet');
  assert.equal(facetBodies[0].phase, 'clone-prepare');
  assert.equal(facetBodies[0].url, 'https://example.invalid/repo.git');
  assert.equal(facetBodies[0].ref, 'dev', '--branch value did not reach the facet as ref');
  assert.equal(facetBodies[0].dir, '/home/user/branched');
  adoptCtxExports(undefined);
}

{
  // Unsupported flags fail the command loudly instead of silently no-opping.
  const harness = registerCloneHarness();
  const stderrLines = [];
  const ctx = commandContext(['clone', '--filter=blob:none', 'https://example.invalid/repo.git']);
  ctx.stderr = { write(line) { stderrLines.push(line); } };
  const exitCode = await harness.gitCommand(ctx);
  assert.equal(exitCode, 128);
  assert.match(stderrLines.join(''), /does not support '--filter'/);
  assert.equal(harness.acquiredRoots.length, 0, 'refused clone must not acquire a mutation lease');
}

console.log('git clone exclusive lifecycle: ok');
