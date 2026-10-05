// A session for git tests that run the real network facet: SQLite VFS, the
// runtime bridge as the supervisor (writes presenting the lease the binding
// carries), the assembled facet loaded in-process as the LOADER would run
// it, and runGitCommand over it all. Host git helpers to compare against.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { SqliteRuntimeFsBridge } from '../../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { adoptCtxExports } from '../../../packages/fabric/src/composition.ts';
import { runGitCommand } from '../../../packages/worker/src/git/commands.ts';
import { assembleGitNetworkFacetSource } from '../../../packages/worker/src/git/network-facet.ts';
import { createSqliteVfsTestHarness } from '../sqlite-vfs-test-harness.mjs';
import { stagedAssets } from './staged-assets.mjs';

export function hostGitEnv(home) {
  return {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: home,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
}

export function hostGit(home, cwd, args) {
  const result = spawnSync('git', args, { cwd, env: hostGitEnv(home), maxBuffer: 1 << 28 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.toString();
}

/** Every object a repository holds, "<id> <type>", sorted. */
export function hostObjects(home, dir) {
  return hostGit(home, dir, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).trim().split('\n').sort();
}

export async function createFacetSession(work) {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const files = new ProcessFiles(vfs);
  let owner;
  const bridge = new SqliteRuntimeFsBridge(kernel, vfs);
  const lease = () => (owner === undefined ? {} : { mutationOwner: owner });
  const requests = { fetchObjects: 0, phases: [] };
  const supervisor = {
    async stat(path) { try { return bridge.stat(path); } catch { return null; } },
    async lstat(path) { try { return bridge.stat(path, { followSymlinks: false }); } catch { return null; } },
    async hasLegacySymlinkUnder() { return false; },
    async readdir(path) { return bridge.readdir(path); },
    async readFileBytes(path) { try { return bridge.readFile(path); } catch { return null; } },
    async fsReadRange(path, offset, length) { return bridge.readRange(path, offset, length); },
    async fsWriteRange(path, offset, bytes) { return bridge.writeRange(path, offset, bytes, { createParents: true, ...lease() }); },
    async fsTruncate(path, size) { return bridge.truncate(path, size, lease()); },
    async rename(from, to) { return bridge.rename(from, to, lease()); },
    async writeBatchStream(stream) { return kernel.writeStream(stream, lease()); },
    async stdout() {},
  };
  // Each execGitNetwork mints its binding with the lease it holds (a clone's), as SupervisorRPC props carry it.
  adoptCtxExports({ SupervisorRPC: ({ props }) => { owner = props.mutationOwner; return supervisor; } });

  const tempDir = mkdtempSync(join(work, 'facet-'));
  writeFileSync(join(tempDir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
  writeFileSync(join(tempDir, 'git-bundle.js'), 'export const git = {}; export const gitHttp = {};');
  const facet = await import(pathToFileURL(join(tempDir, 'git-network-worker.mjs')).href);
  const doCtx = { id: { toString: () => 'facet-session-do' } };
  const doEnv = {
    ASSETS: stagedAssets,
    LOADER: {
      load() {
        return {
          getEntrypoint() {
            return {
              async fetch(request) {
                const body = await request.clone().json().catch(() => ({}));
                if (body.op === 'fetch-objects') requests.fetchObjects++;
                requests.phases.push(body.phase === 'clone-history' ? 'clone-history:' + body.history?.step : body.phase ?? body.op);
                return facet.default.fetch(request, { SUPERVISOR: supervisor });
              },
            };
          },
        };
      },
    },
  };

  async function git(cwd, args, env = {}) {
    let stdout = '';
    let stderr = '';
    const code = await runGitCommand({
      pid: 7,
      cred: CRED_SESSION_USER,
      args,
      cwd,
      env: { USER: 'a', ...env },
      stdout: { write(s) { stdout += s; } },
      stderr: { write(s) { stderr += s; } },
      vfs: files.view({ pid: 7, cred: CRED_SESSION_USER }),
    }, vfs, doCtx, doEnv);
    return { code, stdout: stdout.replace(/\x1b\[[0-9;]*m/g, ''), stderr };
  }

  /** Copy a session directory (engine path) to `out` on disk. */
  function materialize(root, out, only = null) {
    const copy = (key) => {
      for (const entry of kernel.readdir(key)) {
        const child = key + '/' + (typeof entry === 'string' ? entry : entry.name);
        const target = join(out, child.slice(root.length));
        const stat = kernel.lstat(child);
        if (stat.type === 'directory') { mkdirSync(target, { recursive: true }); copy(child); }
        else if (stat.type === 'file') writeFileSync(target, kernel.readFile(child), { mode: stat.mode & 0o777 });
      }
    };
    mkdirSync(join(out, only ?? ''), { recursive: true });
    copy(only === null ? root : root + '/' + only);
    return out;
  }

  /** The session repository's objects, by host git over a copy of its .git. */
  function sessionObjects(root) {
    const out = materialize(root, mkdtempSync(join(work, 'objects-')), '.git');
    return { dir: out, objects: hostObjects(work, out) };
  }

  return { vfs, kernel, git, requests, doCtx, doEnv, materialize, sessionObjects };
}
