#!/usr/bin/env bun
// lifo's Node `fs`, CPU per arm, on the path a require-heavy program walks:
// existsSync and statSync of candidates found and not, readFileSync of
// package.json, readdirSync of node_modules, and the same through
// fs.promises. Each arm is its side's whole tree (its fs module, its
// filesystem and SQLite VFS), a fresh filesystem each sample, so the head's
// generator operations and drivers (node-compat/drive.ts) are measured
// against the calls they replaced.
import assert from 'node:assert/strict';
import { cpuMs } from './lib/paired-cpu.mjs';
import { LIFO_SHELL_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { loadIsolatedCore } from './lib/isolated-core.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

const PACKAGES = 24;
let ran = 0;

function fsOf({
  'substrate/lifo/node-compat/fs.ts': { createFs },
  'substrate/lifo/node-compat/filesystem.ts': { synchronousFilesystem },
  'vfs/sqlite-vfs.ts': { SqliteVFS },
  'runtime/os-contracts.ts': { CRED_SESSION_USER },
  'tests/unit/lib/sqlite-vfs-test-harness.mjs': { createSqliteVfsTestHarness },
  'tests/unit/lib/process-bridge.mjs': { processBridge },
}) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const user = raw.as(CRED_SESSION_USER);
  user.mkdir('home/user/app/node_modules', { recursive: true });
  for (let i = 0; i < PACKAGES; i++) {
    user.mkdir(`home/user/app/node_modules/pkg${i}/lib`, { recursive: true });
    user.writeFile(`home/user/app/node_modules/pkg${i}/package.json`, JSON.stringify({ name: `pkg${i}`, main: 'lib/index.js' }));
    user.writeFile(`home/user/app/node_modules/pkg${i}/lib/index.js`, `module.exports = ${i};`);
  }
  const filesystem = synchronousFilesystem({ process: processBridge(raw, CRED_SESSION_USER) }, () => CRED_SESSION_USER.umask)();
  return createFs(filesystem, '/home/user/app');
}

const WORK = {
  sync(fs, n) {
    for (let i = 0; i < n; i++) {
      const pkg = `node_modules/pkg${i % PACKAGES}`;
      if (!fs.existsSync(`${pkg}/package.json`)) throw new Error('missing package');
      JSON.parse(fs.readFileSync(`${pkg}/package.json`, 'utf8'));
      for (const candidate of ['lib/index.js.ts', 'lib/index.js.mjs', 'lib/index.js']) {
        try {
          if (fs.statSync(`${pkg}/${candidate}`).isFile()) break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (i % 8 === 0) fs.readdirSync('node_modules', { withFileTypes: true });
    }
  },
  async promises(fs, n) {
    for (let i = 0; i < n; i++) {
      const pkg = `node_modules/pkg${i % PACKAGES}`;
      JSON.parse(await fs.promises.readFile(`${pkg}/package.json`, 'utf8'));
      await fs.promises.stat(`${pkg}/lib/index.js`);
      if (i % 8 === 0) await fs.promises.readdir('node_modules');
    }
  },
};

await runPairedBenchmark({
  async run({ short, cleanup, withArms, sample }) {
    const n = short ? 40 : 800;
    await withArms((from) => loadIsolatedCore(from, cleanup, {
      sources: LIFO_SHELL_CPU_SOURCES,
      modules: ['substrate/lifo/node-compat/fs.ts', 'substrate/lifo/node-compat/filesystem.ts', 'vfs/sqlite-vfs.ts', 'runtime/os-contracts.ts'],
      helpers: ['tests/unit/lib/sqlite-vfs-test-harness.mjs', 'tests/unit/lib/process-bridge.mjs'],
    }), async (arms) => {
      for (const [kind, work] of Object.entries(WORK)) {
        await sample(kind, arms, async (modules) => {
          const fs = fsOf(modules);
          return cpuMs(async () => {
            await work(fs, n);
            ran++;
          });
        }, { pairs: 30, warm: 4, iterations: 1 });
      }
    });
    assert.ok(ran > 0);
  },
});
