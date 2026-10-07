#!/usr/bin/env bun
/**
 * git-commit-graph-pass — the commit-graph pass a full clone leaves running
 * (git/pack/graph-filters.ts), its steps driven directly against a session's
 * VFS as the session user, on the reference fixture's packs and commit
 * records (lib/commit-graph-reference.mjs):
 *   - plan, pieces (a few commits each) and assemble (a window of 64 bytes)
 *     leave host git's `--changed-paths` graph, byte for byte, the only
 *     layer the chain names, with nothing else in commit-graphs/; the
 *     assembly reads no more than a window at a time;
 *   - the chain is replaced as git replaces it: another writer's
 *     commit-graph-chain.lock (read-only, as git's is) leaves the chain, the
 *     lock and the layers as they are, and the pass says 'locked' (it was
 *     refused EACCES, or replaced the lock: both wrong); a chain that moved
 *     under the pass is left as it is ('moved');
 *   - what a pass cut short left is recovered: its temporary layer, its
 *     pieces, and a read-only layer of the name the pass makes, replaced.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildFixture, diffGraphs, referenceGraph } from './lib/commit-graph-reference.mjs';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { createWaveWriter } from '../../packages/platform/src/wave-writer.ts';
import { commitRecord } from '../../packages/worker/src/git/pack/commit-graph.ts';
import { graphFiltersAssemble, graphFiltersPiece, graphFiltersPlan } from '../../packages/worker/src/git/pack/graph-filters.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const work = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'commit-graph-pass-'));
const git = (cwd, args, input) => execFileSync('git', args, {
  cwd, input, maxBuffer: 1 << 28, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});
const REPO = 'home/user/repo';
const GRAPHS = REPO + '/.git/objects/info/commit-graphs';

try {
  const fixture = buildFixture(path.join(work, 'fixture'));
  git(fixture, ['repack', '-adq']);
  const reference = referenceGraph(fixture);
  const unfiltered = referenceGraph(fixture, { changedPaths: false });
  // A layer's name: its trailing hash.
  const nameOf = (bytes) => Buffer.from(bytes.subarray(bytes.byteLength - 20)).toString('hex');

  // Every commit's record, as a clone's commits piece writes them.
  const ids = git(fixture, ['rev-list', '--all']).toString().trim().split('\n');
  const records = [];
  for (const id of ids) {
    const data = new Uint8Array(git(fixture, ['cat-file', 'commit', id]));
    records.push(commitRecord(Uint8Array.from(Buffer.from(id, 'hex')), data));
  }
  const recordBytes = Buffer.concat(records);

  /** A session VFS holding the fixture's packs and the clone's records; the pass's context on it, as the session user. */
  function session() {
    const harness = createSqliteVfsTestHarness();
    const vfs = new SqliteVFS(harness.sql, harness.ctx);
    const kernel = vfs.as(CRED_KERNEL);
    kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
    kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
    const user = vfs.as(CRED_SESSION_USER);
    const bridge = new SqliteRuntimeFsBridge(user, vfs);
    user.mkdir(REPO + '/.git/objects/pack', { recursive: true });
    for (const name of readdirSync(path.join(fixture, '.git/objects/pack'))) {
      user.writeFile(REPO + '/.git/objects/pack/' + name, new Uint8Array(readFileSync(path.join(fixture, '.git/objects/pack', name))));
    }
    user.mkdir(GRAPHS + '/tmp_records', { recursive: true });
    user.writeFile(GRAPHS + '/tmp_records/graph-list-commits-0', new Uint8Array(recordBytes));
    const reads = [];
    const supervisor = {
      async fsReadRange(p, offset, length) { reads.push({ path: p, length }); try { return bridge.readRange(p, offset, length); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } },
      async fsWriteRange(p, offset, bytes) { return bridge.writeRange(p, offset, bytes, { createParents: true }); },
      async fsTruncate(p, size) { return bridge.truncate(p, size); },
      async rename(from, to) { return bridge.rename(from, to); },
      async readdir(p) { try { return bridge.readdir(p).map((entry) => (typeof entry === 'string' ? entry : entry.name)); } catch { return []; } },
      async fsOpen(p, flags) { return bridge.open(p, flags); },
      async fsWrite(handle, offset, bytes) { return bridge.write(handle, offset, bytes); },
      async fsClose(handle) { return bridge.close(handle); },
      async chmod(p, mode) { return bridge.chmod(p, mode); },
      async unlink(p) { return bridge.unlink(p); },
    };
    const context = {
      supervisor,
      dir: REPO,
      writer: () => createWaveWriter({ supervisor: { writeBatchStream: (stream) => user.writeStream(stream) }, root: REPO, base: REPO }),
    };
    return { user, context, reads };
  }

  /** The whole pass, as network-facet's driver runs it: `pieceCommits` a piece, `windowBytes` an assembly window. */
  async function pass(context, { pieceCommits = 3, windowBytes = 64 } = {}) {
    const plan = await graphFiltersPlan(context);
    if ('skipped' in plan) return plan;
    const files = [];
    for (let from = 0; from < plan.commits;) {
      const piece = await graphFiltersPiece(context, { layer: plan.layer, from, to: Math.min(from + pieceCommits, plan.commits), budgetMs: 60_000 });
      if (piece.file) files.push(piece.file);
      from = piece.next;
    }
    return { plan, ...(await graphFiltersAssemble(context, { layer: plan.layer, files, windowBytes })) };
  }

  const listing = (user) => user.readdir(GRAPHS).map(({ name }) => name).sort();
  const chainOf = (user) => new TextDecoder().decode(user.readFile(GRAPHS + '/commit-graph-chain'));
  const layerOf = (user, name) => user.readFile(GRAPHS + '/graph-' + name + '.graph');

  // ── The whole pass: host git's --changed-paths graph, nothing else left ──
  {
    const { user, context, reads } = session();
    const outcome = await pass(context);
    assert.equal(outcome.skipped, undefined, JSON.stringify(outcome));
    const chain = chainOf(user);
    assert.equal(chain, outcome.layer + '\n');
    assert.equal(diffGraphs(reference, layerOf(user, outcome.layer)), null, 'host git\'s --changed-paths graph, byte for byte');
    assert.deepEqual(listing(user), ['commit-graph-chain', 'graph-' + outcome.layer + '.graph'], 'the base layer, the records, the pieces and the lock are gone');
    assert.equal(user.stat(GRAPHS + '/commit-graph-chain').mode & 0o777, 0o444, 'the chain is read-only, as git makes it');
    assert.equal(user.stat(GRAPHS + '/graph-' + outcome.layer + '.graph').mode & 0o777, 0o444);
    const graphReads = reads.filter((read) => read.path.includes('/commit-graphs/graph-') && read.length > 64);
    assert.deepEqual(graphReads.filter((read) => read.length > 36 * records.length), [], 'no layer is read whole: its CDAT at most');
    console.log(`  ok  the pass: host git's graph, byte for byte (${records.length} commits); nothing else left in commit-graphs/`);
  }

  // ── Another writer's lock: the chain, the lock and the layers stay ──
  {
    const { user, context } = session();
    // The base layer first, as a pass that got as far as its pieces.
    const plan = await graphFiltersPlan(context);
    assert.ok(!('skipped' in plan), JSON.stringify(plan));
    assert.equal(diffGraphs(unfiltered, layerOf(user, plan.layer)), null, 'the base layer is host git\'s graph without filters');
    // A git process holds the lock (git creates it 0444).
    user.writeFile(GRAPHS + '/commit-graph-chain.lock', 'held\n', { mode: 0o444 });
    const files = [];
    for (let from = 0; from < plan.commits;) {
      const piece = await graphFiltersPiece(context, { layer: plan.layer, from, to: plan.commits, budgetMs: 60_000 });
      files.push(piece.file);
      from = piece.next;
    }
    const assembled = await graphFiltersAssemble(context, { layer: plan.layer, files, windowBytes: 64 });
    assert.deepEqual(assembled, { layer: null, skipped: 'locked' });
    assert.equal(chainOf(user), plan.layer + '\n', 'the chain still names the base layer');
    assert.equal(new TextDecoder().decode(user.readFile(GRAPHS + '/commit-graph-chain.lock')), 'held\n', 'the other writer\'s lock is untouched');
    assert.deepEqual(listing(user), ['commit-graph-chain', 'commit-graph-chain.lock', 'graph-' + plan.layer + '.graph'], 'the filtered layer and the pieces went');
    // Its lock gone, a later pass completes.
    user.unlink(GRAPHS + '/commit-graph-chain.lock');
    const later = await pass(context);
    assert.equal(diffGraphs(reference, layerOf(user, later.layer)), null);
    console.log('  ok  another writer\'s lock: the chain, its lock and the base layer stay ("locked"); a later pass completes');
  }

  // ── No chain yet and a lock held: no base layer installed ──
  {
    const { user, context } = session();
    user.mkdir(GRAPHS, { recursive: true });
    user.writeFile(GRAPHS + '/commit-graph-chain.lock', 'held\n', { mode: 0o444 });
    const plan = await graphFiltersPlan(context);
    assert.deepEqual(plan, { skipped: 'locked' });
    assert.deepEqual(listing(user), ['commit-graph-chain.lock'], 'no chain, no layer, no records');
    console.log('  ok  a lock held before the base layer: none installed ("locked")');
  }

  // ── The chain moved under the pass: left as it is ──
  {
    const { user, context } = session();
    const plan = await graphFiltersPlan(context);
    const piece = await graphFiltersPiece(context, { layer: plan.layer, from: 0, to: plan.commits, budgetMs: 60_000 });
    // A fetch layered on (git writes a second line).
    user.chmod(GRAPHS + '/commit-graph-chain', 0o644);
    user.writeFile(GRAPHS + '/commit-graph-chain', plan.layer + '\n' + 'ab'.repeat(20) + '\n');
    const assembled = await graphFiltersAssemble(context, { layer: plan.layer, files: [piece.file], windowBytes: 64 });
    assert.deepEqual(assembled, { layer: null, skipped: 'moved' });
    assert.equal(chainOf(user), plan.layer + '\n' + 'ab'.repeat(20) + '\n');
    assert.deepEqual(listing(user), ['commit-graph-chain', 'graph-' + plan.layer + '.graph'], 'its layer, pieces and lock went');
    console.log('  ok  a chain that moved under the pass is left as it is ("moved")');
  }

  // ── A pass cut short: its leavings recovered ──
  {
    const { user, context } = session();
    const plan = await graphFiltersPlan(context);
    // It had written a temporary layer, pieces, and its filtered layer under
    // its own name (read-only), but never moved the chain.
    user.writeFile(GRAPHS + '/tmp_nimbus_graph_0123', 'partial', { mode: 0o444 });
    user.mkdir(GRAPHS + '/tmp_filters_' + plan.layer, { recursive: true });
    user.writeFile(GRAPHS + '/tmp_filters_' + plan.layer + '/piece-0-3', 'old');
    const filteredName = nameOf(reference);
    user.writeFile(GRAPHS + '/graph-' + filteredName + '.graph', 'stale', { mode: 0o444 });
    const outcome = await pass(context);
    assert.equal(outcome.layer, filteredName);
    assert.equal(diffGraphs(reference, layerOf(user, filteredName)), null, 'the stale read-only layer of its name was replaced');
    assert.deepEqual(listing(user), ['commit-graph-chain', 'graph-' + filteredName + '.graph']);
    console.log('  ok  a pass cut short: its temporary layer and pieces go, a read-only layer of its name is replaced');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log('git-commit-graph-pass: ok');
