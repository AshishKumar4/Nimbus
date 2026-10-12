// @serial
// @tier slow — actual JSPI guest, SQLite actor and supervisor RPC boundary in workerd.
import assert from 'node:assert/strict';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const probe = await startLocalProbe({ runtimes: ['git'] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const made = await terminal.run('mkdir -p tree && git -C tree init -q && for i in $(seq 0 39); do mkdir -p tree/d$i && echo content > tree/d$i/file.txt; done && git -C tree add . && git -C tree -c user.name=Reader -c user.email=reader@example.com commit -qm seed', 120000);
    assert.equal(made.status, 0, made.stdout);
    assert.equal((await terminal.run('nimbus install git', 120000)).status, 0);
    const statusOf = async () => {
      // Real git (its environment's marker), not the built-in git the front door would route status to.
      const run = await terminal.run('NIMBUS_GIT_WASI=1 NIMBUS_WASI_FS_STATS=1 git -C tree status --porcelain', 120000);
      assert.equal(run.status, 0, run.stdout);
      const line = run.stdout.split('\n').find((value) => value.includes('[wasi-fs] git '));
      assert.ok(line, run.stdout);
      const porcelain = run.stdout.split('\n').filter((value) => value !== '' && !value.includes('[wasi-fs] git '));
      return { porcelain, stats: JSON.parse(line.slice(line.indexOf('[wasi-fs] git ') + '[wasi-fs] git '.length)) };
    };
    const { porcelain: clean, stats } = await statusOf();
    console.log(JSON.stringify({ stats }));
    assert.deepEqual(clean, [], 'a clean tree');
    assert.ok(stats.delegated.readDirectories > 0, 'directory opens use the generic bounded operation');
    assert.ok(stats.client.readLeases > 0, 'the guest holds actual authority read delegations');
    assert.ok((stats.delegated.open ?? 0) < 20, 'walking forty directories does not open each one through RPC');
    assert.ok((stats.delegated.fstat ?? 0) < 20, 'directory fstat is answered from the admitted namespace');
    assert.ok(stats.delegated.readDirectories <= 4, `forty directories, opened in walk order, take a few batches: ${stats.delegated.readDirectories}`);
    assert.ok(stats.lookups + stats.treeListings <= 8, `the index's forty files are stat'ed from one listing of the tree: ${stats.lookups} lookups, ${stats.treeListings} tree listings`);
    assert.equal(stats.delegated.access ?? 0, 0, 'access(2) of a configuration file is answered from the namespace');

    // The next git continues the store the last one left: one barrier brings
    // it forward, and nothing it read is read again. (The first status wrote
    // the index it refreshed, which the second reads anew; the third finds
    // nothing changed.)
    assert.deepEqual((await statusOf()).porcelain, []);
    const again = await statusOf();
    console.log(JSON.stringify({ again: again.stats }));
    assert.deepEqual(again.porcelain, [], 'still clean');
    assert.equal(again.stats.lookups + again.stats.listings + again.stats.treeListings, 0, 'no name is looked up or listed again');
    assert.ok(again.stats.barriers >= 1, 'the kept store is brought forward by a barrier');

    // What changed between two gits is what the second one reads.
    assert.equal((await terminal.run('echo changed > tree/d3/file.txt && mkdir tree/fresh && echo new > tree/fresh/n.txt && rm -r tree/d7')).status, 0);
    const changed = await statusOf();
    assert.deepEqual(changed.porcelain.sort(), [' D d7/file.txt', ' M d3/file.txt', '?? fresh/'], 'a kept store sees the writes, the new directory and the removal');
  } finally { await terminal.close(); }
} finally { await probe.stop(); }
console.log('wasi-directory-locality-workerd: real directory descriptions under read delegations');
