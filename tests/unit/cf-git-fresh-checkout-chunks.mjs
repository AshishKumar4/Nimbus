#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
} from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const repoRoot = resolve(import.meta.dirname, '../..');
const sourcePath = resolve(
  process.env.CF_GIT_SOURCE ||
    join(repoRoot, 'packages/worker/node_modules/isomorphic-git/index.js'),
);
const git = await import(`${pathToFileURL(sourcePath).href}?fresh-checkout=${Date.now()}`);

assert.equal(
  typeof git.checkoutFreshChunk,
  'function',
  'cf-git must export checkoutFreshChunk',
);

async function writeTree(dir, entries) {
  const tree = [];
  for (const entry of entries) {
    if (entry.entries) {
      tree.push({
        mode: '040000',
        path: entry.path,
        type: 'tree',
        oid: await writeTree(dir, entry.entries),
      });
      continue;
    }
    const content = Buffer.from(entry.content);
    tree.push({
      mode: entry.mode || '100644',
      path: entry.path,
      type: entry.mode === '160000' ? 'commit' : 'blob',
      oid: entry.oid || await git.writeBlob({ fs, dir, blob: content }),
    });
  }
  return git.writeTree({ fs, dir, tree });
}

async function createRepository(root, entries) {
  await git.init({ fs, dir: root, defaultBranch: 'main' });
  const tree = await writeTree(root, entries);
  const commit = await git.writeCommit({
    fs,
    dir: root,
    commit: {
      tree,
      parent: [],
      author: { name: 'Nimbus', email: 'nimbus@example.com', timestamp: 1, timezoneOffset: 0 },
      committer: { name: 'Nimbus', email: 'nimbus@example.com', timestamp: 1, timezoneOffset: 0 },
      message: 'fixture\n',
    },
  });
  await git.writeRef({ fs, dir: root, ref: 'refs/heads/main', value: commit, force: true });
  return { commit, tree };
}

async function worktreeFiles(root, relative = '') {
  const result = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    if (!relative && entry.name === '.git') continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await worktreeFiles(root, path));
    else result.push(path);
  }
  return result.sort();
}

async function worktreeManifest(root, relative = '') {
  const result = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    if (!relative && entry.name === '.git') continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = join(root, path);
    const stats = await lstat(absolute);
    if (stats.isDirectory()) {
      result.push({ path, kind: 'dir' });
      result.push(...await worktreeManifest(root, path));
    } else if (stats.isSymbolicLink()) {
      result.push({ path, kind: 'symlink', target: await readlink(absolute) });
    } else {
      result.push({
        path,
        kind: 'file',
        executable: (stats.mode & 0o111) !== 0,
        content: await readFile(absolute, 'utf8'),
      });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function indexManifest(root) {
  return git.walk({
    fs,
    dir: root,
    trees: [git.STAGE()],
    map: async (path, [entry]) => path === '.' || !entry
      ? undefined
      : { path, mode: await entry.mode(), oid: await entry.oid() },
    reduce: async (parent, children) => [parent, ...children.flat()].filter(Boolean),
  });
}

async function checkoutInChunks(root, {
  coldCache,
  checkoutFs = fs,
  maxEntries = 7,
  maxDecodedBytes = 31,
}) {
  let cursor = null;
  const cache = {};
  const chunks = [];
  do {
    const result = await git.checkoutFreshChunk({
      fs: checkoutFs,
      cache: coldCache ? {} : cache,
      dir: root,
      cursor,
      maxEntries,
      maxDecodedBytes,
      maxWallMs: 60_000,
    });
    chunks.push(result);
    cursor = result.nextCursor === null
      ? null
      : JSON.parse(JSON.stringify(result.nextCursor));
  } while (cursor !== null);
  return chunks;
}

function countingCheckoutFs() {
  const counts = { indexReads: 0, packIndexReads: 0, packReads: 0 };
  let indexStatSequence = 0;
  const promises = Object.create(fs.promises);
  promises.readFile = async function(path, ...args) {
    if (typeof path === 'string') {
      if (path.endsWith('/.git/index')) counts.indexReads++;
      else if (path.endsWith('.idx')) counts.packIndexReads++;
      else if (path.endsWith('.pack')) counts.packReads++;
    }
    return fs.promises.readFile(path, ...args);
  };
  promises.lstat = async function(path, ...args) {
    const stats = await fs.promises.lstat(path, ...args);
    if (typeof path !== 'string' || !path.endsWith('/.git/index')) return stats;
    const ino = Number(stats.ino) + ++indexStatSequence;
    return new Proxy(stats, {
      get(target, property, receiver) {
        return property === 'ino' ? ino : Reflect.get(target, property, receiver);
      },
    });
  };
  return { fs: { ...fs, promises }, counts };
}

function randomizedEntries() {
  let state = 0x5eed1234;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const directories = Array.from({ length: 6 }, (_, directory) => ({
    path: `dir-${directory}`,
    entries: Array.from({ length: 9 }, (_, file) => ({
      path: `file-${String(file).padStart(2, '0')}.txt`,
      content: `${next().toString(16)}-${directory}-${file}`,
      mode: next() % 5 === 0 ? '100755' : '100644',
    })),
  }));
  directories[2].entries.push({
    path: 'nested',
    entries: [
      { path: 'deep-a.txt', content: 'deep-a' },
      { path: 'deep-b.txt', content: 'deep-b' },
    ],
  });
  directories.push({ path: 'link', mode: '120000', content: 'dir-2/file-00.txt' });
  directories.push({
    path: 'submodule',
    mode: '160000',
    content: '',
    oid: 'a'.repeat(40),
  });
  return directories;
}

function injectedFs({
  failPath,
  method = 'writeFile',
  afterWrite = false,
  forceLooseMiss = false,
}) {
  const promises = Object.create(fs.promises);
  if (forceLooseMiss) {
    promises.readFile = async function(path, ...args) {
      if (typeof path === 'string' && /\.git\/objects\/[0-9a-f]{2}\//.test(path)) {
        const error = new Error(`ENOENT: ${path}`);
        error.code = 'ENOENT';
        throw error;
      }
      return fs.promises.readFile(path, ...args);
    };
  }
  promises[method] = async function(path, ...args) {
    if (typeof path === 'string' && path.endsWith(failPath)) {
      if (method === 'writeFile' && afterWrite) {
        await fs.promises.writeFile(path, ...args);
      }
      throw new Error(`injected ${method} failure: ${failPath}`);
    }
    return fs.promises[method](path, ...args);
  };
  return {
    ...fs,
    promises,
  };
}

const temp = await mkdtemp(join(os.tmpdir(), 'nimbus-cf-git-chunks-'));
try {
  const root = join(temp, 'repo');
  const largeDirectory = Array.from({ length: 11 }, (_, index) => ({
    path: `file-${String(index).padStart(2, '0')}.txt`,
    content: `large-${index}`,
  }));
  const entries = [
    { path: 'before.txt', content: 'before' },
    { path: 'large', entries: largeDirectory },
    {
      path: 'nested',
      entries: [
        { path: 'a.txt', content: 'a' },
        { path: 'deeper', entries: [{ path: 'b.txt', content: 'b' }] },
      ],
    },
    { path: 'z.txt', content: 'z' },
  ];
  const { tree } = await createRepository(root, entries);

  let cursor = null;
  const chunks = [];
  do {
    const result = await git.checkoutFreshChunk({
      fs,
      cache: {},
      dir: root,
      ref: 'HEAD',
      cursor,
      maxEntries: 4,
      maxDecodedBytes: 1024,
      maxWallMs: 60_000,
    });
    chunks.push(result);
    cursor = result.nextCursor === null
      ? null
      : JSON.parse(JSON.stringify(result.nextCursor));
  } while (cursor !== null);

  assert.equal(chunks[0].nextCursor.tree, tree);
  assert.deepEqual(
    chunks[0].nextCursor.directories,
    ['large'],
    'continuation cursor did not carry the directory created by its committed chunk',
  );
  assert.ok(
    chunks.every((chunk, index) => chunk.nextCursor === null ||
      chunk.nextCursor.directories.length >= (chunks[index - 1]?.nextCursor?.directories.length || 0)),
    'continuation cursor lost previously committed directory knowledge',
  );
  assert.ok(
    chunks.some(chunk => chunk.nextCursor?.stack.some(
      frame => frame.path === 'large' && frame.nextChildIndex > 0,
    )),
    'cursor never stopped inside the large directory',
  );
  assert.ok(
    chunks.some(chunk => chunk.nextCursor?.stack.some(
      frame => frame.path === 'nested/deeper',
    )),
    'cursor never crossed a nested tree frame',
  );
  assert.deepEqual(
    await worktreeFiles(root),
    [
      'before.txt',
      ...largeDirectory.map(entry => `large/${entry.path}`),
      'nested/a.txt',
      'nested/deeper/b.txt',
      'z.txt',
    ].sort(),
  );
  assert.equal(await readFile(join(root, 'large/file-10.txt'), 'utf8'), 'large-10');
  assert.deepEqual(await git.listFiles({ fs, dir: root }), await worktreeFiles(root));
  assert.ok((await stat(join(root, 'large'))).isDirectory());
  await assert.rejects(
    () => git.checkoutFreshChunk({
      fs,
      dir: root,
      cursor: { ...chunks[0].nextCursor, tree: '0'.repeat(40) },
      maxEntries: 4,
      maxDecodedBytes: 1024,
      maxWallMs: 60_000,
    }),
    /cursor does not match the resolved tree/,
  );
  const invalidFrameCursor = structuredClone(chunks[0].nextCursor);
  invalidFrameCursor.stack.at(-1).path = 'unrelated';
  await assert.rejects(
    () => git.checkoutFreshChunk({
      fs,
      dir: root,
      cursor: invalidFrameCursor,
      maxEntries: 4,
      maxDecodedBytes: 1024,
      maxWallMs: 60_000,
    }),
    /does not match its parent tree/,
  );
  await assert.rejects(
    () => git.checkoutFreshChunk({
      fs,
      dir: root,
      cursor: {
        ...chunks[0].nextCursor,
        directories: Array.from({ length: 20_001 }, (_, index) => `dir-${index}`),
      },
      maxEntries: 4,
      maxDecodedBytes: 1024,
      maxWallMs: 60_000,
    }),
    (error) => error?.code === 'FreshCheckoutDirectoryLimitError' &&
      error.data?.directories === 20_001 &&
      error.data?.maxDirectories === 20_000,
    'directory-count overflow did not fail with the typed resource limit',
  );
  await assert.rejects(
    () => git.checkoutFreshChunk({
      fs,
      dir: root,
      cursor: {
        ...chunks[0].nextCursor,
        directories: Array.from({ length: 1_500 }, (_, index) =>
          `dir-${index}-`.padEnd(3_000, 'x')),
      },
      maxEntries: 4,
      maxDecodedBytes: 1024,
      maxWallMs: 60_000,
    }),
    (error) => error?.code === 'FreshCheckoutDirectoryLimitError' &&
      error.data?.directoryBytes > error.data?.maxDirectoryBytes,
    'directory-byte overflow did not fail with the typed resource limit',
  );

  const wallRoot = join(temp, 'wall-bound');
  await createRepository(wallRoot, [
    { path: 'a.txt', content: 'a' },
    { path: 'b.txt', content: 'b' },
    { path: 'c.txt', content: 'c' },
  ]);
  const originalNow = Date.now;
  let artificialNow = 0;
  let wallChunk;
  try {
    Date.now = () => artificialNow++ * 10;
    wallChunk = await git.checkoutFreshChunk({
      fs,
      dir: wallRoot,
      maxEntries: 100,
      maxDecodedBytes: 1024,
      maxWallMs: 1,
    });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(wallChunk.treeEntriesVisited, 1);
  assert.notEqual(wallChunk.nextCursor, null, 'wall bound did not return a continuation');
  await checkoutInChunks(wallRoot, { coldCache: true });
  assert.deepEqual(await worktreeFiles(wallRoot), ['a.txt', 'b.txt', 'c.txt']);

  const fixtureEntries = randomizedEntries();
  const warmRoot = join(temp, 'warm');
  const coldRoot = join(temp, 'cold');
  const oneShotRoot = join(temp, 'one-shot');
  const nativeRoot = join(temp, 'native');
  await createRepository(warmRoot, fixtureEntries);
  await createRepository(coldRoot, fixtureEntries);
  await createRepository(oneShotRoot, fixtureEntries);
  await createRepository(nativeRoot, fixtureEntries);

  const warmChunks = await checkoutInChunks(warmRoot, { coldCache: false });
  const coldChunks = await checkoutInChunks(coldRoot, { coldCache: true });
  await git.checkout({ fs, dir: oneShotRoot, ref: 'HEAD', noUpdateHead: true, force: true });
  await execFile('git', ['-C', nativeRoot, 'config', 'core.symlinks', 'true']);
  await execFile('git', ['-C', nativeRoot, 'checkout', '--force', 'HEAD']);

  assert.ok(warmChunks.length > 3);
  assert.ok(warmChunks.every(chunk => chunk.treeEntriesVisited <= 7));
  assert.ok(warmChunks.every(chunk => chunk.decodedBytes <= 31));
  assert.deepEqual(await worktreeManifest(warmRoot), await worktreeManifest(oneShotRoot));
  assert.deepEqual(await worktreeManifest(coldRoot), await worktreeManifest(oneShotRoot));
  assert.deepEqual(await worktreeManifest(warmRoot), await worktreeManifest(nativeRoot));
  assert.deepEqual(await indexManifest(warmRoot), await indexManifest(oneShotRoot));
  assert.deepEqual(await indexManifest(coldRoot), await indexManifest(oneShotRoot));
  assert.deepEqual(await indexManifest(warmRoot), await indexManifest(nativeRoot));
  assert.equal((await lstat(join(warmRoot, 'dir-0/file-00.txt'))).mode & 0o111, 0o111);
  assert.equal(await readlink(join(warmRoot, 'link')), 'dir-2/file-00.txt');
  assert.ok((await lstat(join(warmRoot, 'submodule'))).isDirectory());
  assert.deepEqual(
    (await indexManifest(warmRoot)).find(entry => entry.path === 'submodule'),
    { path: 'submodule', mode: 0o160000, oid: 'a'.repeat(40) },
  );
  assert.equal(
    warmChunks.reduce((total, chunk) => total + chunk.treeEntriesVisited, 0),
    coldChunks.reduce((total, chunk) => total + chunk.treeEntriesVisited, 0),
  );

  const warmCacheRoot = join(temp, 'warm-cache-counts');
  const coldCacheRoot = join(temp, 'cold-cache-counts');
  await createRepository(warmCacheRoot, fixtureEntries);
  await createRepository(coldCacheRoot, fixtureEntries);
  await execFile('git', ['-C', warmCacheRoot, 'gc', '--prune=now']);
  await execFile('git', ['-C', coldCacheRoot, 'gc', '--prune=now']);
  const warmCounting = countingCheckoutFs();
  const countedWarmChunks = await checkoutInChunks(warmCacheRoot, {
    coldCache: false,
    checkoutFs: warmCounting.fs,
  });
  assert.equal(warmCounting.counts.indexReads, 1,
    'warm continuation reparsed the cumulative Git index');
  assert.equal(warmCounting.counts.packIndexReads, 1,
    'warm continuation reparsed the pack index');
  assert.equal(warmCounting.counts.packReads, 1,
    'warm continuation reloaded the pack');

  const coldCounting = countingCheckoutFs();
  const countedColdChunks = await checkoutInChunks(coldCacheRoot, {
    coldCache: true,
    checkoutFs: coldCounting.fs,
  });
  assert.equal(coldCounting.counts.indexReads, countedColdChunks.length,
    'each cold continuation must parse the durable Git index exactly once');
  assert.equal(coldCounting.counts.packIndexReads, countedColdChunks.length,
    'each cold continuation must parse the pack index exactly once');
  assert.equal(coldCounting.counts.packReads, countedColdChunks.length,
    'each cold continuation must load the pack exactly once');
  assert.equal(countedWarmChunks.length, countedColdChunks.length);

  const oversizedRoot = join(temp, 'oversized');
  await createRepository(oversizedRoot, [{ path: 'too-big.bin', content: 'x'.repeat(32) }]);
  await assert.rejects(
    () => git.checkoutFreshChunk({
      fs,
      dir: oversizedRoot,
      maxEntries: 10,
      maxDecodedBytes: 16,
      maxWallMs: 60_000,
    }),
    (error) => error?.code === 'FreshCheckoutResourceLimitError' &&
      error.data?.filepath === 'too-big.bin' &&
      error.data?.decodedBytes === 32 &&
      error.data?.maxDecodedBytes === 16,
  );

  for (const failure of [
    { name: 'object read', path: '.git/index', method: 'readFile' },
    {
      name: 'pack listing read',
      path: '.git/objects/pack',
      method: 'readdir',
      forceLooseMiss: true,
    },
    { name: 'worktree write', path: 'file-00.txt', method: 'writeFile' },
    { name: 'worktree lstat', path: 'file-00.txt', method: 'lstat' },
    { name: 'index write before commit', path: '.git/index', method: 'writeFile' },
    { name: 'index write after commit', path: '.git/index', method: 'writeFile', afterWrite: true },
  ]) {
    const replayRoot = join(temp, failure.name.replaceAll(' ', '-'));
    await createRepository(replayRoot, fixtureEntries);
    const args = {
      dir: replayRoot,
      cursor: null,
      maxEntries: 7,
      maxDecodedBytes: 1024,
      maxWallMs: 60_000,
    };
    await assert.rejects(
      () => git.checkoutFreshChunk({
        ...args,
        fs: injectedFs({
          failPath: failure.path,
          method: failure.method,
          afterWrite: failure.afterWrite,
          forceLooseMiss: failure.forceLooseMiss,
        }),
      }),
      new RegExp(
        `injected ${failure.method} failure: ${failure.path.replace(/[./]/g, '\\$&')}`,
      ),
      `${failure.name} was swallowed`,
    );
    let cursor = null;
    do {
      const result = await git.checkoutFreshChunk({ ...args, fs, cursor });
      cursor = result.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(
      await worktreeManifest(replayRoot),
      await worktreeManifest(oneShotRoot),
      `${failure.name} replay omitted a path`,
    );
    assert.deepEqual(await indexManifest(replayRoot), await indexManifest(oneShotRoot));
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log('cf-git fresh checkout chunks: ok');
