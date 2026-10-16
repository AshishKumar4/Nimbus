// The three Previews a run's paired perf probes measure
// (tests/behavioral/_paired.mjs): a1 and a2 of the baseline commit, b of the
// candidate, each a fresh throwaway built on CI and uploaded from here as
// remote-probes --deploy uploads one. An upload reads its app's config from
// a checkout at the release's own commit (uploadConfig), so a commit this
// worktree is not at is uploaded from a detached worktree of it, made for
// this run and removed after it.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ARMS } from '../../../tests/behavioral/_paired.mjs';
import { INSTALL } from '../../install-deps.mjs';
import { NIMBUS_STATE } from './state-dir.mjs';

const git = (cwd, args) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};

/** Run `args` in `cwd`; resolves to its stdout, rejects naming the command and its stderr's tail. */
function run(cwd, command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text) => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout)
      : reject(new Error(`${command} ${args.slice(0, 3).join(' ')} exited ${code} in ${cwd}:\n${stderr.trimEnd().split('\n').slice(-15).join('\n')}`))));
  });
}

/** The commit a candidate is measured against by default: where it leaves origin/main. */
export function defaultBaseline(repo, sha) {
  return git(repo, ['merge-base', sha, 'origin/main']);
}

/**
 * Stand up the arms: `releases` maps the baseline and candidate commits to
 * their release dirs (one dir when they are the same commit). Resolves to
 * { targets: { a1|a2|b: { base, token } }, teardown }, where `teardown()`
 * deletes every Preview and worktree made here and resolves to the ones it
 * could not, each with the command that finishes it. On a failure part way,
 * what was made is torn down before it rejects.
 */
export async function standUpPaired({ repo, baseline, candidate, releases, ttlMs, log = (line) => console.error(line) }) {
  const runId = randomBytes(3).toString('hex');
  const made = { worktrees: [], previews: [] };
  const checkouts = new Map();
  const teardown = async () => {
    const left = [];
    for (const { name, checkout } of made.previews) {
      await run(checkout, 'bun', ['tests/behavioral/_throwaway-target.mjs', 'down', '--name', name])
        .catch((error) => left.push(`Preview ${name}: ${error.message.split('\n')[0]}; finish with: (cd ${checkout} && bun tests/behavioral/_throwaway-target.mjs down --name ${name})`));
    }
    for (const dir of made.worktrees) {
      if (left.some((line) => line.includes(dir))) continue;
      try { git(repo, ['worktree', 'remove', '--force', dir]); } catch (error) { left.push(`worktree ${dir}: ${error.message}`); }
    }
    return left;
  };
  /** A clean checkout at `commit`: this one when it is there, else a detached worktree with dependencies installed. */
  const checkoutAt = async (commit) => {
    if (git(repo, ['rev-parse', 'HEAD']) === commit) return repo;
    if (!checkouts.has(commit)) {
      checkouts.set(commit, (async () => {
        const dir = join(NIMBUS_STATE, 'paired', `${runId}-${commit.slice(0, 12)}`);
        mkdirSync(join(NIMBUS_STATE, 'paired'), { recursive: true });
        git(repo, ['worktree', 'add', '--detach', dir, commit]);
        made.worktrees.push(dir);
        await run(dir, 'bun', INSTALL.split(' ').slice(1));
        return dir;
      })());
    }
    return checkouts.get(commit);
  };
  const arm = { a1: baseline, a2: baseline, b: candidate };
  try {
    // One upload at a time per checkout (they share its .wrangler state); the two checkouts at once.
    const groups = new Map();
    for (const name of ARMS) {
      const checkout = await checkoutAt(arm[name]);
      groups.set(checkout, [...(groups.get(checkout) ?? []), name]);
    }
    const targets = {};
    await Promise.all([...groups].map(async ([checkout, names]) => {
      for (const name of names) {
        const throwaway = `pp-${runId}-${name}`;
        made.previews.push({ name: throwaway, checkout });
        log(`paired: ${name} is ${arm[name].slice(0, 12)} on throwaway ${throwaway}`);
        await run(checkout, 'bun', ['tests/behavioral/_throwaway-target.mjs', 'up', '--name', throwaway, '--bundle', releases[arm[name]]]);
        targets[name] = JSON.parse(await run(checkout, 'bun', ['tests/behavioral/_throwaway-target.mjs', 'token', '--name', throwaway, '--json', '--ttl-ms', String(ttlMs)]));
      }
    }));
    return { targets, teardown };
  } catch (error) {
    const left = await teardown();
    throw new Error(`${error.message}${left.length ? `\nleft behind:\n${left.join('\n')}` : ''}`);
  }
}
