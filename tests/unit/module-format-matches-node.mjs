#!/usr/bin/env bun
// Which module system a source runs under is Node's answer (doc/api/packages.md
// "Determining module system"; syntax detection is on by default from
// v22.7.0): a file with no package "type" is an ES module when it holds
// syntax that only a module can (an import or export, import.meta, a
// top-level await, a top-level `const require`), and so is `-e` code or a
// program on stdin, unless --input-type says otherwise.
//
// The runtime used to read module syntax as a top-level import or export
// alone, and `-e` and stdin code not at all: a module whose only module
// syntax was import.meta ran as CommonJS and failed to compile ("Cannot use
// 'import.meta' outside a module"), required or imported, as did a script
// with a top-level await; `node --input-type=module -e "import …"` failed
// with "Cannot use import statement outside a module".
//
// One fixture tree, on disk for real node and in the session's filesystem for
// `node` through the runtime handler (the shell's command) and a one-shot
// launch (module-map walk, ESM→CJS transform, the facet): each run prints
// one JSON line, which must be node's.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildRuntimeHandler } from '../../packages/core/src/runtime/runtime-registry.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';

const ROOT = '/home/user/fmt';
const line = (...parts) => `console.log(JSON.stringify([${parts.join(', ')}]));\n`;
const files = {
  'package.json': JSON.stringify({ name: 'fmt', private: true }),
  // Typeless files whose only module syntax is one of Node's other kinds.
  'meta.js': line("'meta'", 'typeof import.meta.url', "import.meta.url.endsWith('/meta.js')"),
  'tla.js': line("'tla'", 'await Promise.resolve(1)'),
  'redeclare.js': `const require = 'mine';\n${line("'redeclare'", 'require')}`,
  // CommonJS that only looks like it: an await in an arrow's body, a function named await.
  'arrow.js': `const f = async () => await 1;\nf().then((v) => { ${line("'arrow'", 'typeof require', 'v').trim()} });\n`,
  'awaitcall.js': `function await(x) { return x; }\n${line("'awaitcall'", 'typeof require', 'await(2)')}`,
  // A module whose only module syntax is import.meta, imported, required, and installed.
  'meta-dep.js': "globalThis.metaDep = import.meta.url.endsWith('/meta-dep.js');\n",
  'imp.cjs': `import('./meta-dep.js').then(() => { ${line("'import'", 'globalThis.metaDep').trim()} });\n`,
  'meta-req.js': 'globalThis.metaReq = typeof import.meta.url;\n',
  'req.cjs': `require('./meta-req.js');\n${line("'require'", 'globalThis.metaReq')}`,
  'node_modules/metapkg/package.json': JSON.stringify({ name: 'metapkg', version: '1.0.0', main: 'index.js' }),
  'node_modules/metapkg/index.js': 'globalThis.metaPkg = typeof import.meta.url;\n',
  'pkg.cjs': `require('metapkg');\n${line("'package'", 'globalThis.metaPkg')}`,
};
const EVAL_ESM = `import { sep } from 'node:path';\n${line("'eval'", 'sep')}`;
const RUNS = [
  ['meta.js'],
  ['tla.js'],
  ['redeclare.js'],
  ['arrow.js'],
  ['awaitcall.js'],
  ['imp.cjs'],
  ['req.cjs'],
  ['pkg.cjs'],
  ['-e', EVAL_ESM],
  ['-e', line("'eval-commonjs'", 'typeof require')],
  ['--input-type=module', '-e', line("'input-type'", 'typeof import.meta.url')],
  ['--input-type', 'module', '-e', line("'input-type spaced'", 'typeof import.meta')],
  ['-', { stdin: `import { sep } from 'node:path';\n${line("'stdin'", 'sep')}` }],
];
const argsOf = (run) => run.filter((arg) => typeof arg === 'string');
const stdinOf = (run) => run.find((arg) => typeof arg === 'object')?.stdin;

// ── real node ────────────────────────────────────────────────────────────
const disk = realpathSync(mkdtempSync(join(tmpdir(), 'module-format-')));
const expected = [];
try {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(disk, rel)), { recursive: true });
    writeFileSync(join(disk, rel), text);
  }
  for (const run of RUNS) {
    const node = spawnSync('node', argsOf(run), { cwd: disk, input: stdinOf(run) ?? '', encoding: 'utf8' });
    assert.equal(node.status, 0, `node ${argsOf(run).join(' ')}: ${node.stderr}`);
    expected.push(JSON.parse(node.stdout.trim().split('\n').at(-1)));
  }
} finally {
  rmSync(disk, { recursive: true, force: true });
}

// ── node in the session ──────────────────────────────────────────────────
const { host, rawVfs, kfs } = createAuthority();
let out = '';
adoptSessionSupervisor(host, (text) => { out += text; });
const manager = oneShotManager('module-format-matches-node', { host, rawVfs, loader: runnerLoader('module-format') });
const { oxcEngine } = await import('./lib/oxc-engine.mjs');
const esbuild = new EsbuildService(undefined, { engine: async () => oxcEngine });
manager.setEsbuildService(esbuild);
for (const [rel, text] of Object.entries(files)) {
  const path = `${ROOT.slice(1)}/${rel}`;
  kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kfs.writeFile(path, text);
}
const handler = buildRuntimeHandler({
  name: 'node',
  version: 'v22.22.3',
  helpText: 'help',
  supportsBinSpawn: true,
  run: (code, opts) => manager.exec(code, { ...opts, captureOutput: true }),
}, { getEsbuild: () => esbuild, registry: { resolve: () => undefined } });

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
for (let i = 0; i < RUNS.length; i++) {
  const run = RUNS[i];
  out = '';
  let stdout = '';
  let stderr = '';
  let exitCode;
  try {
    const stdin = stdinOf(run);
    exitCode = await handler({
      vfs: kfs,
      args: argsOf(run),
      cwd: ROOT,
      env: { HOME: '/home/user', PATH: '/usr/local/bin:/usr/bin:/bin' },
      cred: CRED_SESSION_USER,
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } },
      ...(stdin !== undefined ? { stdin: { readAll: async () => stdin } } : {}),
    });
  } finally { Object.assign(globalThis, real); }
  const label = `node ${argsOf(run).join(' ').slice(0, 60)}`;
  const printed = (out + stdout).trim().split('\n').at(-1) ?? '';
  assert.ok(printed.startsWith('['), `${label} printed no report (exit ${exitCode}): ${stderr}${out}`);
  assert.equal(exitCode, 0, `${label}: ${stderr}${out}`);
  assert.deepEqual(JSON.parse(printed), expected[i], `${label} runs as node runs it`);
}

console.log(`module-format-matches-node: ${RUNS.length} sources run under the module system node gives them`);
