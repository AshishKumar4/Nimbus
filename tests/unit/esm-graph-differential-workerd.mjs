// @serial
// @tier slow — drives a local workerd
// A hosted program's ES module graphs evaluate in Node's order, whatever the
// kind of each module (audit RTM-4, SHI-M1, SHI-M2; core runtime/esm-graph.ts):
// seeded random graphs mixing files the program writes (the interpreter's),
// files staged with the launch (the registry's, or the interpreter's where
// their graph reaches a file written later, a staged module's static import
// of one included), a query's instance, data:
// modules, CommonJS modules, top-level await and a module that throws, each
// module logging as it runs and as its top-level await completes. Host Node
// running the same files is the oracle: the logs are compared graph by graph.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const GRAPHS = 40;
let seed = 0x9e3779b9;
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (weights) => {
  let at = random() * weights.reduce((sum, [, w]) => sum + w, 0);
  for (const [value, w] of weights) if ((at -= w) < 0) return value;
  return weights[weights.length - 1][0];
};

// Each graph: modules m0..mN, each { kind, deps, tla, throws }; m0 the root, never CommonJS or data:.
const graphs = [];
for (let g = 0; g < GRAPHS; g++) {
  const size = 2 + Math.floor(random() * 5);
  const modules = [];
  for (let i = 0; i < size; i++) {
    const kind = i === 0 ? pick([['file', 3], ['staged', 2]]) : pick([['file', 3], ['staged', 3], ['query', 1], ['cjs', 1], ['data', 1]]);
    modules.push({ kind, deps: [], tla: kind !== 'cjs' && random() < 0.2, throws: false });
  }
  for (let i = 0; i < size; i++) {
    if (modules[i].kind === 'cjs') continue;
    for (let j = 0; j < size; j++) {
      if (j === i || random() >= 0.35) continue;
      // A data: module's URL holds what it imports: data: modules import only lower data: modules (no cycle of URLs).
      if (modules[i].kind === 'data' && modules[j].kind === 'data' && j > i) continue;
      modules[i].deps.push(j);
    }
  }
  if (random() < 0.3) {
    // One the root reaches, so its throw is seen.
    const reached = new Set([0]);
    for (const at of reached) for (const dep of modules[at].deps) reached.add(dep);
    const candidates = [...reached].filter((i) => modules[i].kind !== 'cjs' && !modules[i].tla);
    if (candidates.length > 0) modules[candidates[Math.floor(random() * candidates.length)]].throws = true;
  }
  graphs.push(modules);
}

/**
 * The files of every graph under `root` (a file: URL with its slash): those staged with the launch, and those the
 * program writes as it runs (its runtime files), and each graph's root URL.
 */
function filesAt(root) {
  const staged = {};
  const runtime = {};
  const roots = [];
  for (const [g, modules] of graphs.entries()) {
    const urls = [];
    const name = (i) => `g${g}/m${i}${modules[i].kind === 'cjs' ? '.cjs' : '.mjs'}`;
    const body = (i) => {
      const m = modules[i];
      const lines = [`globalThis.log.push('m${i}');`];
      if (m.tla) lines.push(`await null; globalThis.log.push('m${i}$');`);
      if (m.throws) lines.push(`throw new Error('m${i}');`);
      return lines;
    };
    // data: URLs, lowest first (each holds what it imports).
    const url = (i) => urls[i];
    for (let i = 0; i < modules.length; i++) {
      const m = modules[i];
      urls[i] = m.kind === 'data' ? null : m.kind === 'query' ? `${root}${name(i)}?q` : `${root}${name(i)}`;
    }
    for (let i = 0; i < modules.length; i++) {
      if (modules[i].kind !== 'data') continue;
      const text = [...modules[i].deps.map((j) => `import ${JSON.stringify(url(j))};`), ...body(i)].join(' ');
      urls[i] = 'data:text/javascript,' + encodeURIComponent(text);
    }
    for (let i = 0; i < modules.length; i++) {
      const m = modules[i];
      if (m.kind === 'data') continue;
      const text = m.kind === 'cjs' ? body(i).join('\n') + '\n'
        : [...m.deps.map((j) => `import ${JSON.stringify(url(j))};`), ...body(i)].join('\n') + '\n';
      (m.kind === 'staged' || m.kind === 'cjs' ? staged : runtime)[name(i)] = text;
    }
    roots.push(urls[0]);
  }
  return { staged, runtime, roots };
}

/** The program: it writes its runtime files, then imports each graph's root in turn, logging what each graph ran. */
function program(root) {
  const { staged, runtime, roots } = filesAt(root);
  // Named in a literal import() it never makes: the launch stages them (the files every graph's staged modules are).
  const stagedNames = Object.keys(staged).filter((name) => name.endsWith('.mjs'));
  const main = `import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
if (globalThis.never) { ${stagedNames.map((name) => `await import('./${name}');`).join(' ')} }
const runtime = ${JSON.stringify(runtime)};
for (const [name, text] of Object.entries(runtime)) { mkdirSync(dirname(name), { recursive: true }); writeFileSync(name, text); }
const out = [];
for (const root of ${JSON.stringify(roots)}) {
  globalThis.log = [];
  try { await import(root); } catch (e) { globalThis.log.push('!' + e.message); }
  out.push(globalThis.log);
}
console.log('GRAPHS ' + JSON.stringify(out));
`;
  return { ...staged, 'main.mjs': main };
}
const report = (stdout) => {
  const line = stdout.split('\n').find((text) => text.startsWith('GRAPHS '));
  if (line === undefined) throw new Error(`no report in:\n${stdout}`);
  return JSON.parse(line.slice('GRAPHS '.length));
};

// ── The oracle: host Node ──────────────────────────────────────────────────
const host = mkdtempSync(join(tmpdir(), 'esm-graph-differential-'));
let expected;
try {
  for (const [name, text] of Object.entries(program(pathToFileURL(host).href + '/'))) {
    mkdirSync(dirname(join(host, name)), { recursive: true });
    writeFileSync(join(host, name), text);
  }
  const ran = spawnSync('node', ['main.mjs'], { cwd: host, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  expected = report(ran.stdout);
} finally {
  rmSync(host, { recursive: true, force: true });
}
assert.ok(expected.some((log) => log.some((entry) => entry.endsWith('$'))), 'the graphs await');
assert.ok(expected.some((log) => log.some((entry) => entry.startsWith('!'))), 'and throw');

// ── The session ────────────────────────────────────────────────────────────
const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(program('file:///home/user/'))).toString('base64');
    const setup = await session.run(
      `cd /home/user && node -e "const f=JSON.parse(Buffer.from('${payload}','base64').toString());for(const [n,t] of Object.entries(f)){require('fs').mkdirSync(require('path').dirname(n),{recursive:true});require('fs').writeFileSync(n,t)}console.log('SETUP')"`,
    );
    assert.equal(setup.status, 0, setup.stdout);
    const ran = await session.run('cd /home/user && node main.mjs', 240_000);
    assert.equal(ran.status, 0, ran.stdout);
    const ours = report(ran.stdout);
    const differ = [];
    for (let g = 0; g < GRAPHS; g++) {
      if (JSON.stringify(ours[g]) !== JSON.stringify(expected[g])) {
        differ.push(`graph ${g} ${JSON.stringify(graphs[g])}\n  node: ${JSON.stringify(expected[g])}\n  ours: ${JSON.stringify(ours[g])}`);
      }
    }
    assert.deepEqual(differ, [], `graphs evaluated unlike host Node:\n${differ.join('\n')}`);
  } finally {
    await session.close();
  }
} finally {
  await probe.stop();
}
console.log(`ok - esm-graph-differential-workerd (${GRAPHS} random graphs of written, staged, query, data:, CommonJS and awaiting modules, in host Node's order)`);
