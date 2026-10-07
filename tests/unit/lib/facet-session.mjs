// A session for git tests that run the real network facet: SQLite VFS, the
// runtime bridge as the supervisor (writes presenting the lease the binding
// carries), the assembled facet loaded in-process as the LOADER would run
// it, and runGitCommand over it all. Host git helpers to compare against.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { SqliteRuntimeFsBridge } from '../../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { adoptCtxExports } from '../../../packages/fabric/src/composition.ts';
import { runGitCommand } from '../../../packages/worker/src/git/commands.ts';
import { assembleGitNetworkFacetSource } from '../../../packages/worker/src/git/network-facet.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { stagedAssets } from './staged-assets.mjs';
import { memoryStorage } from './do-storage.mjs';


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

/** The staged cf-git bundle, as the facet loads it in production. */
function stagedGitBundle() {
  const dir = new URL('../../../packages/worker/public/_assets/runtime/', import.meta.url);
  const name = readdirSync(dir).find((file) => /^git-[0-9a-f]+\.js$/.test(file));
  assert.ok(name, 'no staged git bundle: run bundle-git.mjs');
  return readFileSync(new URL(name, dir), 'utf8');
}

/**
 * `realGit`: the facet runs the staged cf-git bundle (fetch, pull, push), not a stub.
 * `mounts`: backends mounted in the session's namespace, by mount point; the
 * facets' supervisor then reaches the namespace as the session's does (a
 * host bridge of the session's ProcessFiles), mounts and their guard included.
 */
export async function createFacetSession(work, { realGit = false, mounts = {} } = {}) {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const files = new ProcessFiles(vfs);
  for (const [point, backend] of Object.entries(mounts)) files.vfs.mount(point, backend);
  const bridge = Object.keys(mounts).length > 0 ? files.openHost(CRED_KERNEL).fs : new SqliteRuntimeFsBridge(kernel, vfs);
  // failWaveAt: the 1-based write wave that fails, once, as a dropped session connection does.
  // hangPhaseAt: the 1-based facet call of that phase that never answers, once.
  // stallPhaseAt: the same, but the call runs on, its answer withheld: a late writer.
  // refusals: the facets' mutations the session refused, with why.
  const requests = {
    fetchObjects: 0, phases: [], attempts: [], rangeReads: [], rangeWrites: [], waves: 0,
    failWaveAt: 0, hangPhaseAt: null, stallPhaseAt: null, stalled: [], refusals: [], loads: 0,
    // calls: every facet call's phase, attempt and batch; withhold: resumed packs whose step's answer is lost.
    calls: [], withhold: new Set(),
  };
  const refused = (call) => call().catch((error) => {
    requests.refusals.push(String(error?.code ?? error?.message ?? error));
    throw error;
  });
  // Each binding writes with the lease it was minted with (SupervisorRPC props), as the session's does.
  const supervisorFor = (owner) => {
    const lease = owner === undefined ? {} : { mutationOwner: owner };
    return {
      async stat(path) { try { return bridge.stat(path); } catch { return null; } },
      async lstat(path) { try { return bridge.stat(path, { followSymlinks: false }); } catch { return null; } },
      async hasLegacySymlinkUnder() { return false; },
      async readdir(path) { return bridge.readdir(path); },
      async readFileBytes(path) { try { return bridge.readFile(path); } catch { return null; } },
      async fsReadRange(path, offset, length) {
        requests.rangeReads.push({ path, offset, length });
        return bridge.readRange(path, offset, length);
      },
      async fsReadRangeUncached(path, offset, length) {
        requests.rangeReads.push({ path, offset, length });
        return bridge.readRange(path, offset, length, { cached: false });
      },
      async fsWriteRange(path, offset, bytes) {
        requests.rangeWrites.push({ path, offset, bytes: bytes.byteLength });
        await requests.onRangeWrite?.(path, offset);
        return refused(async () => bridge.writeRange(path, offset, bytes, { createParents: true, ...lease }));
      },
      async fsTruncate(path, size) { return refused(async () => bridge.truncate(path, size, lease)); },
      async rename(from, to) {
        const result = await refused(async () => bridge.rename(from, to, lease));
        // loseRename: the step that made this rename never answers (its tmp pack's name goes to withhold).
        if (requests.loseRename?.(from, to)) requests.withhold.add(from.slice(from.lastIndexOf('/') + 1));
        return result;
      },
      // unlink carries no lease: the session's supervisor op has none for it either (supervisor-op.ts).
      async unlink(path) { return refused(async () => bridge.unlink(path)); },
      async writeBatchStream(stream) {
        if (++requests.waves === requests.failWaveAt) {
          await stream.cancel();
          throw new Error('Network connection lost.');
        }
        return refused(async () => {
          const result = await kernel.writeStream(stream, lease);
          if (result.ok === false) requests.refusals.push(String(result.error?.code ?? result.error?.message));
          return result;
        });
      },
      async stdout() {},
    };
  };
  const supervisor = supervisorFor(undefined);
  adoptCtxExports({ SupervisorRPC: /** @type {any} */ (({ props }) => supervisorFor(props.mutationOwner)) });

  const tempDir = mkdtempSync(join(work, 'facet-'));
  writeFileSync(join(tempDir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
  writeFileSync(join(tempDir, 'git-bundle.js'), realGit ? stagedGitBundle() : 'export const git = {}; export const gitHttp = {};');
  const facet = await import(pathToFileURL(join(tempDir, 'git-network-worker.mjs')).href);
  // The DO's storage, as a clone's job records use it (git/clone-job.ts).
  const doCtx = { id: { toString: () => 'facet-session-do' }, storage: memoryStorage() };
  const doEnv = {
    ASSETS: stagedAssets,
    LOADER: {
      load(code) {
        requests.loads++;
        const binding = code.env.SUPERVISOR;
        return {
          getEntrypoint() {
            return {
              async fetch(request) {
                const body = await request.clone().json().catch(() => ({}));
                if (body.op === 'fetch-objects') requests.fetchObjects++;
                requests.phases.push(body.phase === 'clone-history' ? 'clone-history:' + body.history?.step : body.phase ?? body.op);
                if (body.attempt !== undefined) requests.attempts.push(body.attempt);
                requests.calls.push({ phase: body.phase ?? body.op, attempt: body.attempt, batch: body.batch?.index });
                await requests.onPhase?.(body);
                const hang = requests.hangPhaseAt;
                if (hang !== null && body.phase === hang.phase && ++hang.seen === hang.at) return new Promise(() => {});
                const stall = requests.stallPhaseAt;
                if (stall !== null && body.phase === stall.phase && ++stall.seen === stall.at) {
                  // Runs on; whoever waits for its answer times out.
                  requests.stalled.push(facet.default.fetch(request, { SUPERVISOR: binding }).then((response) => response.json()));
                  return new Promise(() => {});
                }
                const answer = await facet.default.fetch(request, { SUPERVISOR: binding });
                // A resumed step whose answer is lost after its pack was named (loseRename marked it).
                const pending = body.history?.pending?.tmpName;
                if (pending !== undefined && requests.withhold.delete(pending)) return new Promise(() => {});
                return answer;
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

  /** Copy a session directory, through the namespace as the session user (a mount's included), to `out` on disk. */
  async function materializeAt(root, out) {
    const view = files.view({ pid: 7, cred: CRED_SESSION_USER });
    const copy = async (path) => {
      for (const entry of await view.readdir(path)) {
        const child = path + '/' + entry.name;
        const target = join(out, child.slice(root.length));
        const stat = await view.stat(child, { follow: false });
        if (stat.type === 'directory') { mkdirSync(target, { recursive: true }); await copy(child); }
        else if (stat.type === 'file') writeFileSync(target, await view.readFile(child), { mode: stat.mode & 0o777 });
        else if (stat.type === 'symlink') symlinkSync(await view.readlink(child), target);
      }
    };
    mkdirSync(out, { recursive: true });
    await copy(root);
    return out;
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
        else if (stat.type === 'symlink') symlinkSync(kernel.readlink(child), target);
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

  return { vfs, kernel, files, git, requests, doCtx, doEnv, materialize, materializeAt, sessionObjects };
}
