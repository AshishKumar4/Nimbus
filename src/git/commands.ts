/**
 * git-commands.ts — Nimbus v2.0 Git integration via isomorphic-git.
 *
 * Provides a full `git` command with subcommands:
 * init, clone, status, add, commit, log, branch, checkout,
 * diff, remote, fetch, pull, push, merge, reset, tag, stash
 *
 * Uses a VFS→isomorphic-git FS adapter that maps all operations
 * to the SqliteVFS.
 */

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { execGitNetwork } from './network-facet.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { dec } from '../_shared/bytes.js';

// ── Lazy-loaded isomorphic-git (avoid ~1MB load on every cold start) ────
// NOTE: local git ops (init, status, add, commit, log, branch, checkout,
// diff, remote, merge, reset, tag, config) run here in the supervisor DO.
// Network ops (clone, fetch, pull) are delegated to the git-network-facet
// because the supervisor's CPU budget cannot handle packfile processing
// for real-world repos (>100 files).
let _git: any = null;
async function getGit() {
  if (!_git) {
    // @ts-ignore — CF-compatible fork (github:AshishKumar4/cf-git)
    _git = await import('isomorphic-git');
  }
  return _git;
}

// ── VFS→isomorphic-git FS adapter ───────────────────────────────────────

/**
 * Creates an isomorphic-git compatible `fs` object from SqliteVFS.
 * isomorphic-git requires: readFile, writeFile, unlink, readdir,
 * mkdir, rmdir, stat, lstat (all as promises).
 */
function createGitFs(vfs: SqliteVFS) {
  // Path normalization is shared with esbuild-service via ./vfs-path.ts.
  // isomorphic-git constructs paths like `dir + '/' + filepath` which can
  // produce `/home/user/project/.` or paths with `..` segments — those are
  // collapsed before VFS lookup. The bounded `..` pop won't escape root.
  const normalizePath = normalizeVfsPath;

  function ensureParent(p: string) {
    const parts = normalizePath(p).split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (dir && !vfs.exists(dir)) vfs.mkdir(dir, { recursive: true });
    }
  }

  return {
    promises: {
      async readFile(filepath: string, opts?: any): Promise<Uint8Array | string> {
        const p = normalizePath(filepath);
        let data: Uint8Array;
        try { data = vfs.readFile(p); }
        catch {
          const err: any = new Error(`ENOENT: no such file or directory, open '${filepath}'`);
          err.code = 'ENOENT'; err.errno = -2;
          throw err;
        }
        if (opts?.encoding === 'utf8') return dec.decode(data);
        return data;
      },
      async writeFile(filepath: string, data: any, opts?: any): Promise<void> {
        const p = normalizePath(filepath);
        ensureParent(p);
        if (typeof data === 'string') {
          vfs.writeFile(p, data);
        } else {
          vfs.writeFile(p, data instanceof Uint8Array ? data : new Uint8Array(data));
        }
      },
      async unlink(filepath: string): Promise<void> {
        const p = normalizePath(filepath);
        if (vfs.exists(p)) vfs.unlink(p);
      },
      async readdir(filepath: string): Promise<string[]> {
        const p = normalizePath(filepath);
        if (!p) return []; // root level — not typically needed by isomorphic-git
        if (!vfs.exists(p)) return [];
        return vfs.readdir(p).map(e => e.name);
      },
      async mkdir(filepath: string, opts?: any): Promise<void> {
        const p = normalizePath(filepath);
        if (!vfs.exists(p)) vfs.mkdir(p, { recursive: true });
      },
      async rmdir(filepath: string): Promise<void> {
        const p = normalizePath(filepath);
        if (vfs.exists(p)) vfs.rmdir(p);
      },
      async stat(filepath: string): Promise<any> {
        const p = normalizePath(filepath);
        // Synthetic directory stat — used for root, '.', and known directories
        function dirStat() {
          const now = Date.now();
          const d = new Date(now);
          return {
            isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
            size: 0, mode: 0o755, type: 'dir',
            mtimeMs: now, mtime: d, ctimeMs: now, ctime: d, atimeMs: now, atime: d,
            uid: 1000, gid: 1000, dev: 0, ino: 0, nlink: 1,
          };
        }
        // Empty path (from '.', '/', etc.) = root directory
        if (!p) return dirStat();
        // Check if path is a known directory (even without VFS stat entry)
        if (vfs.exists(p) && vfs.isDirectory(p)) return dirStat();
        let st: any;
        try { st = vfs.stat(p); }
        catch {
          const err: any = new Error(`ENOENT: no such file or directory, stat '${filepath}'`);
          err.code = 'ENOENT'; err.errno = -2;
          throw err;
        }
        // isomorphic-git calls .valueOf() on mtime/ctime/atime — all must be Date objects
        const mtimeMs = st.mtime || Date.now();
        const mtime = new Date(mtimeMs);
        return {
          isFile: () => st.type === 'file',
          isDirectory: () => st.type === 'directory',
          isSymbolicLink: () => false,
          size: st.size,
          mode: st.mode || 0o644,
          mtimeMs,
          mtime,
          ctimeMs: mtimeMs,
          ctime: mtime,
          atimeMs: mtimeMs,
          atime: mtime,
          uid: 1000,
          gid: 1000,
          dev: 0,
          ino: 0,
          nlink: 1,
          type: st.type === 'directory' ? 'dir' : 'file',
        };
      },
      async lstat(filepath: string): Promise<any> {
        return this.stat(filepath);
      },
      async chmod(): Promise<void> { /* no-op */ },
      async symlink(): Promise<void> { /* no-op */ },
      async readlink(filepath: string): Promise<string> { return filepath; },
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

type Ctx = {
  args: string[];
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  cwd: string;
  env: Record<string, string>;
};

function getDir(ctx: Ctx): string {
  return '/' + (ctx.cwd || '/home/user').replace(/^\/+/, '');
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

function getAuthor(ctx: Ctx) {
  return {
    name: ctx.env.GIT_AUTHOR_NAME || ctx.env.USER || 'user',
    email: ctx.env.GIT_AUTHOR_EMAIL || 'user@nimbus.dev',
  };
}

// ── Git subcommand implementations ──────────────────────────────────────

export function registerGitCommands(
  registry: any,
  vfs: SqliteVFS,
  doCtx?: DurableObjectState,
  doEnv?: any,
): void {
  const fs = createGitFs(vfs);

  registry.register('git', async (ctx: Ctx) => {
    const args = ctx.args;
    const sub = args[0];
    const subArgs = args.slice(1);
    const dir = getDir(ctx);

    if (sub === '--version' || sub === '-v') {
      ctx.stdout.write('git version 2.44.0 (isomorphic-git/cf-git)\n');
      return 0;
    }

    if (!sub || sub === '--help' || sub === '-h') {
      ctx.stdout.write('usage: git <command> [<args>]\n\n');
      ctx.stdout.write('Commands:\n');
      ctx.stdout.write('  init, clone, status, add, commit, log, branch,\n');
      ctx.stdout.write('  checkout, diff, remote, fetch, pull, push, merge,\n');
      ctx.stdout.write('  reset, tag, config, --version\n');
      return 0;
    }

    // Lazy-load isomorphic-git only when actually needed.
    // Note: http transport isn't loaded here — network ops (clone/fetch/pull)
    // run inside the git-network-facet which imports its own http transport.
    let git: any;
    try {
      git = await getGit();
    } catch (e: any) {
      ctx.stderr.write(`git: failed to load git module: ${e?.message}\n`);
      return 1;
    }

    try {
      switch (sub) {
        case 'init': {
          // git init [path] — if path given, use it; otherwise use cwd
          let initDir = dir;
          const initPath = subArgs.find((a: string) => !a.startsWith('-'));
          if (initPath) {
            initDir = initPath.startsWith('/') ? initPath : dir + '/' + initPath;
            // Ensure the target directory exists in VFS
            const stripped = initDir.replace(/^\/+/, '');
            if (!vfs.exists(stripped)) vfs.mkdir(stripped, { recursive: true });
          }
          await git.init({ fs, dir: initDir });
          ctx.stdout.write(`Initialized empty Git repository in ${initDir}/.git/\n`);
          return 0;
        }

        case 'clone': {
          const url = subArgs[0];
          if (!url) { ctx.stderr.write('usage: git clone <url> [dir]\n'); return 1; }
          const dest = subArgs[1] ? getDir(ctx) + '/' + subArgs[1] : dir + '/' + url.split('/').pop()?.replace('.git', '');
          const depthFlag = getFlag(subArgs, '--depth');
          const noShallow = subArgs.includes('--no-shallow');
          const depth = depthFlag ? parseInt(depthFlag) || 1 : (noShallow ? undefined : 1);
          const isBg = subArgs.includes('&') || subArgs.includes('--bg');

          if (!doCtx || !doEnv) {
            ctx.stderr.write('[git] clone requires DO ctx + env (internal configuration error)\n');
            return 1;
          }

          ctx.stdout.write(`Cloning into '${dest}'...${depth ? ' (shallow, depth=' + depth + ')' : ''}\n`);

          // Delegate to git-network-facet: heavy packfile processing runs in
          // a dynamic worker with its own CPU budget, not the supervisor DO.
          const doClone = async () => {
            const result = await execGitNetwork(doCtx, doEnv, {
              op: 'clone',
              dir: dest as string,
              url,
              depth,
              auth: {
                username: ctx.env.GIT_USERNAME || '',
                password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
              },
            });
            try { vfs.flushAll(); } catch {}
            if (result.success) {
              ctx.stdout.write(
                `\n[git] clone complete (${result.filesWritten} files, ` +
                `${(result.bytesWritten / 1024).toFixed(1)}KB in ${(result.elapsed / 1000).toFixed(1)}s)\n`,
              );
            } else {
              ctx.stderr.write(`\n[git] clone failed: ${result.error}\n`);
            }
          };

          if (isBg) {
            ctx.stdout.write('[git] clone running in background...\n');
            doClone(); // intentionally not awaited
            return 0;
          } else {
            await doClone();
            return 0;
          }
        }

        case 'status': {
          const matrix = await git.statusMatrix({ fs, dir });
          let clean = true;
          for (const [filepath, head, workdir, stage] of matrix) {
            if (head === workdir && workdir === stage) continue;
            clean = false;
            if (head === 0 && workdir === 2 && stage === 0) ctx.stdout.write(`\x1b[31m?? ${filepath}\x1b[0m\n`);
            else if (head === 0 && stage === 2) ctx.stdout.write(`\x1b[32mA  ${filepath}\x1b[0m\n`);
            else if (head === 1 && workdir === 2 && stage === 2) ctx.stdout.write(`\x1b[32mM  ${filepath}\x1b[0m\n`);
            else if (head === 1 && workdir === 2 && stage === 1) ctx.stdout.write(`\x1b[31m M ${filepath}\x1b[0m\n`);
            else if (head === 1 && workdir === 0) ctx.stdout.write(`\x1b[31m D ${filepath}\x1b[0m\n`);
            else if (head === 1 && stage === 0) ctx.stdout.write(`\x1b[32mD  ${filepath}\x1b[0m\n`);
            else ctx.stdout.write(`   ${filepath} [${head},${workdir},${stage}]\n`);
          }
          if (clean) ctx.stdout.write('nothing to commit, working tree clean\n');
          return 0;
        }

        case 'add': {
          const paths = subArgs.filter(a => !a.startsWith('-'));
          if (paths.length === 0 || paths.includes('.')) {
            // Add all
            const matrix = await git.statusMatrix({ fs, dir });
            for (const [filepath, head, workdir, stage] of matrix) {
              if (head !== workdir || workdir !== stage) {
                if (workdir === 0) await git.remove({ fs, dir, filepath });
                else await git.add({ fs, dir, filepath });
              }
            }
          } else {
            for (const filepath of paths) {
              await git.add({ fs, dir, filepath });
            }
          }
          return 0;
        }

        case 'commit': {
          const msgIdx = subArgs.indexOf('-m');
          const message = msgIdx >= 0 ? subArgs[msgIdx + 1] : 'commit';
          if (!message) { ctx.stderr.write('error: empty commit message\n'); return 1; }
          const sha = await git.commit({
            fs, dir, message,
            author: getAuthor(ctx),
          });
          ctx.stdout.write(`[${sha.slice(0, 7)}] ${message}\n`);
          return 0;
        }

        case 'log': {
          const maxCount = parseInt(getFlag(subArgs, '-n') || getFlag(subArgs, '--max-count') || '10');
          const oneline = subArgs.includes('--oneline');
          const commits = await git.log({ fs, dir, depth: maxCount });
          for (const c of commits) {
            if (oneline) {
              ctx.stdout.write(`\x1b[33m${c.oid.slice(0, 7)}\x1b[0m ${c.commit.message.split('\n')[0]}\n`);
            } else {
              ctx.stdout.write(`\x1b[33mcommit ${c.oid}\x1b[0m\n`);
              ctx.stdout.write(`Author: ${c.commit.author.name} <${c.commit.author.email}>\n`);
              ctx.stdout.write(`Date:   ${new Date(c.commit.author.timestamp * 1000).toDateString()}\n\n`);
              ctx.stdout.write(`    ${c.commit.message}\n\n`);
            }
          }
          return 0;
        }

        case 'branch': {
          if (subArgs.length === 0 || subArgs[0] === '-a' || subArgs[0] === '--list') {
            const branches = await git.listBranches({ fs, dir });
            const current = await git.currentBranch({ fs, dir });
            for (const b of branches) {
              ctx.stdout.write(b === current ? `\x1b[32m* ${b}\x1b[0m\n` : `  ${b}\n`);
            }
            if (subArgs.includes('-a')) {
              try {
                const remotes = await git.listBranches({ fs, dir, remote: 'origin' });
                for (const b of remotes) ctx.stdout.write(`  \x1b[31mremotes/origin/${b}\x1b[0m\n`);
              } catch {}
            }
          } else if (subArgs.includes('-d') || subArgs.includes('-D')) {
            const name = subArgs.find(a => !a.startsWith('-'));
            if (name) {
              await git.deleteBranch({ fs, dir, ref: name });
              ctx.stdout.write(`Deleted branch ${name}\n`);
            }
          } else {
            const name = subArgs[0];
            await git.branch({ fs, dir, ref: name });
            ctx.stdout.write(`Created branch ${name}\n`);
          }
          return 0;
        }

        case 'checkout': {
          const ref = subArgs.find(a => !a.startsWith('-'));
          if (!ref) { ctx.stderr.write('error: specify a branch\n'); return 1; }
          if (subArgs.includes('-b')) {
            await git.branch({ fs, dir, ref });
            await git.checkout({ fs, dir, ref });
            ctx.stdout.write(`Switched to a new branch '${ref}'\n`);
          } else {
            await git.checkout({ fs, dir, ref });
            ctx.stdout.write(`Switched to branch '${ref}'\n`);
          }
          return 0;
        }

        case 'diff': {
          // Simple diff: show unstaged changes
          const matrix = await git.statusMatrix({ fs, dir });
          for (const [filepath, head, workdir, stage] of matrix) {
            if (workdir !== head || workdir !== stage) {
              ctx.stdout.write(`\x1b[1mdiff --git a/${filepath} b/${filepath}\x1b[0m\n`);
              try {
                const raw = await fs.promises.readFile(dir + '/' + filepath);
                const content = typeof raw === 'string' ? raw : dec.decode(raw as Uint8Array);
                const lines = content.split('\n');
                for (let i = 0; i < Math.min(lines.length, 50); i++) {
                  if (head === 0) ctx.stdout.write(`\x1b[32m+${lines[i]}\x1b[0m\n`);
                  else ctx.stdout.write(` ${lines[i]}\n`);
                }
                if (lines.length > 50) ctx.stdout.write(`... (${lines.length - 50} more lines)\n`);
              } catch {}
              ctx.stdout.write('\n');
            }
          }
          return 0;
        }

        case 'remote': {
          if (subArgs[0] === 'add' && subArgs[1] && subArgs[2]) {
            await git.addRemote({ fs, dir, remote: subArgs[1], url: subArgs[2] });
            ctx.stdout.write(`Remote '${subArgs[1]}' added\n`);
          } else if (subArgs[0] === 'remove' || subArgs[0] === 'rm') {
            await git.deleteRemote({ fs, dir, remote: subArgs[1] });
            ctx.stdout.write(`Remote '${subArgs[1]}' removed\n`);
          } else {
            const remotes = await git.listRemotes({ fs, dir });
            for (const r of remotes) {
              ctx.stdout.write(subArgs.includes('-v') ? `${r.remote}\t${r.url} (fetch)\n` : `${r.remote}\n`);
            }
          }
          return 0;
        }

        case 'fetch': {
          const remote = subArgs[0] || 'origin';
          if (!doCtx || !doEnv) {
            ctx.stderr.write('[git] fetch requires DO ctx + env (internal configuration error)\n');
            return 1;
          }
          ctx.stdout.write(`Fetching from ${remote}...\n`);
          const result = await execGitNetwork(doCtx, doEnv, {
            op: 'fetch',
            dir,
            remote,
            auth: {
              username: ctx.env.GIT_USERNAME || '',
              password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
            },
          });
          try { vfs.flushAll(); } catch {}
          if (result.success) {
            ctx.stdout.write(`\n[git] fetch complete (${result.filesWritten} files in ${(result.elapsed / 1000).toFixed(1)}s)\n`);
            return 0;
          } else {
            ctx.stderr.write(`\n[git] fetch failed: ${result.error}\n`);
            return 1;
          }
        }

        case 'pull': {
          const remote = subArgs[0] || 'origin';
          const branch = subArgs[1] || await git.currentBranch({ fs, dir }) || 'main';
          if (!doCtx || !doEnv) {
            ctx.stderr.write('[git] pull requires DO ctx + env (internal configuration error)\n');
            return 1;
          }
          ctx.stdout.write(`Pulling from ${remote}/${branch}...\n`);
          const result = await execGitNetwork(doCtx, doEnv, {
            op: 'pull',
            dir,
            remote,
            ref: branch,
            author: getAuthor(ctx),
            auth: {
              username: ctx.env.GIT_USERNAME || '',
              password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
            },
          });
          try { vfs.flushAll(); } catch {}
          if (result.success) {
            ctx.stdout.write(`\n[git] pull complete (${result.filesWritten} files in ${(result.elapsed / 1000).toFixed(1)}s)\n`);
            return 0;
          } else {
            ctx.stderr.write(`\n[git] pull failed: ${result.error}\n`);
            return 1;
          }
        }

        case 'push': {
          const remote = subArgs[0] || 'origin';
          const branch = subArgs[1] || await git.currentBranch({ fs, dir }) || 'main';
          if (!doCtx || !doEnv) {
            ctx.stderr.write('[git] push requires DO ctx + env (internal configuration error)\n');
            return 1;
          }
          ctx.stdout.write(`Pushing to ${remote}/${branch}...\n`);
          const result = await execGitNetwork(doCtx, doEnv, {
            op: 'push',
            dir,
            remote,
            ref: branch,
            auth: {
              username: ctx.env.GIT_USERNAME || '',
              password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
            },
          });
          if (result.success) {
            ctx.stdout.write(`\n[git] push complete (${(result.elapsed / 1000).toFixed(1)}s)\n`);
            return 0;
          } else {
            ctx.stderr.write(`\n[git] push failed: ${result.error}\n`);
            return 1;
          }
        }

        case 'merge': {
          const theirs = subArgs[0];
          if (!theirs) { ctx.stderr.write('usage: git merge <branch>\n'); return 1; }
          await git.merge({
            fs, dir, theirs,
            author: getAuthor(ctx),
          });
          ctx.stdout.write(`Merged ${theirs}\n`);
          return 0;
        }

        case 'reset': {
          const hard = subArgs.includes('--hard');
          const soft = subArgs.includes('--soft');
          const ref = subArgs.find(a => !a.startsWith('-')) || 'HEAD';
          const oid = await git.resolveRef({ fs, dir, ref });

          // Move the current branch to the target OID
          const branch = await git.currentBranch({ fs, dir });
          if (branch) {
            await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
          }

          if (!soft) {
            // Reset index (--mixed behavior, also applies to --hard)
            const matrix = await git.statusMatrix({ fs, dir });
            for (const [filepath] of matrix) {
              try { await git.resetIndex({ fs, dir, filepath }); } catch {}
            }
          }

          if (hard) {
            // Reset working tree to match the target
            await git.checkout({ fs, dir, ref: oid, force: true });
          }

          ctx.stdout.write(`HEAD is now at ${oid.slice(0, 7)}\n`);
          return 0;
        }

        case 'tag': {
          if (subArgs.length === 0) {
            const tags = await git.listTags({ fs, dir });
            for (const t of tags) ctx.stdout.write(t + '\n');
          } else if (subArgs.includes('-d')) {
            const name = subArgs.find(a => !a.startsWith('-'));
            if (name) await git.deleteTag({ fs, dir, ref: name });
          } else {
            const name = subArgs[0];
            await git.tag({ fs, dir, ref: name });
            ctx.stdout.write(`Created tag ${name}\n`);
          }
          return 0;
        }

        case 'config': {
          const key = subArgs.find(a => !a.startsWith('-'));
          const value = subArgs[subArgs.indexOf(key || '') + 1];
          if (key && value) {
            const [section, ...rest] = key.split('.');
            await git.setConfig({ fs, dir, path: key, value });
            ctx.stdout.write(`${key}=${value}\n`);
          } else if (key) {
            try {
              const val = await git.getConfig({ fs, dir, path: key });
              ctx.stdout.write(`${val}\n`);
            } catch { ctx.stderr.write(`config: key '${key}' not set\n`); return 1; }
          } else {
            ctx.stderr.write('usage: git config <key> [value]\n');
            return 1;
          }
          return 0;
        }

        default:
          ctx.stderr.write(`git: '${sub}' is not a git command. See 'git --help'.\n`);
          return 1;
      }
    } catch (e: any) {
      ctx.stderr.write(`fatal: ${e?.message || e}\n`);
      return 128;
    }
  });
}
