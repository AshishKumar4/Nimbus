// The file engine's measurements, on a throwaway built from work/measure-file-engine:
// one session at a time, every command in a window of its own, so the guest
// tail's lines (CPU, outcome, store measures) join to it by time.
//   BASE=… NIMBUS_PROBE_TOKEN=… GROUPS=host,backing,mem,workloads,recall REPS=6 bun _file-engine-measure.mjs
// Prints one JSON line per command: {group, label, arm, rep, sid, start, end, ms, exit, tail}
// and, for the recall group, the session's delegation stats around each scenario.
import { mintSession, deleteSession, Terminal, sleep, requestHeaders, BASE } from '../../_driver.mjs';
import { diagMemory } from '../../heap-correctness/_diag.mjs';

const REPS = Number(process.env.REPS ?? 6);
const GAP_MS = 1500;
const groups = (process.env.GROUPS ?? 'host,backing,mem,workloads,recall').split(',');
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const out = (record) => console.log(JSON.stringify(record));

async function inSession(fn) {
  const sid = await mintSession();
  const t = new Terminal(sid);
  try {
    await t.connect();
    await t.waitForPrompt(60_000);
    const result = await fn(t, sid);
    // A resident's trace reaches the tail when its facet goes: the session's
    // last one goes with the session, so the session waits a moment first.
    await t.run("node -e 0", 60_000).catch(() => {});
    await sleep(5000);
    return result;
  } catch (error) {
    out({ error: String(error?.message ?? error).slice(0, 2000), sid });
  } finally {
    await t.close().catch(() => {});
    await deleteSession(sid).catch(() => {});
  }
}

async function step(t, sid, record, line, timeoutMs = 600_000) {
  await sleep(GAP_MS);
  const start = new Date().toISOString();
  const r = await t.run(line, timeoutMs);
  const end = new Date().toISOString();
  out({ ...record, sid, start, end, ms: r.elapsed, exit: r.exitCode, tail: r.output.slice(-400) });
  await sleep(GAP_MS);
  return r;
}

const setup = (t, line, timeoutMs = 600_000) => t.run(line, timeoutMs);

// A tree a program reads: 20 directories of 50 files of 1 KiB, and 20 of 64 KiB.
const TREE = "mkdir -p tree/big && for d in $(seq 1 20); do mkdir -p tree/d$d; for f in $(seq 1 50); do head -c 1024 /dev/urandom | base64 > tree/d$d/f$f; done; done && for f in $(seq 1 20); do head -c 65536 /dev/urandom | base64 > tree/big/b$f; done";

const NODE_WORK = `const fs = require('fs');
let bytes = 0, stats = 0;
const dirs = fs.readdirSync('tree');
for (let pass = 0; pass < 3; pass++) for (const d of dirs) for (const f of fs.readdirSync('tree/' + d)) { bytes += fs.readFileSync('tree/' + d + '/' + f).length; stats += fs.statSync('tree/' + d + '/' + f).size > 0; }
fs.mkdirSync('out', { recursive: true });
for (let i = 0; i < 100; i++) fs.writeFileSync('out/w' + i, 'x'.repeat(1024) + i);
for (let i = 0; i < 100; i++) bytes += fs.readFileSync('out/w' + i).length;
console.log('work', bytes, stats);
`;

const PY_WORK = `import os
total = 0
for p in range(3):
    for d in sorted(os.listdir('tree')):
        for f in sorted(os.listdir('tree/' + d)):
            with open('tree/' + d + '/' + f, 'rb') as h: total += len(h.read())
            total += os.stat('tree/' + d + '/' + f).st_size > 0
os.makedirs('out', exist_ok=True)
for i in range(100):
    with open('out/w%d' % i, 'w') as h: h.write('x' * 1024 + str(i))
for i in range(100):
    with open('out/w%d' % i) as h: total += len(h.read())
print('work', total)
`;

// Allocates 1 MiB at a time, yielding each time so what it said reaches the
// session, until the isolate dies; the last count is its headroom.
const NODE_MEM = `const fs = require('fs');
let held = 0;
if (process.env.FILL) for (const d of fs.readdirSync('tree')) for (const f of fs.readdirSync('tree/' + d)) held += fs.readFileSync('tree/' + d + '/' + f).length;
const blocks = [];
(async () => {
  for (let i = 1; i <= 2048; i++) {
    blocks.push(new Uint8Array(1 << 20).fill(i & 255));
    globalThis.__nimbusHostConsole?.log('[mem-probe] ' + i);
    process.stdout.write('M ' + i + '\\n');
    await new Promise((r) => setTimeout(r, 0));
  }
})();
`;

const PY_IMPORTS = 'import email.parser, http.client, json, decimal, asyncio, unittest, xml.dom.minidom, sqlite3, argparse, logging; print(1)';
const RB_REQUIRES = "require 'json'; require 'set'; require 'time'; require 'fileutils'; require 'optparse'; puts 1";

const HELLO_C = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
int main(void) { char b[64]; snprintf(b, sizeof b, "%.3f", sqrt(2.0)); printf("%s %zu\\n", b, strlen(b)); return 0; }
`;

const BASH_SCRIPT = `set -e
mkdir -p bdir
for i in $(seq 1 200); do echo "line $i" > bdir/f$i.txt; done
n=0
for f in bdir/*.txt; do read -r l < "$f"; n=$((n + \${#l})); done
for i in $(seq 1 50); do [ -f bdir/f$i.txt ] && : ; done
echo "bash $n"
`;

const heredoc = (path, body) => `cat > ${path} <<'NIMBUS_EOF'\n${body}NIMBUS_EOF`;

/** The same program as a one-shot (a Loader worker) and as a resident facet, cold and warm, each arm in a fresh session. */
async function host() {
  const arms = [
    { runtime: 'node', label: 'trivial', arm: 'loader', line: "node -e 'console.log(1)'" },
    { runtime: 'node', label: 'trivial', arm: 'facet', line: "NIMBUS_MEASURE_HOST=facet node -e 'console.log(1)'" },
    { runtime: 'node', label: 'work', arm: 'loader', line: 'node work.js', files: true },
    { runtime: 'node', label: 'work', arm: 'facet', line: 'NIMBUS_MEASURE_HOST=facet node work.js', files: true },
    { runtime: 'python', label: 'imports', arm: 'loader', line: `python3 -c "${PY_IMPORTS}"` },
    { runtime: 'python', label: 'imports', arm: 'facet', line: 'python3 imports.py' },
    { runtime: 'ruby', label: 'requires', arm: 'loader', line: `ruby -e "${RB_REQUIRES}"` },
    { runtime: 'ruby', label: 'requires', arm: 'facet', line: 'ruby requires.rb' },
  ];
  for (const a of arms) {
    if (only && !only.has(`${a.runtime}-${a.label}`)) continue;
    await inSession(async (t, sid) => {
      if (a.runtime === 'python') await setup(t, 'nimbus install python');
      if (a.runtime === 'ruby') await setup(t, 'nimbus install ruby');
      if (a.files) { await setup(t, TREE); await setup(t, heredoc('work.js', NODE_WORK)); }
      await setup(t, heredoc('imports.py', PY_IMPORTS + '\n'));
      await setup(t, heredoc('requires.rb', RB_REQUIRES + '\n'));
      for (let rep = 0; rep < REPS; rep++) await step(t, sid, { group: 'host', runtime: a.runtime, label: a.label, arm: a.arm, rep, cold: rep === 0 }, a.line);
      await setup(t, a.line);
    });
  }
}

/** One resident program's store on its facet's SQLite and on its heap, alternating in one session. */
async function backing() {
  const cases = [
    { runtime: 'node', setupLines: [TREE, heredoc('work.js', NODE_WORK)], arms: { sql: 'NIMBUS_MEASURE_HOST=facet node work.js', heap: 'NIMBUS_MEASURE_HOST=facet NIMBUS_MEASURE_STORE=heap node work.js', loader: 'node work.js' } },
    { runtime: 'python', setupLines: ['nimbus install python', TREE, heredoc('work.py', PY_WORK)], arms: { heap: 'python3 work.py', sql: 'NIMBUS_MEASURE_STORE=sql python3 work.py', loader: `python3 -c "exec(open('work.py').read())"` } },
  ];
  for (const c of cases) {
    if (only && !only.has(c.runtime)) continue;
    await inSession(async (t, sid) => {
      for (const line of c.setupLines) await setup(t, line);
      for (let rep = 0; rep < REPS; rep++) {
        for (const [arm, line] of Object.entries(c.arms)) await step(t, sid, { group: 'backing', runtime: c.runtime, arm, rep }, `rm -rf out; ${line}`);
      }
    });
  }
}

/** Headroom: how much more a process could allocate after its start (and after filling its store), per host and backing. */
async function mem() {
  const arms = {
    loader: 'node mem.js',
    'loader-fill': 'FILL=1 node mem.js',
    'facet-sql': 'NIMBUS_MEASURE_HOST=facet node mem.js',
    'facet-sql-fill': 'NIMBUS_MEASURE_HOST=facet FILL=1 node mem.js',
    'facet-heap-fill': 'NIMBUS_MEASURE_HOST=facet NIMBUS_MEASURE_STORE=heap FILL=1 node mem.js',
  };
  for (const [arm, line] of Object.entries(arms)) {
    if (only && !only.has(arm)) continue;
    for (let rep = 0; rep < Math.min(REPS, 2); rep++) {
      await inSession(async (t, sid) => {
        await setup(t, TREE);
        await setup(t, heredoc('mem.js', NODE_MEM));
        const r = await step(t, sid, { group: 'mem', arm, rep }, line, 300_000);
        const counts = [...r.output.matchAll(/^M (\d+)/gm)].map((m) => Number(m[1]));
        out({ group: 'mem', arm, rep, sid, headroomMiB: counts.length ? Math.max(...counts) : null });
      });
    }
  }
}

/** The real workloads: what each process's store held against its cap, how its reads were answered, and its CPU. */
async function workloads() {
  const list = [
    { name: 'python-import', setupLines: ['nimbus install python'], steps: [[`python3 -c "${PY_IMPORTS}"`, 3]] },
    { name: 'pip-install', setupLines: ['nimbus install python'], steps: [['pip install requests', 1], ['python3 -c "import requests; print(requests.__version__)"', 2]] },
    { name: 'gem-install', setupLines: ['nimbus install ruby'], steps: [['gem install rack', 1], ["ruby -e \"require 'rack'; puts Rack::RELEASE\"", 2]] },
    { name: 'clang', setupLines: ['nimbus install clang', heredoc('hello.c', HELLO_C)], steps: [['clang -O1 -o hello hello.c -lm', 3], ['./hello', 1]] },
    { name: 'bash', setupLines: ['nimbus install bash', heredoc('script.sh', BASH_SCRIPT)], steps: [['rm -rf bdir; bash script.sh', 3]] },
    { name: 'git', setupLines: [], steps: [['git clone https://github.com/AshishKumar4/markflow.git mf', 1], ['cd mf && git status && cd ..', 3], ['cd mf && echo x >> README.md && git status --short && git checkout README.md && cd ..', 1]] },
    { name: 'npm-install', setupLines: [], steps: [['cd example-app && npm install; cd ..', 1], ['cd example-app && rm -rf node_modules && npm install; cd ..', 1]] },
  ];
  for (const w of list) {
    if (only && !only.has(w.name)) continue;
    await inSession(async (t, sid) => {
      for (const line of w.setupLines) await setup(t, line);
      for (const [line, times] of w.steps) {
        for (let rep = 0; rep < times; rep++) await step(t, sid, { group: 'workloads', workload: w.name, label: line.slice(0, 60), rep }, line);
      }
    });
  }
}

const delegations = async (sid) => (await diagMemory(sid).catch((e) => ({ error: String(e) })))?.delegations ?? null;

async function previewServed(sid, budgetMs = 120_000) {
  const t0 = Date.now();
  const served = new RegExp(`<base href="/s/${sid}/preview/`);
  while (Date.now() - t0 < budgetMs) {
    const r = await fetch(`${BASE}/s/${sid}/preview/`, { redirect: 'manual', headers: requestHeaders({}, sid) }).catch(() => null);
    const body = r ? await r.text() : '';
    if (r?.status === 200 && served.test(body)) return Date.now() - t0;
    await sleep(100);
  }
  return null;
}

/** Files held by one process and changed by another: the dev server under edits, a writer under readers. */
async function recall() {
  await inSession(async (t, sid) => {
    await setup(t, 'cd example-app && npm install', 600_000);
    const before = await delegations(sid);
    const start = new Date().toISOString();
    t.reset();
    t.cmd('npm run dev');
    const firstPaint = await previewServed(sid);
    out({ group: 'recall', scenario: 'dev-server-start', sid, start, end: new Date().toISOString(), firstPaintMs: firstPaint, delegations: { before, after: await delegations(sid) } });
    const tab = new Terminal(sid);
    await tab.connect();
    await tab.waitForPrompt(60_000);
    try {
      const files = (await tab.run('ls src', 30_000)).output;
      const source = /\b(main\.[jt]sx?|App\.[jt]sx?|index\.[jt]sx?)\b/.exec(files)?.[1] ?? 'main.js';
      const edits = await delegations(sid);
      const editStart = new Date().toISOString();
      for (let i = 0; i < 10; i++) {
        await tab.run(`echo '// edit ${i}' >> src/${source}`, 60_000);
        await previewServed(sid, 30_000);
        await sleep(500);
      }
      out({ group: 'recall', scenario: 'edits-under-dev-server', sid, start: editStart, end: new Date().toISOString(), source, delegations: { before: edits, after: await delegations(sid) } });
      const statusBefore = await delegations(sid);
      const statusStart = new Date().toISOString();
      for (let i = 0; i < 3; i++) await tab.run('git init -q 2>/dev/null; git status --short | head -3', 120_000);
      out({ group: 'recall', scenario: 'git-status-under-dev-server', sid, start: statusStart, end: new Date().toISOString(), delegations: { before: statusBefore, after: await delegations(sid) } });
    } finally {
      await tab.close().catch(() => {});
    }
  });
  await inSession(async (t, sid) => {
    await setup(t, 'nimbus install python');
    await setup(t, heredoc('writer.py', "import time\nfor i in range(40):\n    with open('shared.txt', 'w') as h: h.write('v%d\\n' % i)\n    time.sleep(0.25)\nprint('done')\n"));
    const before = await delegations(sid);
    const start = new Date().toISOString();
    t.reset();
    t.cmd('python3 writer.py');
    const tab = new Terminal(sid);
    await tab.connect();
    await tab.waitForPrompt(60_000);
    try {
      await sleep(1000);
      for (let i = 0; i < 16; i++) { await tab.run('cat shared.txt', 30_000); await sleep(400); }
    } finally {
      await tab.close().catch(() => {});
    }
    await t.waitFor((text) => /done/.test(text), 120_000, 'writer done').catch(() => {});
    out({ group: 'recall', scenario: 'reader-under-python-writer', sid, start, end: new Date().toISOString(), delegations: { before, after: await delegations(sid) } });
  });
}

const run = { host, backing, mem, workloads, recall };
for (const g of groups) await run[g]();
