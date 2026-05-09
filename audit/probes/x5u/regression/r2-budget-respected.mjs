#!/usr/bin/env bun
// X.5-U regression probe #2 — helper respects the shared budget cap.
//
// budgetState (passed in) carries totalBytes / fileCount. The helper
// must early-return if either is at the cap, and must not exceed
// the cap for the file it's about to add.

import { makeVfs, tryRealDotfileHelper, check, summary, reset } from '../_helpers.mjs';

reset();
console.log('X.5-U regression/r2-budget-respected — helper honours fileCount + totalBytes caps');

const fixture = {
  'home/user/app/node_modules/big/package.json': JSON.stringify({ name: 'big', main: 'index.js' }),
  'home/user/app/node_modules/big/index.js':
    'var fs_1 = require("fs"); var path_1 = require("path");\n' +
    'exports.x = (0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, ".cache-marker"), "utf8");\n',
  // 1 MB dotfile
  'home/user/app/node_modules/big/.cache-marker': 'x'.repeat(1024 * 1024),
  'home/user/app/script.js': 'require("big");\n',
};
const vfs = makeVfs(fixture);
const cwd = '/home/user/app';

const helper = await tryRealDotfileHelper();
if (helper === null) {
  console.log('  (TDD-RED) helper not exported');
  check('helper exported', false);
  process.exit(summary() ? 0 : 1);
}

// Case A: byte-budget already at limit → helper must NOT add anything.
{
  const inputBundle = {
    'home/user/app/script.js': fixture['home/user/app/script.js'],
    'home/user/app/node_modules/big/package.json': fixture['home/user/app/node_modules/big/package.json'],
    'home/user/app/node_modules/big/index.js': fixture['home/user/app/node_modules/big/index.js'],
  };
  // Set totalBytes already AT the cap so any add would breach.
  const counters = { totalBytes: 24 * 1024 * 1024, fileCount: 3 };
  const before = counters.fileCount;
  helper(vfs, cwd, inputBundle, counters);
  check(
    'A: helper adds 0 files when totalBytes at cap',
    counters.fileCount === before,
    `before=${before} after=${counters.fileCount}`,
  );
  check(
    'A: dotfile NOT in bundle when over cap',
    !('home/user/app/node_modules/big/.cache-marker' in inputBundle),
  );
}

// Case B: file-count already at cap → helper must NOT add.
{
  const inputBundle = {
    'home/user/app/script.js': fixture['home/user/app/script.js'],
    'home/user/app/node_modules/big/package.json': fixture['home/user/app/node_modules/big/package.json'],
    'home/user/app/node_modules/big/index.js': fixture['home/user/app/node_modules/big/index.js'],
  };
  const counters = { totalBytes: 1024, fileCount: 4000 };
  const before = counters.fileCount;
  helper(vfs, cwd, inputBundle, counters);
  check(
    'B: helper adds 0 files when fileCount at 4000',
    counters.fileCount === before,
    `before=${before} after=${counters.fileCount}`,
  );
}

// Case C: comfortable budget — should add the dotfile.
{
  const inputBundle = {
    'home/user/app/script.js': fixture['home/user/app/script.js'],
    'home/user/app/node_modules/big/package.json': fixture['home/user/app/node_modules/big/package.json'],
    'home/user/app/node_modules/big/index.js': fixture['home/user/app/node_modules/big/index.js'],
  };
  const counters = { totalBytes: 1024, fileCount: 3 };
  helper(vfs, cwd, inputBundle, counters);
  check(
    'C: dotfile IS in bundle when budget allows',
    'home/user/app/node_modules/big/.cache-marker' in inputBundle,
  );
}

const ok = summary();
process.exit(ok ? 0 : 1);
