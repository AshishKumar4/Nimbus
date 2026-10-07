#!/usr/bin/env bun
// The unit suite of a commit, on armada: `armada run` on the commit, whose
// own .armada.json and scripts/ci/unit.mjs plan it into parts and run them
// in containers.
//
//   bun scripts/ci/remote-unit.mjs [<commit>] [--tier fast|slow|all] [--only a.mjs,b.mjs] [--label TEXT]
//
// Run it in the lane's worktree. The commit (default HEAD) is what is
// tested, never the working tree: commit first. --tier and --only narrow
// the plan (unit.mjs plan); a narrowed run is graded, but is not recorded
// as the commit's verdict. armada prints each part as it lands, then the
// verdict, and keeps a report under ~/.local/state/armada/runs/.
// Exit: 0, every row green; 1, a red row; 2, not graded (run it again).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { armadaClient } from './lib/armada.mjs';

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (['--tier', '--only', '--label'].includes(argv[i]) && argv[i + 1] !== undefined) flags[argv[i].slice(2)] = argv[++i];
  else if (!argv[i].startsWith('--')) positional.push(argv[i]);
  else usage(`unexpected ${argv[i]}`);
}
if (positional.length > 1) usage('one commit at most');
function usage(why) {
  console.error(`${why}\nusage: bun scripts/ci/remote-unit.mjs [<commit>] [--tier fast|slow|all] [--only a.mjs,b.mjs] [--label TEXT]`);
  process.exit(2);
}

const notGraded = (why) => {
  console.error(`remote-unit: NOT GRADED — ${why}`);
  process.exit(2);
};
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
if (top.status !== 0) notGraded(`not in a git checkout: ${top.stderr.trim()}`);
const repo = top.stdout.trim();
const resolved = git(repo, ['rev-parse', '--verify', `${positional[0] ?? 'HEAD'}^{commit}`]);
if (resolved.status !== 0) notGraded(`no commit ${positional[0] ?? 'HEAD'}: ${resolved.stderr.trim()}`);
const sha = resolved.stdout.trim();
if (git(repo, ['cat-file', '-e', `${sha}:.armada.json`]).status !== 0) notGraded(`${sha.slice(0, 12)} has no .armada.json: merge main into it first`);

let client;
try {
  client = armadaClient();
} catch (error) {
  notGraded(error.message);
}
const words = [...(flags.tier ? ['--tier', flags.tier] : []), ...(flags.only ? ['--only', flags.only] : [])];
const ran = spawnSync('bun', [join(client, 'src', 'cli.ts'), 'run', sha, ...(flags.label ? [`--label=${flags.label}`] : []), ...(words.length ? ['--', ...words] : [])], {
  cwd: repo, stdio: 'inherit',
});
process.exit(ran.status ?? 2);
