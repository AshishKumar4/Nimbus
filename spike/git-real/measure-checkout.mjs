// A lightweight driver of a DEPLOYED throwaway: no local workerd or builds.
// BASE/NIMBUS_PROBE_TOKEN are the target's credentials. Each backend gets a
// fresh session and the same streamed clone; only the WASI session installs
// git. EXPECT_GIT_WASM_SHA256 must name this lane's committed artifact.
// JSON rows include measurement windows for Cloudflare's real session-memory
// metric (durableObjectsPeriodicGroups.max.memoryUsageBytes), not an estimated
// heap. A missing memory measurement never satisfies the routing gate.
import { mintSession, Terminal, deleteSession, termBody } from '../../tests/behavioral/_driver.mjs';

const base = process.env.BASE;
if (!base || ['localhost', '127.0.0.1', '::1'].includes(new URL(base).hostname)) {
  throw new Error('BASE must name a deployed throwaway, not local workerd');
}
const expectedWasm = process.env.EXPECT_GIT_WASM_SHA256;
if (!/^[a-f0-9]{64}$/.test(expectedWasm ?? '')) throw new Error('EXPECT_GIT_WASM_SHA256 is required');
const samples = Number(process.env.SAMPLES ?? 5);
if (!Number.isInteger(samples) || samples < 1) throw new Error('SAMPLES must be positive');
const timeout = Number(process.env.COMMAND_TIMEOUT_MS ?? 300_000);
if (!Number.isFinite(timeout) || timeout < 1) throw new Error('COMMAND_TIMEOUT_MS must be positive');
const selected = (process.env.FAMILIES ?? 'status,diff,add,commit,checkout,log').split(',');
const repositories = [
  { name: 'express', url: 'https://github.com/expressjs/express', readme: 'Readme.md' },
  { name: 'TypeScript', url: 'https://github.com/microsoft/TypeScript', readme: 'README.md' },
  { name: 'vscode', url: 'https://github.com/microsoft/vscode', readme: 'README.md' },
].filter((r) => !process.env.REPOS || process.env.REPOS.split(',').includes(r.name));
if (repositories.length === 0) throw new Error('REPOS selected no repository');
const backends = ['javascript', 'wasi'].filter((b) => !process.env.BACKENDS || process.env.BACKENDS.split(',').includes(b));
if (backends.length === 0) throw new Error('BACKENDS selected no backend');
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let markerId = 0;

async function command(terminal, label, text, limit = timeout) {
  const marker = `__GIT_BENCH_RC_${++markerId}__`;
  const result = await terminal.run(`${text}; echo ${marker}=$?`, limit);
  const body = termBody(result.output).replace(/\r/g, '');
  const match = new RegExp(`(?:^|\\n)${marker}=(\\d+)(?:\\n|$)`).exec(body);
  if (!match) throw new Error(`${label}: no completion marker: ${body.slice(-400)}`);
  const status = Number(match[1]);
  if (status !== 0) throw new Error(`${label}: exit ${status}: ${body.slice(-400)}`);
  return { wallMs: result.elapsed, body: body.replace(match[0], '\n').trimEnd() };
}

const workloads = (repo) => {
  const path = `repo/${repo.readme}`;
  const edit = `printf '\\nNimbus benchmark\\n' >> ${quote(path)}`;
  const restore = `git -C repo checkout -- ${quote(repo.readme)}`;
  return {
    status: { prepare: edit, run: 'git -C repo status --porcelain', clean: restore },
    diff: { prepare: edit, run: 'git -C repo diff --stat', clean: restore },
    add: { prepare: edit, run: 'git -C repo add -A', clean: 'git -C repo reset --hard -q HEAD' },
    commit: { prepare: `${edit} && git -C repo add -A`, run: 'git -C repo commit -q -m benchmark', clean: null },
    // A branch transition changes the README and preserves the rest of the
    // repository, so both backends do actual worktree/index work.
    checkout: {
      prepare: 'git -C repo branch benchmark-base && git -C repo checkout -b benchmark-topic',
      change: `${edit} && git -C repo add -A && git -C repo commit -q -m checkout-fixture`,
      run: 'git -C repo checkout benchmark-base',
      clean: 'git -C repo checkout benchmark-topic',
    },
    log: { prepare: null, run: 'git -C repo log --format=%H --all > /home/user/benchmark-log', clean: null },
  };
};
for (const family of selected) if (!(family in workloads(repositories[0]))) throw new Error(`unknown family ${family}`);

async function measure(repo, backend, fullHistory, families) {
  const sid = await mintSession();
  const terminal = new Terminal(sid);
  console.log(JSON.stringify({ event: 'session', repo: repo.name, backend, fullHistory, sid }));
  try {
    await terminal.connect();
    await terminal.waitForPrompt(60_000);
    const clone = await command(terminal, 'clone', `git clone ${fullHistory ? '--no-shallow' : '--depth 1'} ${quote(repo.url)} repo`, 3_600_000);
    const head = (await command(terminal, 'cloned HEAD', 'git -C repo rev-parse HEAD')).body.trim();
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error(`cannot identify cloned commit: ${head.slice(-200)}`);
    console.log(JSON.stringify({ event: 'clone', repo: repo.name, backend, fullHistory, sid, head, wallMs: clone.wallMs }));
    if (backend === 'wasi') {
      await command(terminal, 'install lane Git', 'nimbus install git', 180_000);
      const hash = await command(terminal, 'installed artifact', 'sha256sum /home/user/.nimbus/runtimes/git/2.53.0/share/git/git.wasm');
      if (hash.body.split(/\s+/)[0] !== expectedWasm) throw new Error(`installed git.wasm is not this lane's ${expectedWasm}`);
      const version = await command(terminal, 'Git version', 'git --version');
      if (!version.body.includes('git version 2.53.0')) throw new Error(`wrong Git: ${version.body}`);
    }
    await command(terminal, 'identity', 'git -C repo config user.name Benchmark && git -C repo config user.email benchmark@example.invalid');
    const plans = workloads(repo);
    for (const family of families) {
      const plan = plans[family];
      const latencies = [];
      const start = new Date().toISOString();
      try {
        if (family === 'checkout') {
          await command(terminal, 'checkout fixture', plan.prepare);
          await command(terminal, 'checkout fixture change', plan.change);
        }
        // One warm-up, then measured commands. Preparation and cleanup are
        // outside the latency sample; timestamps keep their memory cost clear.
        for (let n = -1; n < samples; n++) {
          if (plan.prepare && family !== 'checkout') await command(terminal, `${family} prepare`, plan.prepare);
          const result = await command(terminal, family, plan.run);
          if (n >= 0) latencies.push(result.wallMs);
          if (plan.clean) await command(terminal, `${family} clean`, plan.clean);
        }
        console.log(JSON.stringify({
          event: 'measurement', repo: repo.name, backend, fullHistory, sid, head, family,
          start, end: new Date().toISOString(), latenciesMs: latencies, medianMs: median(latencies),
          memory: { status: 'unmeasured', source: 'Cloudflare durableObjectsPeriodicGroups.max.memoryUsageBytes', sid, start },
        }));
      } catch (error) {
        console.log(JSON.stringify({ event: 'failed', repo: repo.name, backend, fullHistory, sid, head, family, start, end: new Date().toISOString(), error: error.message, partialLatenciesMs: latencies }));
        throw error;
      }
    }
  } finally {
    await terminal.close().catch(() => {});
    const cleanup = await deleteSession(sid);
    console.log(JSON.stringify({ event: 'cleanup', sid, confirmed: cleanup.ok, status: cleanup.status }));
    if (!cleanup.ok) throw new Error(`session ${sid} was not deleted`);
  }
}

let failed = false;
for (const repo of repositories) {
  for (const backend of backends) {
    try { await measure(repo, backend, false, selected.filter((family) => family !== 'log')); }
    catch (error) { failed = true; console.error(`${repo.name}/${backend}: ${error.message}`); }
  }
}
// History's gate is the FULL vscode repository, never its depth-1 clone.
if (selected.includes('log')) {
  const vscode = repositories.find((repo) => repo.name === 'vscode');
  if (!vscode) throw new Error('the log gate requires REPOS to include vscode');
  for (const backend of backends) {
    try { await measure(vscode, backend, true, ['log']); }
    catch (error) { failed = true; console.error(`vscode-full/${backend}: ${error.message}`); }
  }
}
if (failed) process.exitCode = 1;
