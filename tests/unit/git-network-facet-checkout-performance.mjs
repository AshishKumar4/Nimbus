#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { GIT_BUNDLE_CODE } from '../../packages/worker/src/git-bundle.generated.ts';
import { decodeWriteBatchStream } from '../../packages/worker/src/_shared/w7-frame.ts';
import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(import.meta.dirname, '../..');
const cfGitSource = resolve(
  process.env.CF_GIT_SOURCE ||
    join(repoRoot, 'packages/worker/node_modules/isomorphic-git/index.js'),
);
const git = await import(`${pathToFileURL(cfGitSource).href}?facet-perf=${Date.now()}`);
const temp = await mkdtemp(join(os.tmpdir(), 'nimbus-git-facet-perf-'));

async function createLargePackedRepository(root) {
  await git.init({ fs, dir: root, defaultBranch: 'main' });
  const blob = await git.writeBlob({ fs, dir: root, blob: Buffer.from('x') });
  const fileEntries = (prefix, count) => Array.from({ length: count }, (_, index) => ({
    mode: '100644',
    path: `${prefix}-${String(index).padStart(5, '0')}.txt`,
    type: 'blob',
    oid: blob,
  }));
  const hugeTree = await git.writeTree({
    fs,
    dir: root,
    tree: fileEntries('huge', 15_000),
  });
  const nestedTrees = [];
  for (let directory = 0; directory < 15; directory++) {
    nestedTrees.push({
      mode: '040000',
      path: `nested-${String(directory).padStart(2, '0')}`,
      type: 'tree',
      oid: await git.writeTree({
        fs,
        dir: root,
        tree: fileEntries(`file-${String(directory).padStart(2, '0')}`, 1_000),
      }),
    });
  }
  const tree = await git.writeTree({
    fs,
    dir: root,
    tree: [
      { mode: '040000', path: 'huge', type: 'tree', oid: hugeTree },
      {
        mode: '040000',
        path: 'nested',
        type: 'tree',
        oid: await git.writeTree({ fs, dir: root, tree: nestedTrees }),
      },
    ],
  });
  const commit = await git.writeCommit({
    fs,
    dir: root,
    commit: {
      tree,
      parent: [],
      author: { name: 'Nimbus', email: 'nimbus@example.com', timestamp: 1, timezoneOffset: 0 },
      committer: { name: 'Nimbus', email: 'nimbus@example.com', timestamp: 1, timezoneOffset: 0 },
      message: 'large fixture\n',
    },
  });
  await git.writeRef({ fs, dir: root, ref: 'refs/heads/main', value: commit, force: true });
  await execFile('git', ['-C', root, 'gc', '--prune=now']);
  const packDir = join(root, '.git/objects/pack');
  const packName = (await readdir(packDir)).find(name => name.endsWith('.pack'));
  assert.ok(packName, 'fixture did not produce a pack');
  return {
    commit,
    tree,
    packPath: join(packDir, packName),
    idxPath: join(packDir, packName.replace(/\.pack$/, '.idx')),
    packSha: packName.slice('pack-'.length, -'.pack'.length),
  };
}

function metadataEntry(kind, size = 0, mode = kind === 'dir' ? 0o755 : 0o644) {
  return { kind, size, mode, mtimeMs: 1, ctimeMs: 1, atimeMs: 1 };
}

const SUPERVISOR_RPC_LATENCY_MS = 30;
const supervisorRpcDelay = () => new Promise(resolve =>
  setTimeout(resolve, SUPERVISOR_RPC_LATENCY_MS));

try {
  const sourceRoot = join(temp, 'source');
  const fixture = await createLargePackedRepository(sourceRoot);
  const moduleRoot = join(temp, 'facet');
  await fs.promises.mkdir(moduleRoot, { recursive: true });
  const facetSource = assembleGitNetworkFacetSource();
  await writeFile(join(moduleRoot, 'git-network-worker.mjs'), facetSource);
  await writeFile(join(moduleRoot, 'git-network-worker-cold.mjs'), facetSource);
  await writeFile(join(moduleRoot, 'git-bundle.js'), GIT_BUNDLE_CODE);
  const facet = await import(
    `${pathToFileURL(join(moduleRoot, 'git-network-worker.mjs')).href}?run=${Date.now()}`
  );

  const root = 'perf';
  const gitdir = `${root}/.git`;
  const packRoot = `${gitdir}/objects/pack`;
  const packPath = `${packRoot}/pack-${fixture.packSha}.pack`;
  const idxPath = `${packRoot}/pack-${fixture.packSha}.idx`;
  const packBytes = new Uint8Array(await readFile(fixture.packPath));
  const idxBytes = new Uint8Array(await readFile(fixture.idxPath));
  const durable = new Map();
  const putDirectory = path => durable.set(path, { kind: 'directory', mode: 0o755 });
  const putFile = (path, data, mode = 0o644, kind = 'file') => durable.set(path, {
    kind,
    mode,
    data: typeof data === 'string' ? new TextEncoder().encode(data) : data.slice(),
  });
  for (const path of [root, gitdir, `${gitdir}/objects`, packRoot,
    `${gitdir}/refs`, `${gitdir}/refs/heads`]) putDirectory(path);
  putFile(`${gitdir}/HEAD`, 'ref: refs/heads/main\n');
  putFile(`${gitdir}/refs/heads/main`, `${fixture.commit}\n`);
  putFile(packPath, packBytes);
  putFile(idxPath, idxBytes);

  const jobId = 'large-perf-job';
  const optionsHash = 'a'.repeat(64);
  const markerPath = `${gitdir}/nimbus-clone-job`;
  const marker = {
    version: 2,
    jobId,
    optionsHash,
    prepared: {
      commit: fixture.commit,
      tree: fixture.tree,
      headRef: 'refs/heads/main',
    },
    cursor: null,
    cursorSeq: 0,
  };
  putFile(markerPath, JSON.stringify(marker));
  const metadata = [
    [root, metadataEntry('dir')],
    [gitdir, metadataEntry('dir')],
    [`${gitdir}/objects`, metadataEntry('dir')],
    [packRoot, metadataEntry('dir')],
    [`${gitdir}/refs`, metadataEntry('dir')],
    [`${gitdir}/refs/heads`, metadataEntry('dir')],
    [`${gitdir}/HEAD`, metadataEntry('file', 'ref: refs/heads/main\n'.length)],
    [`${gitdir}/refs/heads/main`, metadataEntry('file', fixture.commit.length + 1)],
    [packPath, metadataEntry('file', packBytes.byteLength)],
    [idxPath, metadataEntry('file', idxBytes.byteLength)],
    [markerPath, metadataEntry('file', JSON.stringify(marker).length)],
  ];
  const prepared = {
    jobId,
    optionsHash,
    dir: root,
    commit: fixture.commit,
    tree: fixture.tree,
    headRef: 'refs/heads/main',
    packs: [{
      packPath,
      packBytes: packBytes.byteLength,
      idxPath,
      idxBytes: idxBytes.byteLength,
      packSha: fixture.packSha,
    }],
    packOnlyObjectStore: true,
    metadata,
  };

  const calls = {
    stat: [],
    lstat: [],
    readdir: [],
    readFile: [],
    fsReadRange: [],
    writeBatchStream: 0,
    stdout: 0,
  };
  const supervisor = {
    async stat(path) {
      await supervisorRpcDelay();
      calls.stat.push(path);
      const entry = durable.get(path);
      if (!entry) return null;
      return {
        type: entry.kind,
        size: entry.data?.byteLength || 0,
        mode: entry.mode,
        atime: 1,
        ctime: 1,
        mtime: 1,
      };
    },
    async lstat(path) {
      await supervisorRpcDelay();
      calls.lstat.push(path);
      const entry = durable.get(path);
      if (!entry) return null;
      return {
        type: entry.kind,
        size: entry.data?.byteLength || 0,
        mode: entry.mode,
        atime: 1,
        ctime: 1,
        mtime: 1,
      };
    },
    async readdir(path) {
      await supervisorRpcDelay();
      calls.readdir.push(path);
      const prefix = path ? `${path}/` : '';
      const children = new Map();
      for (const [candidate, entry] of durable) {
        if (!candidate.startsWith(prefix)) continue;
        const remainder = candidate.slice(prefix.length);
        if (!remainder || remainder.includes('/')) continue;
        children.set(remainder, entry);
      }
      return [...children].map(([name, entry]) => ({ name, type: entry.kind }));
    },
    async readFileBytes(path) {
      await supervisorRpcDelay();
      calls.readFile.push(path);
      return durable.get(path)?.data?.slice() || null;
    },
    async fsReadRange(path, offset, length) {
      await supervisorRpcDelay();
      calls.fsReadRange.push(path);
      return durable.get(path)?.data?.slice(offset, offset + length) || null;
    },
    async writeBatchStream(stream) {
      await supervisorRpcDelay();
      calls.writeBatchStream++;
      const decoded = await decodeWriteBatchStream(stream);
      let activeFile = null;
      let committedPathCount = 0;
      let chunks = 0;
      for await (const record of decoded.records) {
        if (record.type === 'delete') {
          for (const path of [...durable.keys()]) {
            if (path === record.path || path.startsWith(`${record.path}/`)) durable.delete(path);
          }
          committedPathCount++;
        } else if (record.type === 'directory') {
          putDirectory(record.inode.path);
          committedPathCount++;
        } else if (record.type === 'file-begin') {
          activeFile = { inode: record.inode, parts: [] };
        } else if (record.type === 'file-chunk') {
          activeFile.parts.push(record.data.slice());
          chunks++;
          record.retention.release();
        } else if (record.type === 'file-end') {
          const size = activeFile.parts.reduce((total, part) => total + part.byteLength, 0);
          const data = new Uint8Array(size);
          let offset = 0;
          for (const part of activeFile.parts) {
            data.set(part, offset);
            offset += part.byteLength;
          }
          putFile(
            activeFile.inode.path,
            data,
            activeFile.inode.mode,
            activeFile.inode.kind,
          );
          activeFile = null;
          committedPathCount++;
        }
      }
      return {
        ok: true,
        committedGroupSequence: committedPathCount,
        committedPathCount,
        inodes: committedPathCount,
        chunks,
      };
    },
    async stdout() {
      await supervisorRpcDelay();
      calls.stdout++;
    },
  };

  const checkout = async (cursor, invocation, worker = facet) => {
    const before = {
      waves: calls.writeBatchStream,
      reads: calls.readFile.length,
      stats: calls.stat.length,
      lstats: calls.lstat.length,
      ranges: calls.fsReadRange.length,
    };
    const started = performance.now();
    const response = await worker.default.fetch(
      new Request(`http://git/git/clone-checkout/${invocation}`, {
        method: 'POST',
        body: JSON.stringify({
          op: 'clone',
          dir: `/${root}`,
          exclusiveDestination: true,
          exclusiveMutationRoot: root,
          phase: 'clone-checkout',
          invocationId: invocation,
          jobId,
          optionsHash,
          prepared,
          checkoutCursor: cursor,
          checkoutBounds: {
            maxEntries: 10_000,
            maxDecodedBytes: 32 * 1024 * 1024,
            maxWallMs: 150_000,
          },
          phaseDeadline: Date.now() + 240_000,
        }),
      }),
      { SUPERVISOR: supervisor },
    );
    const result = await response.json();
    return {
      ...result,
      measuredWallMs: Math.round(performance.now() - started),
      waveDelta: calls.writeBatchStream - before.waves,
      readDelta: calls.readFile.length - before.reads,
      statDelta: calls.stat.length - before.stats,
      lstatDelta: calls.lstat.length - before.lstats,
      statPaths: calls.stat.slice(before.stats),
      lstatPaths: calls.lstat.slice(before.lstats),
      rangeDelta: calls.fsReadRange.length - before.ranges,
    };
  };

  const chunks = [];
  const first = await checkout(null, 'large-chunk-1');
  assert.equal(first.success, true, first.error);
  assert.equal(first.treeEntriesVisited, 10_000,
    'first real chunk hit its wall bound before its entry bound');
  assert.equal(first.diagnostic.cold, true,
    'first checkout without module job state did not report a cold invocation');
  chunks.push(first);
  const firstCursor = structuredClone(first.nextCursor);
  const replay = await checkout(null, 'large-chunk-1-replay');
  assert.equal(replay.success, true, replay.error);
  assert.equal(replay.diagnostic.cold, false,
    'same-module replay did not report its warm job state');
  assert.deepEqual(replay.nextCursor, firstCursor,
    'replaying the old cursor selected a different real checkout slice');

  const readsBeforeCold = calls.readFile.length;
  const coldFacet = await import(
    pathToFileURL(join(moduleRoot, 'git-network-worker-cold.mjs')).href
  );
  const cold = await checkout(firstCursor, 'large-chunk-cold-resume', coldFacet);
  assert.equal(cold.success, true, cold.error);
  assert.equal(cold.treeEntriesVisited, 10_000);
  assert.equal(cold.diagnostic.cold, true,
    'physically separate checkout module did not report a cold invocation');
  assert.ok(cold.statDelta + cold.lstatDelta <= 2,
    'cold continuation performed per-entry supervisor stat/lstat RPCs');
  assert.deepEqual(
    [...cold.statPaths, ...cold.lstatPaths].filter(path =>
      path.startsWith(`${root}/`) && !path.startsWith(`${gitdir}/`)),
    [],
    'cold continuation leaked worktree metadata lookups to the supervisor',
  );
  assert.deepEqual(
    cold.nextCursor.directories.slice(0, firstCursor.directories.length),
    firstCursor.directories,
    'cold continuation lost the committed directory prefix',
  );
  const coldReads = calls.readFile.slice(readsBeforeCold);
  assert.equal(coldReads.filter(path => path === `${gitdir}/index`).length, 1,
    'cold real continuation did not parse the durable cumulative index exactly once');
  assert.equal(coldReads.filter(path => path === idxPath).length, 1,
    'cold real continuation did not parse the pack index exactly once');
  assert.equal(coldReads.filter(path => path === packPath).length, 1,
    'cold real continuation did not load the pack exactly once');

  let cursor = firstCursor;
  while (cursor !== null) {
    const invocation = `large-chunk-${chunks.length + 1}`;
    const coldModulePath = join(moduleRoot, `git-network-worker-${invocation}.mjs`);
    await writeFile(coldModulePath, facetSource);
    const coldWorker = await import(
      pathToFileURL(coldModulePath).href
    );
    const result = await checkout(cursor, invocation, coldWorker);
    assert.equal(result.success, true, result.error);
    assert.equal(result.diagnostic.cold, true,
      'latency-modeled continuation unexpectedly reused module job state');
    assert.ok(result.statDelta + result.lstatDelta <= 2,
      'latency-modeled cold chunk performed per-entry supervisor stat/lstat RPCs');
    assert.deepEqual(
      [...result.statPaths, ...result.lstatPaths].filter(path =>
        path.startsWith(`${root}/`) && !path.startsWith(`${gitdir}/`)),
      [],
      'latency-modeled cold chunk leaked a worktree metadata lookup',
    );
    chunks.push(result);
    cursor = result.nextCursor;
  }
  assert.ok(chunks.length >= 4, 'fixture did not cross enough checkout chunks');
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.treeEntriesVisited === 10_000),
    'a non-final real chunk stopped before the entry bound');
  assert.equal(
    chunks.reduce((total, chunk) => total + chunk.treeEntriesVisited, 0),
    30_017,
  );
  assert.equal(calls.readFile.filter(path => path === idxPath).length, chunks.length + 1,
    'each physical-cold checkout did not parse its pack index exactly once');
  assert.equal(calls.readFile.filter(path => path === packPath).length, chunks.length + 1,
    'each physical-cold checkout did not load its pack exactly once');
  assert.equal(calls.readFile.filter(path => path === `${gitdir}/index`).length, chunks.length,
    'each cold continuation did not parse its cumulative Git index exactly once');
  assert.ok(calls.writeBatchStream < 700,
    'supervisor writes scaled per entry instead of by bounded W7 waves');
  assert.equal(durable.has(markerPath), false, 'completed real checkout left its job marker');
  assert.equal(durable.has(`${root}/huge/huge-14999.txt`), true);
  assert.equal(durable.has(`${root}/nested/nested-14/file-14-00999.txt`), true);

  console.log(JSON.stringify({
    chunks: chunks.map(chunk => ({
      entries: chunk.treeEntriesVisited,
      wallMs: chunk.measuredWallMs,
      waves: chunk.waveDelta,
      reads: chunk.readDelta,
      stat: chunk.statDelta,
      lstat: chunk.lstatDelta,
      ranges: chunk.rangeDelta,
      rpc: Object.values(chunk.supervisorRpc).reduce((total, count) => total + count, 0),
      cold: chunk.diagnostic.cold,
    })),
    replay: {
      entries: replay.treeEntriesVisited,
      wallMs: replay.measuredWallMs,
      waves: replay.waveDelta,
      reads: replay.readDelta,
      stat: replay.statDelta,
      lstat: replay.lstatDelta,
    },
    cold: {
      entries: cold.treeEntriesVisited,
      wallMs: cold.measuredWallMs,
      waves: cold.waveDelta,
      reads: cold.readDelta,
      stat: cold.statDelta,
      lstat: cold.lstatDelta,
    },
    supervisor: {
      stat: calls.stat.length,
      lstat: calls.lstat.length,
      readdir: calls.readdir.length,
      readFile: calls.readFile.length,
      fsReadRange: calls.fsReadRange.length,
      writeBatchStream: calls.writeBatchStream,
      stdout: calls.stdout,
    },
  }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
