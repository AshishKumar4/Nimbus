#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { once } from 'node:events';
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
import { decodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';
import { resolvePackageDir } from '../../packages/worker/scripts/resolve-package-dir.mjs';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(import.meta.dirname, '../..');
const cfGitSource = resolve(
  process.env.CF_GIT_SOURCE ||
    join(resolvePackageDir('isomorphic-git', { start: join(repoRoot, 'packages/worker') }), 'index.js'),
);
const git = await import(`${pathToFileURL(cfGitSource).href}?facet-perf=${Date.now()}`);
const temp = await mkdtemp(join(os.tmpdir(), 'nimbus-git-facet-perf-'));

async function createLargePackedRepository(root) {
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  const importer = spawn('git', ['-C', root, 'fast-import', '--quiet'], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const errors = [];
  importer.stderr.on('data', chunk => errors.push(chunk));
  const message = 'large fixture\n';
  let input =
    'commit refs/heads/main\n' +
    'author Nimbus <nimbus@example.com> 1 +0000\n' +
    'committer Nimbus <nimbus@example.com> 1 +0000\n' +
    `data ${Buffer.byteLength(message)}\n${message}`;
  const appendFile = (path, index) => {
    const content = `unique packed blob ${String(index).padStart(5, '0')} ` +
      `${(Math.imul(index + 1, 2654435761) >>> 0).toString(16)}\n`;
    input += `M 100644 inline ${path}\ndata ${Buffer.byteLength(content)}\n${content}`;
  };
  for (let index = 0; index < 60_000; index++) {
    appendFile(`huge/huge-${String(index).padStart(5, '0')}.txt`, index);
    if (input.length >= 1024 * 1024) {
      if (!importer.stdin.write(input)) await once(importer.stdin, 'drain');
      input = '';
    }
  }
  importer.stdin.end(`${input}\ndone\n`);
  const [exitCode] = await once(importer, 'close');
  assert.equal(exitCode, 0, Buffer.concat(errors).toString());
  await execFile('git', ['-C', root, 'gc', '--prune=now']);
  const commit = await git.resolveRef({ fs, dir: root, ref: 'HEAD' });
  const { commit: parsedCommit } = await git.readCommit({ fs, dir: root, oid: commit });
  const tree = parsedCommit.tree;
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
const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

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
            maxEntries: 1_000,
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
  assert.equal(first.treeEntriesVisited, 1_000,
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
  assert.equal(cold.treeEntriesVisited, 1_000);
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
  assert.equal(coldReads.filter(path => path === `${gitdir}/index`).length, 0,
    'cold real continuation read the cumulative Git index');
  assert.equal(coldReads.filter(path => path === idxPath).length, 1,
    'cold real continuation did not parse the pack index exactly once');
  assert.equal(coldReads.filter(path => path === packPath).length, 1,
    'cold real continuation did not load the pack exactly once');

  let cursor = firstCursor;
  while (cursor !== null) {
    const invocation = `large-chunk-${chunks.length + 1}`;
    const priorCursor = cursor;
    const result = await checkout(cursor, invocation);
    assert.equal(result.success, true, result.error);
    assert.equal(result.diagnostic.cold, false,
      'latency-modeled continuation lost live module job state');
    if (result.nextCursor !== null) {
      assert.ok(result.statDelta + result.lstatDelta <= 2,
        'latency-modeled chunk performed per-entry supervisor stat/lstat RPCs');
    } else {
      assert.equal(
        result.statDelta + result.lstatDelta,
        priorCursor.indexChunks,
        'final checkout did not read each durable index fragment exactly once',
      );
    }
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
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.treeEntriesVisited === 1_000),
    'a non-final real chunk stopped before the entry bound');
  assert.equal(
    chunks.reduce((total, chunk) => total + chunk.treeEntriesVisited, 0),
    60_001,
  );
  const fullChunks = chunks.filter(chunk => chunk.treeEntriesVisited === 1_000);
  assert.ok(fullChunks.length >= 6, 'fixture did not produce six equal checkout chunks');
  // Every full chunk visits the same 1,000 tree entries, so the work it does must
  // not grow with how deep into the checkout it is — that is what catches a
  // per-chunk cost scaling with the cumulative set (a re-walk, a re-parse, a cache
  // that stops hitting). Assert it on the operation counters this harness already
  // collects, NOT on `measuredWallMs`.
  //
  // The wall-clock form this replaces compared later-window median elapsed against
  // the first window's with a 15% bound. `measuredWallMs` is `performance.now()` on
  // the host, so it measured the machine rather than the checkout: on a busy box the
  // later windows drift past the bound and the unit suite goes red with no defect
  // present. It failed exactly that way — and because CI runs the unit loop with
  // `|| exit 1` ahead of the behavioral step, one such failure took the entire
  // behavioral gate down with it. These counters are deterministic, so the same 15%
  // margin is generous headroom instead of a coin flip.
  const perChunkCounters = [
    ['readDelta', 'file reads'],
    ['statDelta', 'stat calls'],
    ['lstatDelta', 'lstat calls'],
    ['rangeDelta', 'range reads'],
    ['waveDelta', 'W7 write waves'],
  ];
  for (const [key, label] of perChunkCounters) {
    const baseline = median(fullChunks.slice(1, 6).map(chunk => chunk[key]));
    for (let offset = 6; offset + 5 <= fullChunks.length; offset += 5) {
      const windowMedian = median(fullChunks.slice(offset, offset + 5).map(chunk => chunk[key]));
      assert.ok(
        windowMedian <= Math.max(baseline * 1.15, baseline + 1),
        `chunks ${offset + 1}-${offset + 5} median ${label} ${windowMedian} exceeded ` +
          `chunks 2-6 median ${baseline} — per-chunk work grows with checkout depth`,
      );
    }
  }
  assert.equal(calls.readFile.filter(path => path === idxPath).length, 2,
    'warm real chunks reparsed the pack index outside the forced-cold resume');
  assert.equal(calls.readFile.filter(path => path === packPath).length, 2,
    'warm real chunks reloaded the pack outside the forced-cold resume');
  assert.equal(calls.readFile.filter(path => path === `${gitdir}/index`).length, 0,
    'checkout read the cumulative Git index');
  assert.ok(calls.writeBatchStream < 1_400,
    'supervisor writes scaled per entry instead of by bounded W7 waves');
  assert.equal(durable.has(markerPath), false, 'completed real checkout left its job marker');
  assert.equal(
    [...durable.keys()].some(path => path.startsWith(`${gitdir}/nimbus-checkout-index`)),
    false,
    'completed real checkout left index fragments behind',
  );
  assert.equal(durable.has(`${root}/huge/huge-59999.txt`), true);

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
