// Real git's checkout against the streamed one, on local workerd (apps/probe,
// tests/unit/lib/workerd-probe.mjs), same session and same pack:
//   1. `git clone` through Nimbus's builtin (network facet: prepare, then the
//      streamed checkout), timed as a whole;
//   2. `nimbus install git` (git.wasm becomes `git`), then the worktree and
//      the index are removed and `git reset --hard` (git.wasm) writes them
//      again through the WASI resident filesystem, timed.
// Prints one JSON line per step. Usage:
//   REPO=https://github.com/vercel/next.js bun spike/git-real/measure-checkout.mjs
import { startLocalProbe } from '../../tests/unit/lib/workerd-probe.mjs';

const REPO = process.env.REPO ?? 'https://github.com/expressjs/express';
const probe = await startLocalProbe({ runtimes: ['bash', 'git'] });
// The driver reads these when it loads.
process.env.BASE = probe.base;
process.env.NIMBUS_PROBE_TOKEN = probe.token;
const { mintSession, deleteSession, Terminal, stripAnsi } = await import('../../tests/behavioral/_driver.mjs');

const sid = await mintSession();
const t = new Terminal(sid);
const step = async (label, cmd, timeout = 3_600_000) => {
  const started = Date.now();
  const r = await t.run(cmd, timeout);
  const out = stripAnsi(r.output).replace(/\s+$/, '');
  console.log(JSON.stringify({ label, wallMs: Date.now() - started, out: out.slice(-600) }));
  return out;
};
try {
  await t.connect();
  await t.waitForPrompt(120_000);
  await step('streamed clone', `git clone ${REPO} repo 2>&1 | tail -2; echo RC=$?`);
  await step('files', "find repo -type f -not -path 'repo/.git/*' | wc -l");
  await step('install git', 'nimbus install git 2>&1 | tail -1; git --version');
  await step('remove worktree and index', "cd repo && rm -f .git/index && find . -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} + ; cd ..; find repo -type f -not -path 'repo/.git/*' | wc -l");
  await step('git.wasm reset --hard', 'cd repo && NIMBUS_WASI_FS_STATS=1 git reset --hard 2>&1 | tail -3; echo RC=$?; cd ..');
  await step('files after', "find repo -type f -not -path 'repo/.git/*' | wc -l");
  await step('git.wasm status', 'cd repo && NIMBUS_WASI_FS_STATS=1 git status --short 2>&1 | tail -3; echo RC=$?; cd ..');
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
  await probe.stop();
}
