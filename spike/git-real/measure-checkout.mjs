// Streamed clone versus real checkout; --fsmonitor instead measures real
// git status with/without the VFS revision hook on next.js and Linux depth 1.
// Uses the local publisher packages and workerd; creates no remote target.
import { localTerminal, startLocalProbe } from '../../tests/unit/lib/workerd-probe.mjs';

const fsmonitor = process.argv.includes('--fsmonitor');
const repos = fsmonitor
  ? (process.env.REPOS ?? 'https://github.com/vercel/next.js,https://github.com/torvalds/linux').split(',')
  : [process.env.REPO ?? 'https://github.com/expressjs/express'];
const probe = await startLocalProbe({ runtimes: ['bash', 'git'] });
try {
  for (const repo of repos) {
    const terminal = await localTerminal(probe);
    const step = async (label, command, timeout = 3_600_000) => {
      const started = Date.now();
      const result = await terminal.run(command, timeout);
      const out = result.stdout.trimEnd();
      const stats = /\[wasi-fs\] git (\{[^\n]*\})/.exec(out);
      console.log(JSON.stringify({
        repo, label, wallMs: Date.now() - started, status: result.status,
        fsStats: stats ? JSON.parse(stats[1]) : undefined, out: out.slice(-600),
      }));
      if (result.status !== 0) throw new Error(`${label}: ${result.status}: ${out.slice(-600)}`);
      return out;
    };
    try {
      await step('streamed clone', `git clone --depth 1 ${repo} repo`);
      await step('files', "find repo -type f -not -path 'repo/.git/*' | wc -l");
      await step('install git', 'nimbus install git');
      await step('version', 'git --version');
      if (fsmonitor) {
        for (const enabled of [false, true]) {
          const config = enabled ? '-c core.fsmonitor=git-fsmonitor-nimbus -c core.fsmonitorHookVersion=2' : '-c core.fsmonitor=false';
          for (let n = 0; n < 3; n++) await step(`warm status fsmonitor=${enabled} ${n}`, `git -C repo ${config} status --porcelain`);
          for (let n = 0; n < 5; n++) await step(`measured status fsmonitor=${enabled} ${n}`, `NIMBUS_WASI_FS_STATS=1 git -C repo ${config} status --porcelain`);
        }
        const trace = await step('fsmonitor protocol trace', 'GIT_TRACE_FSMONITOR=1 git -C repo -c core.fsmonitor=git-fsmonitor-nimbus -c core.fsmonitorHookVersion=2 status --porcelain');
        if (!trace.includes('returned success')) throw new Error('Git did not successfully query the hook');
        await step('change an untracked file', "printf 'new\\n' > repo/.nimbus-fsmonitor-new");
        const monitored = await step('changed status fsmonitor=true', 'git -C repo -c core.fsmonitor=git-fsmonitor-nimbus -c core.fsmonitorHookVersion=2 status --porcelain');
        const baseline = await step('changed status fsmonitor=false', 'git -C repo -c core.fsmonitor=false status --porcelain');
        if (monitored !== baseline || !monitored.includes('.nimbus-fsmonitor-new')) throw new Error('fsmonitor missed the change');
      } else {
        await step('remove worktree and index', "cd repo && rm -f .git/index && find . -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +; cd ..");
        await step('git.wasm reset --hard', 'NIMBUS_WASI_FS_STATS=1 git -C repo reset --hard');
        await step('files after', "find repo -type f -not -path 'repo/.git/*' | wc -l");
        await step('git.wasm status', 'NIMBUS_WASI_FS_STATS=1 git -C repo status --short');
      }
    } finally {
      await terminal.close();
    }
  }
} finally {
  await probe.stop();
}
