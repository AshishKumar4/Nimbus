#!/usr/bin/env bun
// Moving a tree commits in bounded groups, and the source outlives the
// destination it is becoming.
//
// `mv` built ONE transaction for the whole subtree — two logical rows per
// entry, the old path deleted and the new one inserted — so a 1,080-entry
// extract died on
//
//     mv: [sqlite-vfs] transaction exceeds logicalRows limit: 2160 > 256
//
// The cap is not the defect. The defect is what a partial move costs: an
// installer that has already removed the destination and then cannot complete
// the move has destroyed the tree, because the move's own failure mode was to
// leave entries at neither path.
//
// So the ordering is the contract, not just the bounding: every entry is
// PUBLISHED at the destination before ANY entry is removed from the source.
// Content is shared by id rather than copied, so the intermediate state costs
// inode rows and not bytes. Interrupt it anywhere and the source is still a
// complete tree — the operation is retryable, and nothing is ever unreachable
// from both paths.

import assert from 'node:assert/strict';
import { MAX_TX_LOGICAL_ROWS } from '../../packages/worker/src/constants.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

function openVfs(harness = createSqliteVfsTestHarness()) {
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, rawVfs, vfs: rawVfs.as(CRED_KERNEL) };
}

function reopenVfs(harness) {
  return openVfs(createSqliteVfsTestHarness(harness.db)).vfs;
}

/** A tree of `dirs` directories each holding `perDir` files. */
function seedTree(vfs, root, dirs, perDir) {
  const contents = new Map();
  vfs.mkdir(root, { recursive: true });
  for (let d = 0; d < dirs; d++) {
    const dir = `${root}/pkg-${d}/lib`;
    vfs.mkdir(dir, { recursive: true });
    for (let f = 0; f < perDir; f++) {
      const path = `${dir}/file-${f}.js`;
      const body = `module.exports = ${d * perDir + f};\n`;
      vfs.writeFile(path, body);
      contents.set(path, body);
    }
  }
  return contents;
}

/** Every path under `root`, relative to it, so two trees can be compared. */
function treeShape(vfs, root) {
  const out = [];
  const walk = (dir) => {
    for (const e of vfs.readdir(dir).slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = `${dir}/${e.name}`;
      out.push([path.slice(root.length + 1), e.type]);
      if (e.type === 'directory') walk(path);
    }
  };
  walk(root);
  return out;
}

// ── A tree far past one transaction's row budget moves whole ──────────────
// 12 × (2 dirs + 12 files) = 168 entries → 336 logical rows, comfortably over
// MAX_TX_LOGICAL_ROWS, and the shape that produced the installer's 2160.
{
  const { harness, rawVfs, vfs } = openVfs();
  const contents = seedTree(vfs, 'extract/proteus', 12, 12);
  const entries = 1 + 12 * (2 + 12);
  assert.ok(
    entries * 2 > MAX_TX_LOGICAL_ROWS,
    `fixture must exceed the bound: ${entries * 2} vs ${MAX_TX_LOGICAL_ROWS}`,
  );
  vfs.mkdir('src', { recursive: true });

  const before = treeShape(vfs, 'extract/proteus');
  vfs.rename('extract/proteus', 'src/proteus');

  const reconstructed = reopenVfs(harness);
  assert.equal(reconstructed.exists('extract/proteus'), false, 'source is gone');
  assert.deepEqual(treeShape(reconstructed, 'src/proteus'), before, 'tree arrives whole');
  for (const [path, body] of contents) {
    const moved = path.replace('extract/proteus', 'src/proteus');
    assert.equal(reconstructed.readFileString(moved), body, `${moved} keeps its content`);
  }
  assert.equal(rawVfs._verifyCounters(), null, 'counters track the move');
}

// ── The move shares content; it does not copy bytes ───────────────────────
// A destination-first move holds both paths at once. If that duplicated
// chunks, moving a node_modules tree would need twice the storage and twice
// the write budget — the whole point of moving rather than copying.
{
  const { harness, vfs } = openVfs();
  seedTree(vfs, 'from', 10, 10);
  vfs.mkdir('to', { recursive: true });
  const chunksBefore = harness.sql.exec('SELECT COUNT(*) AS n FROM file_chunks')[0].n;

  vfs.rename('from', 'to/here');

  const chunksAfter = harness.sql.exec('SELECT COUNT(*) AS n FROM file_chunks')[0].n;
  assert.equal(chunksAfter, chunksBefore, 'moving a tree writes no new chunks');
}

// ── Interrupted at EVERY commit boundary, nothing is ever unreachable ─────
// The installer had already deleted the destination before calling mv, so the
// only property that protects it is that no entry is ever absent from both
// paths. Asserting it at one arbitrary boundary proves nothing — the sweep
// below fails the move at each commit in turn and checks the whole tree.
//
// Two regimes are expected, and both are safe:
//   during publication  → the destination is unwound, leaving the pre-move
//                         state, and the retry behaves as if nothing happened;
//   during retirement   → the destination is already complete, so the residue
//                         is a partial SOURCE, which is what a caller's
//                         cleanup removes.
{
  // 20 × (2 dirs + 20 files) + root = 441 entries, which is past
  // MAX_TX_LOGICAL_ROWS for publication too — so the sweep reaches a failure
  // with groups ALREADY published, which is the case the unwind exists for.
  const seedContents = (vfs) => {
    const contents = seedTree(vfs, 'extract/proteus', 20, 20);
    vfs.mkdir('src', { recursive: true });
    return contents;
  };
  // How many commits a complete move takes, so the sweep covers all of them.
  const { rawVfs: probeRaw, vfs: probeVfs } = openVfs();
  const shape = (() => {
    const c = seedContents(probeVfs);
    const before = treeShape(probeVfs, 'extract/proteus');
    let commits = 0;
    const real = probeRaw.executeTransactionPlan.bind(probeRaw);
    probeRaw.executeTransactionPlan = (plan, execution) => { commits++; return real(plan, execution); };
    probeVfs.rename('extract/proteus', 'src/proteus');
    probeRaw.executeTransactionPlan = real;
    return { before, contents: c, commits };
  })();
  assert.ok(shape.commits >= 4, `a 441-entry move must span several commits, got ${shape.commits}`);

  let unwound = 0;
  let completed = 0;
  for (let failAt = 1; failAt <= shape.commits; failAt++) {
    const { harness, rawVfs, vfs } = openVfs();
    const contents = seedContents(vfs);

    let commits = 0;
    const realExec = rawVfs.executeTransactionPlan.bind(rawVfs);
    rawVfs.executeTransactionPlan = (plan, execution) => {
      if (++commits === failAt) throw new Error('injected: storage unavailable');
      return realExec(plan, execution);
    };
    let threw = null;
    try {
      vfs.rename('extract/proteus', 'src/proteus');
    } catch (e) {
      threw = e;
    } finally {
      rawVfs.executeTransactionPlan = realExec;
    }
    assert.ok(threw, `commit ${failAt}: the interrupted move reports its failure`);

    // The invariant: read every file back from wherever it now lives.
    const reconstructed = reopenVfs(harness);
    for (const [path, body] of contents) {
      const moved = path.replace('extract/proteus', 'src/proteus');
      const at = reconstructed.exists(path) ? path : reconstructed.exists(moved) ? moved : null;
      assert.ok(at, `commit ${failAt}: ${path} is at neither path`);
      assert.equal(reconstructed.readFileString(at), body, `commit ${failAt}: ${at} kept its content`);
    }

    // Which regime this was is decided by whether publication finished, not
    // by whether the source root happens to still be there: retirement is
    // deepest-first, so the source root outlives most of its own subtree.
    const destinationComplete = reconstructed.exists('src/proteus')
      && treeShape(reconstructed, 'src/proteus').length === shape.before.length;

    if (destinationComplete) {
      // Retirement was interrupted: the destination is already whole, and the
      // residue is a partial source the caller's cleanup removes.
      completed++;
      assert.deepEqual(
        treeShape(reconstructed, 'src/proteus'), shape.before,
        `commit ${failAt}: the destination is complete`,
      );
    } else {
      // Publication failed and was unwound: the pre-move state is restored,
      // and a retry behaves exactly like a move that was never interrupted.
      unwound++;
      assert.deepEqual(
        treeShape(reconstructed, 'extract/proteus'), shape.before,
        `commit ${failAt}: the source survives whole`,
      );
      assert.equal(
        reconstructed.exists('src/proteus'), false,
        `commit ${failAt}: a failed publication leaves no partial destination`,
      );
      reconstructed.rename('extract/proteus', 'src/proteus');
      assert.deepEqual(
        treeShape(reconstructed, 'src/proteus'), shape.before,
        `commit ${failAt}: the retry completes`,
      );
      assert.equal(reconstructed.exists('extract/proteus'), false);
    }
    assert.equal(rawVfs._verifyCounters(), null, `commit ${failAt}: counters stay consistent`);
  }
  assert.ok(unwound > 0, 'the sweep must cover a failure during publication');
  assert.ok(completed > 0, 'the sweep must cover a failure during retirement');
}

// ── Every rename guarantee the single transaction gave, still given ───────
{
  const { vfs } = openVfs();
  vfs.writeFile('a.txt', 'A');
  vfs.writeFile('b.txt', 'B');
  vfs.rename('a.txt', 'b.txt');
  assert.equal(vfs.readFileString('b.txt'), 'A', 'rename overwrites the destination file');
  assert.equal(vfs.exists('a.txt'), false);
}
{
  const { vfs } = openVfs();
  vfs.mkdir('d/inner', { recursive: true });
  assert.throws(() => vfs.rename('d', 'd/inner/self'), /EINVAL/, 'no move inside itself');
}
{
  const { vfs } = openVfs();
  vfs.mkdir('src/x', { recursive: true });
  vfs.mkdir('dst', { recursive: true });
  vfs.writeFile('dst/occupied', 'x');
  assert.throws(() => vfs.rename('src', 'dst'), /EISDIR|ENOTEMPTY|ENOTDIR/);
}
{
  const { vfs } = openVfs();
  assert.throws(() => vfs.rename('nothing', 'somewhere'), /ENOENT/);
}
// A symlink moves as the link; the target is untouched.
{
  const { harness, vfs } = openVfs();
  vfs.mkdir('target', { recursive: true });
  vfs.writeFile('target/kept.txt', 'x');
  vfs.symlink('target', 'link');
  vfs.rename('link', 'moved-link');
  const reconstructed = reopenVfs(harness);
  assert.equal(reconstructed.isSymlink('moved-link'), true);
  assert.equal(reconstructed.readFileString('target/kept.txt'), 'x');
}

// ── Superseded content is still collected ────────────────────────────────
// Overwriting a file by moving onto it orphans the old content, which must
// still become collectable — a destination-first move must not lose that.
{
  const { harness, rawVfs, vfs } = openVfs();
  vfs.writeFile('new.txt', 'NEW');
  vfs.writeFile('old.txt', 'OLD-CONTENT-TO-COLLECT');
  vfs.rename('new.txt', 'old.txt');
  rawVfs.runContentMaintenance(8);
  const orphaned = harness.sql
    .exec('SELECT content_id FROM file_chunks')
    .map((r) => r.content_id);
  const live = new Set(
    harness.sql
      .exec("SELECT content_id FROM inodes WHERE kind != 1 AND content_id IS NOT NULL")
      .map((r) => r.content_id),
  );
  for (const id of orphaned) {
    assert.ok(live.has(id), `content ${id} outlived every inode referencing it`);
  }
  assert.equal(rawVfs._verifyCounters(), null);
}

console.log('sqlite-vfs-rename-bounded: ok');
