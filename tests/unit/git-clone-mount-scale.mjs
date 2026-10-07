#!/usr/bin/env bun
// @tier slow — a measurement: a depth-1 clone of a generated repository of
// vscode's shape at a tenth of its size (2,000 files in nested directories,
// about 40 MiB, eight files over a wave's 4 MiB mount limit), into the
// session's own filesystem and onto a SqliteFiles mount on its own
// database, in one session each. Both match host git (worktree, index);
// the wall time and the session calls each made are printed side by side.

import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn } from './lib/facet-session.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-clone-mount-scale-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);

/** A worktree as a sorted list of paths and sizes. */
function worktreeOf(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (rel === '' && name === '.git') continue;
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, path));
      if (st.isDirectory()) walk(path);
      else out.push([path, st.size]);
    }
  };
  walk('');
  return out;
}

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  let bytes = 0;
  for (let i = 0; i < 2000; i++) {
    const path = join(source, `src/vs/m${i % 40}/p${i % 7}/f${i}.ts`);
    mkdirSync(join(path, '..'), { recursive: true });
    const text = `export const v${i} = ${i};\n`.repeat(400 + (i % 600));
    writeFileSync(path, text);
    bytes += text.length;
  }
  for (let i = 0; i < 8; i++) {
    const big = new Uint8Array(4.5 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 65536) crypto.getRandomValues(big.subarray(at, at + 65536));
    mkdirSync(join(source, 'resources'), { recursive: true });
    writeFileSync(join(source, `resources/big${i}.bin`), big);
    bytes += big.length;
  }
  hostGit(source, ['add', '-A']);
  hostGit(source, ['commit', '-q', '-m', 'one']);
  const served = join(work, 'served');
  mkdirSync(served);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowFilter', 'true']);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const server = startGitHttpServer(served);
  const host = join(work, 'host');
  hostGit(work, ['clone', '-q', '--depth', '1', 'file://' + join(served, 'repo.git'), host]);
  try {
    const rows = [];
    for (const where of ['sqlite', 'mount']) {
      const harness = createSqliteVfsTestHarness();
      const engine = new SqliteVFS(harness.sql, harness.ctx);
      engine.as(CRED_KERNEL).mkdir('work', { mode: 0o755 });
      engine.as(CRED_KERNEL).chown('work', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
      const session = await createFacetSession(work, where === 'mount' ? { mounts: { '/mnt/data': new SqliteFiles(engine, engine.as(CRED_KERNEL)) } } : {});
      const dest = where === 'mount' ? '/mnt/data/work/repo' : '/home/user/repo';
      const started = performance.now();
      const cloned = await session.git('/home/user', ['clone', '--depth', '1', server.url + '/repo.git', dest]);
      const wallMs = performance.now() - started;
      assert.equal(cloned.code, 0, `${where}: ${cloned.stderr}`);
      const ours = where === 'mount'
        ? await session.materializeAt(dest, join(work, 'ours-' + where))
        : session.materialize(dest.slice(1), join(work, 'ours-' + where));
      assert.deepEqual(worktreeOf(ours), worktreeOf(host), `${where}: the worktree`);
      assert.equal(hostGit(ours, ['ls-files', '-s']), hostGit(host, ['ls-files', '-s']), `${where}: the index`);
      const { requests } = session;
      rows.push({ where, wallMs: Math.round(wallMs), waves: requests.waves, rangeWrites: requests.rangeWrites.length, fileApi: requests.fileApi ?? 0, phases: requests.phases.length });
    }
    console.log(`  repository: 2,008 files, ${(bytes / 1048576).toFixed(1)} MiB, eight over 4 MiB`);
    for (const row of rows) console.log(`  ${row.where.padEnd(7)} wall ${String(row.wallMs).padStart(6)} ms  waves ${row.waves}  ranged writes ${row.rangeWrites}  file-API calls ${row.fileApi}  facet calls ${row.phases}`);
  } finally {
    server.stop();
  }
  console.log('git-clone-mount-scale: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
