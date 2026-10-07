#!/usr/bin/env bun
// The Node version a process reports is the oracle's, and meets the floors
// framework CLIs check.
//
// The version is a fingerprint, and CLIs gate on it before doing anything
// else. React Router 8.4 declares `engines.node: ">=22.22.0"` and its dev
// command checks it first: on v22.19.0 `react-router dev` printed "Oops, Node
// v22.19.0 detected. react-router requires a Node version greater than
// 22.22.0." and exited 1 (remix-real on a throwaway, sid dry-birch-1520),
// before vite was ever loaded. create-astro refuses any major below 22.
//
// It is also the release the tests compare Nimbus's node against: `node` on
// the CI image (pinned), whose behaviour the differential tests take as
// Node's. Reporting one release while matching another is a claim nothing
// checks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { NODE_VERSION, NODE_VERSIONS } from '../../packages/core/src/constants.ts';

const parse = (version) => version.replace(/^v/, '').split('.').map(Number);
const atLeast = (version, floor) => {
  const [a, b] = [parse(version), parse(floor)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

assert.equal(NODE_VERSION, `v${NODE_VERSIONS.node}`, 'process.version and process.versions.node agree');
assert.ok(atLeast(NODE_VERSIONS.node, '22.22.0'),
  `react-router 8.4 requires node >=22.22.0; the shim reports ${NODE_VERSION}`);

// The oracle: the node on PATH, as the differential tests run it.
const oracle = spawnSync('node', ['-p', 'JSON.stringify(process.versions)'], { encoding: 'utf8' });
assert.equal(oracle.status, 0, `node -p: ${oracle.stderr}`);
const actual = JSON.parse(oracle.stdout);
assert.deepEqual(NODE_VERSIONS, { node: actual.node, v8: actual.v8, modules: actual.modules },
  'the reported release is the oracle node');

console.log('node-version-floor: ok');
