#!/usr/bin/env bun
// A wave's apply gives the isolate up between committed groups when its
// caller gives it a turn, and reads the names it checks in batches. Red
// before: no turn ran during the whole apply, and most statements were
// single-path inode lookups (ToughCougar: an npm install's waves held a
// co-tenant session's clone for 11-16 s).

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const enc = new TextEncoder();

/** An npm-like wave: `packages` packages of three directories of five files each, under home/user/proj/node_modules. */
function installWave(packages) {
  const dirs = new Set(['home/user/proj/node_modules']);
  for (let p = 0; p < packages; p++) {
    dirs.add(`home/user/proj/node_modules/pkg${p}`);
    for (let d = 0; d < 3; d++) dirs.add(`home/user/proj/node_modules/pkg${p}/d${d}`);
  }
  const inodes = [];
  const chunks = [];
  for (const dir of [...dirs].sort()) inodes.push({ path: dir, parentPath: dir.slice(0, dir.lastIndexOf('/')), kind: 'directory', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });
  let n = 0;
  for (const dir of [...dirs].sort()) {
    if (!/\/d\d$/.test(dir)) continue;
    for (let f = 0; f < 5; f++) {
      const path = `${dir}/f${f}.js`;
      const data = enc.encode(`module.exports = ${n++};\n`.repeat(40));
      inodes.push({ path, parentPath: dir, kind: 'file', isDir: false, size: data.length, mtime: 1, mode: 0o644, chunkCount: 1 });
      chunks.push({ path, chunkId: 0, data });
    }
  }
  return { inodes, chunks };
}

const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const kernel = engine.as(CRED_KERNEL);
kernel.mkdir('home/user/proj', { recursive: true });
kernel.chown('home/user', 1000, 1000);
kernel.chown('home/user/proj', 1000, 1000);
// Its namespace places the wave's names (the wave router), as a session's does.
new ProcessFiles(engine);
// Within one batch's 1024 paths (W7_MAX_PATHS_PER_BATCH).
const wave = installWave(50);

// Every statement the apply runs, by kind.
let statements = 0;
let singlePathLookups = 0;
const exec = harness.sql.exec.bind(harness.sql);
harness.sql.exec = (query, ...bindings) => {
  statements++;
  if (/^\s*SELECT path, parent_path[^]*FROM vfs_inodes WHERE path = \?\s*$/.test(String(query))) singlePathLookups++;
  return exec(query, ...bindings);
};

// The co-tenant: a timer's turns, and the longest the isolate went without one.
let running = true;
let ticks = 0;
let maxGap = 0;
let last = performance.now();
const tick = () => {
  if (!running) return;
  const now = performance.now();
  maxGap = Math.max(maxGap, now - last);
  last = now;
  ticks++;
  setTimeout(tick, 0);
};
setTimeout(tick, 0);
const started = performance.now();
// The session's turn (NimbusSession.waveTurn) lets the isolate's other work run; here, a timer.
const result = await engine.as(USER).writeStream(encodeWriteBatchStream(wave), { turn: () => new Promise((resolve) => setTimeout(resolve, 0)) });
const applyMs = performance.now() - started;
running = false;
// The turn the apply ended in counts too.
maxGap = Math.max(maxGap, performance.now() - last);
harness.sql.exec = exec;

const records = wave.inodes.length;
console.log(JSON.stringify({ records, groups: result.committedGroupSequence, applyMs: Math.round(applyMs), ticks, maxTurnMs: Math.round(maxGap), statements, singlePathLookups }));
assert.equal(result.ok, true, JSON.stringify(result.error));
assert.equal(kernel.readFile('home/user/proj/node_modules/pkg7/d2/f4.js').byteLength, wave.chunks.at(-1).data.byteLength);
// Turns: another task runs between the committed groups.
assert.ok(ticks >= result.committedGroupSequence / 2, `the apply held the isolate: ${ticks} timer turns in ${result.committedGroupSequence} committed groups`);
// Held, the one turn is the whole apply; the bound leaves room for a loaded machine's slow group.
assert.ok(maxGap < applyMs / 2, `the longest turn (${Math.round(maxGap)} ms) is most of the apply (${Math.round(applyMs)} ms)`);
// Lookups: read in batches.
assert.ok(singlePathLookups < records / 10, `${singlePathLookups} single-path inode lookups for ${records} records`);
console.log('wave-apply-turns: ok');
process.exit(0);
