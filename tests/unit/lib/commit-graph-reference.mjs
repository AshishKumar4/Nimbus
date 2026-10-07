/**
 * The reference a commit-graph writer is held to: host git 2.53's
 * `git commit-graph write --reachable --changed-paths` (commitGraph
 * .changedPathsVersion=2), byte for byte, on a fixture repository with
 * everything such a graph has to encode, and a chunk-level diff that names
 * where another writer's file first differs.
 *
 *   buildFixture(dir)      a repository, one pack: two roots, merges, an
 *                          octopus (the EDGE chunk), renames, deep paths, a
 *                          commit changing more than 512 paths (its filter
 *                          the "too large" one), an empty commit, and a
 *                          commit dated before its parent by more than 2^31
 *                          seconds (the GDO2 overflow chunk).
 *   referenceGraph(repo)   host git's graph for `repo`, written in a copy
 *                          (with changed-path filters, or without).
 *   diffGraphs(a, b)       null when equal, else what first differs: the
 *                          header, the chunk table, or a chunk, with the
 *                          commit (by graph position) where it can say.
 *
 * For the GitPackStream engine's clone-graph phase (ObnoxiousHookworm) and
 * git.wasm. Directory note: under tests/unit/lib/ so the suite does not run
 * it as a test.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IDENTITY = { GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' };
const hostEnv = (date) => ({
  ...process.env, ...IDENTITY, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  ...(date === undefined ? {} : { GIT_AUTHOR_DATE: `@${date} +0000`, GIT_COMMITTER_DATE: `@${date} +0000` }),
});
const git = (cwd, args, date) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: hostEnv(date), maxBuffer: 1 << 28 }).toString();

/** The fixture repository at `dir` (created), in one pack. */
export function buildFixture(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  let date = 1_700_000_000;
  const write = (file, text) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text); };
  const commit = (message, when = (date += 60)) => { git(dir, ['add', '-A']); git(dir, ['commit', '-q', '--allow-empty', '-m', message], when); };

  write('README.md', 'root one\n');
  commit('root one');
  for (let i = 0; i < 6; i++) { write(`src/deep/a/b/c/d/file${i % 3}.txt`, `line ${i}\n`); commit(`linear ${i}`); }
  git(dir, ['branch', 'side']);
  git(dir, ['branch', 'third']);
  write('src/main.txt', 'main\n'); commit('main work');
  git(dir, ['checkout', '-q', 'side']);
  git(dir, ['mv', 'src/deep/a/b/c/d/file0.txt', 'src/renamed.txt']); commit('rename on side');
  git(dir, ['checkout', '-q', 'third']);
  write('third.txt', 'third\n'); commit('third work');
  git(dir, ['checkout', '-q', 'main']);
  git(dir, ['merge', '-q', '--no-edit', 'side'], (date += 60));
  // An octopus: main and two branches of their own, three parents, so the
  // graph needs its EDGE chunk.
  git(dir, ['checkout', '-q', '-b', 'four', 'main']);
  write('four.txt', 'four\n'); commit('four work');
  git(dir, ['checkout', '-q', 'main']);
  write('main2.txt', 'main again\n'); commit('main again');
  git(dir, ['merge', '-q', '--no-edit', 'third', 'four'], (date += 60));
  // More than 512 changed paths: its filter is the one that says "too large".
  for (let i = 0; i < 600; i++) write(`many/f${String(i).padStart(4, '0')}.txt`, `${i}\n`);
  commit('six hundred files');
  commit('nothing changed');
  // A second root, merged in.
  git(dir, ['checkout', '-q', '--orphan', 'other']);
  git(dir, ['rm', '-rqf', '.']);
  write('other.txt', 'other root\n'); commit('root two');
  git(dir, ['checkout', '-q', 'main']);
  git(dir, ['merge', '-q', '--no-edit', '--allow-unrelated-histories', 'other'], (date += 60));
  // A commit dated far after its child: the child's corrected date offset
  // passes 2^31, which only the GDO2 overflow chunk holds.
  write('future.txt', 'future\n'); commit('from the future', 4_000_000_000);
  write('past.txt', 'past\n'); commit('from the past', 1);
  git(dir, ['repack', '-adq']);
  git(dir, ['prune-packed']);
  return dir;
}

/**
 * Host git's commit-graph for `repo`, written in a copy of it: the reference
 * bytes. `changedPaths: false` for a graph without Bloom filters, as a clone
 * writes before its filters are computed.
 */
export function referenceGraph(repo, { changedPaths = true } = {}) {
  const copy = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'commit-graph-reference-'));
  try {
    cpSync(path.join(repo, '.git'), path.join(copy, '.git'), { recursive: true });
    rmSync(path.join(copy, '.git/objects/info/commit-graph'), { force: true });
    rmSync(path.join(copy, '.git/objects/info/commit-graphs'), { recursive: true, force: true });
    git(copy, ['-c', 'commitGraph.changedPathsVersion=2', 'commit-graph', 'write', '--reachable', ...(changedPaths ? ['--changed-paths'] : [])]);
    return new Uint8Array(readFileSync(path.join(copy, '.git/objects/info/commit-graph')));
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/** A commit-graph's header and chunks: { version, hashVersion, chunks: Map<id, Uint8Array> }. */
export function parseGraph(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  if (signature !== 'CGPH') throw new Error(`not a commit-graph (signature ${JSON.stringify(signature)})`);
  const header = { version: bytes[4], hashVersion: bytes[5], chunkCount: bytes[6], baseCount: bytes[7] };
  const table = [];
  for (let i = 0; i <= header.chunkCount; i++) {
    const at = 8 + i * 12;
    table.push({ id: String.fromCharCode(...bytes.subarray(at, at + 4)), offset: Number(view.getBigUint64(at + 4)) });
  }
  const chunks = new Map();
  for (let i = 0; i < header.chunkCount; i++) chunks.set(table[i].id, bytes.subarray(table[i].offset, table[i + 1].offset));
  return { header, table: table.map((t) => t.id), chunks };
}

/** What a chunk's byte `at` belongs to, where the format says: the commit's graph position. */
function where(id, at, graph) {
  const commits = graph.chunks.get('OIDL') ? graph.chunks.get('OIDL').byteLength / 20 : 0;
  const per = { OIDL: 20, CDAT: 36, GDA2: 4, BIDX: 4 }[id];
  if (per !== undefined) return `commit ${Math.floor(at / per)} of ${commits}`;
  if (id === 'BDAT' && graph.chunks.get('BIDX')) {
    if (at < 12) return 'the BDAT header';
    const index = graph.chunks.get('BIDX');
    const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
    for (let i = 0; i < commits; i++) if (view.getUint32(i * 4) > at - 12) return `the filter of commit ${i} of ${commits}`;
  }
  return `byte ${at}`;
}

/** Null when `actual` is `expected`, byte for byte; else what first differs. */
export function diffGraphs(expected, actual) {
  if (expected.byteLength === actual.byteLength && expected.every((b, i) => b === actual[i])) return null;
  const a = parseGraph(expected);
  const b = parseGraph(actual);
  for (const key of ['version', 'hashVersion', 'chunkCount', 'baseCount']) {
    if (a.header[key] !== b.header[key]) return `header ${key}: expected ${a.header[key]}, got ${b.header[key]}`;
  }
  if (a.table.join() !== b.table.join()) return `chunk table: expected ${a.table.join(' ')}, got ${b.table.join(' ')}`;
  for (const [id, chunk] of a.chunks) {
    const other = b.chunks.get(id);
    const n = Math.min(chunk.byteLength, other.byteLength);
    for (let i = 0; i < n; i++) if (chunk[i] !== other[i]) return `chunk ${id}, ${where(id, i, a)}: expected byte ${chunk[i]}, got ${other[i]}`;
    if (chunk.byteLength !== other.byteLength) return `chunk ${id}: expected ${chunk.byteLength} bytes, got ${other.byteLength}`;
  }
  return 'the trailing checksum';
}
