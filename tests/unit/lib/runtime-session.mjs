// A session as a runtime command sees it: the runtime blobs installed the
// way the supervisor installs them, and one invocation's context (the
// session user's credential and view, collected output).

import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles, ProcessView } from '../../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from '../sqlite-vfs-test-harness.mjs';

export const SESSION_USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

/**
 * A session whose home belongs to the session user, with `files` (path →
 * bytes; a leading `/` is the session root) written as the kernel, mode
 * 0644, their directories 0755. `root` is the store as the kernel, for
 * further setup.
 */
export function installedRuntime(files = {}) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const root = raw.as(CRED_KERNEL);
  root.mkdir('home/user', { recursive: true, mode: 0o755 });
  root.chown('home/user', SESSION_USER.uid, SESSION_USER.gid);
  for (const [path, bytes] of Object.entries(files)) {
    const clean = path.replace(/^\/+/, '');
    root.mkdir(clean.replace(/\/[^/]+$/, ''), { recursive: true, mode: 0o755 });
    root.writeFile(clean, bytes, { mode: 0o644 });
  }
  return { raw, root, filesystem: new ProcessFiles(raw) };
}

/**
 * One command invocation in /home/user as `cred`: its view of `filesystem`
 * (or `vfs`, when the test stands one in), and `output()` for what it wrote.
 * Any `extra` fields (setUmask, runAs) reach the context as given.
 */
export function runtimeContext(filesystem, { args = [], env = {}, pid = 41, cred = SESSION_USER, vfs, ...extra } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    ctx: {
      pid,
      cred,
      vfs: vfs ?? new ProcessView(filesystem.bind({ pid, cred })),
      args,
      cwd: '/home/user',
      env,
      stdin: '',
      stdout: { write: (value) => { stdout += String(value); } },
      stderr: { write: (value) => { stderr += String(value); } },
      ...extra,
    },
    output: () => ({ stdout, stderr }),
  };
}
