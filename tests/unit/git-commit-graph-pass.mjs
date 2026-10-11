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
 *     lock and every layer as they are, and the pass says 'locked'; two
 *     writers of the same content-addressed layer: the one refused the lock
 *     never removes it, so the other's chain names a layer that is there
 *     (before and after the base layer); a chain that moved under the pass
 *     is left as it is ('moved');
 *   - after a pass, layers the chain does not name are collected under the
 *     lock, and a read-only layer of the name the pass makes is replaced.
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
      const piece = await graphFiltersPiece(context, { layer: plan.layer, pass: plan.pass, from, to: Math.min(from + pieceCommits, plan.commits), budgetMs: 60_000 });
      if (piece.file) files.push(piece.file);
      from = piece.next;
    }
    return { plan, ...(await graphFiltersAssemble(context, { layer: plan.layer, pass: plan.pass, files, windowBytes })) };
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

  // ── Two writers, one layer: another writer's lock, and the same layer ──
  // A git process (B) writing the same filtered layer holds the lock, its
  // layer placed and its chain not yet committed. The pass (A) is refused
  // the lock and leaves B's layer, which B's chain is about to name.
  {
    const { user, context } = session();
    const plan = await graphFiltersPlan(context);
    assert.ok(!('skipped' in plan), JSON.stringify(plan));
    assert.equal(diffGraphs(unfiltered, layerOf(user, plan.layer)), null, 'the base layer is host git\'s graph without filters');
    const files = [];
    for (let from = 0; from < plan.commits;) {
      const piece = await graphFiltersPiece(context, { layer: plan.layer, pass: plan.pass, from, to: plan.commits, budgetMs: 60_000 });
      files.push(piece.file);
      from = piece.next;
    }
    const same = nameOf(reference);
    user.writeFile(GRAPHS + '/graph-' + same + '.graph', reference, { mode: 0o444 });
    user.writeFile(GRAPHS + '/commit-graph-chain.lock', same + '\n', { mode: 0o444 });
    const assembled = await graphFiltersAssemble(context, { layer: plan.layer, pass: plan.pass, files, windowBytes: 64 });
    assert.deepEqual(assembled, { layer: null, skipped: 'locked' });
    assert.equal(chainOf(user), plan.layer + '\n', 'the chain still names the base layer');
    assert.equal(new TextDecoder().decode(user.readFile(GRAPHS + '/commit-graph-chain.lock')), same + '\n', 'B\'s lock is untouched');
    assert.deepEqual(listing(user), ['commit-graph-chain', 'commit-graph-chain.lock', 'graph-' + plan.layer + '.graph', 'graph-' + same + '.graph'],
      'A\'s temporary and pieces went; B\'s layer stays');
    // B commits: its chain names a layer that is there.
    user.rename(GRAPHS + '/commit-graph-chain.lock', GRAPHS + '/commit-graph-chain');
    assert.equal(diffGraphs(reference, layerOf(user, chainOf(user).trim())), null, 'the chain B committed names its layer, whole');
    console.log('  ok  two writers, the same layer: A refused the lock ("locked") leaves B\'s layer, which B\'s chain then names');
  }

  // ── The same before the base layer: no chain, and another writer's base ──
  {
    const { user, context } = session();
    const base = nameOf(unfiltered);
    user.mkdir(GRAPHS, { recursive: true });
    user.writeFile(GRAPHS + '/graph-' + base + '.graph', unfiltered, { mode: 0o444 });
    user.writeFile(GRAPHS + '/commit-graph-chain.lock', base + '\n', { mode: 0o444 });
    const plan = await graphFiltersPlan(context);
    assert.deepEqual(plan, { skipped: 'locked' });
    assert.deepEqual(listing(user), ['commit-graph-chain.lock', 'graph-' + base + '.graph'], 'B\'s lock and layer stay; A\'s temporary and the records went');
    assert.equal(diffGraphs(unfiltered, layerOf(user, base)), null);
    console.log('  ok  a lock held before the base layer: A installs none ("locked") and leaves B\'s layer of the same name');
  }

  // ── The chain moved under the pass: left as it is ──
  {
    const { user, context } = session();
    const plan = await graphFiltersPlan(context);
    const piece = await graphFiltersPiece(context, { layer: plan.layer, pass: plan.pass, from: 0, to: plan.commits, budgetMs: 60_000 });
    // A fetch layered on (git writes a second line).
    user.chmod(GRAPHS + '/commit-graph-chain', 0o644);
    user.writeFile(GRAPHS + '/commit-graph-chain', plan.layer + '\n' + 'ab'.repeat(20) + '\n');
    const assembled = await graphFiltersAssemble(context, { layer: plan.layer, pass: plan.pass, files: [piece.file], windowBytes: 64 });
    assert.deepEqual(assembled, { layer: null, skipped: 'moved' });
    assert.equal(chainOf(user), plan.layer + '\n' + 'ab'.repeat(20) + '\n');
    assert.deepEqual(listing(user), ['commit-graph-chain', 'graph-' + plan.layer + '.graph'], 'its temporary, pieces and lock went');
    console.log('  ok  a chain that moved under the pass is left as it is ("moved")');
  }

  // ── Layers the chain does not name: collected after a pass, under the lock ──
  {
    const { user, context } = session();
    const plan = await graphFiltersPlan(context);
    // A read-only layer of the name the pass makes (a writer stopped between
    // placing it and committing), and one no chain names.
    const filteredName = nameOf(reference);
    user.writeFile(GRAPHS + '/graph-' + filteredName + '.graph', 'stale', { mode: 0o444 });
    user.writeFile(GRAPHS + '/graph-' + 'cd'.repeat(20) + '.graph', 'orphan', { mode: 0o444 });
    const files = [];
    for (let from = 0; from < plan.commits;) {
      const piece = await graphFiltersPiece(context, { layer: plan.layer, pass: plan.pass, from, to: plan.commits, budgetMs: 60_000 });
      files.push(piece.file);
      from = piece.next;
    }
    const outcome = await graphFiltersAssemble(context, { layer: plan.layer, pass: plan.pass, files, windowBytes: 64 });
    assert.equal(outcome.layer, filteredName);
    assert.equal(diffGraphs(reference, layerOf(user, filteredName)), null, 'the stale layer of its name was replaced');
    assert.deepEqual(listing(user), ['commit-graph-chain', 'graph-' + filteredName + '.graph'], 'the base layer and the orphan were collected; the lock went');
    console.log('  ok  after the pass: a stale layer of its name replaced, layers the chain does not name collected');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log('git-commit-graph-pass: ok');
