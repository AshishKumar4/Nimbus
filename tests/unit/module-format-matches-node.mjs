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
// An ES module has none of CommonJS's names. Using one throws V8's
// ReferenceError ("require is not defined") from the module's own frame,
// and Node's loader completes the message where it leaves the module's job
// (an entry, an import(), a require() of it): "in ES module scope", the
// package.json that made a .js a module, or top-level await's ambiguity.
// The runtime said "require_is_not_defined_in_ES_module_scope is not
// defined", a name it made up. An entry's first frame is compared here; a
// module the entry loads names its own frame in the guest's registry, which
// es-module-scope-errors-workerd runs.
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
import { SEED_FILES, SEED_PROJECT_DIR } from '../../packages/core/src/vfs/seed-project.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';

const ROOT = '/home/user/fmt';
const line = (...parts) => `console.log(JSON.stringify([${parts.join(', ')}]));\n`;
// What an ES module's scope is: strict, no `this`, no CommonJS wrapper name.
const SCOPE_PARTS = [
  'this === undefined', '(function () { return this; })() === undefined',
  'typeof require', 'typeof module', 'typeof exports', 'typeof __filename', 'typeof __dirname',
];
const SCOPE = (label) => line(`'${label}'`, ...SCOPE_PARTS);
const SCOPE_DEP = (name) => `globalThis.${name} = [${SCOPE_PARTS.join(', ')}];\n`;
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
  // An ES module by its extension or its package's "type", whatever its
  // syntax: strict, `this` undefined, none of CommonJS's wrapper names.
  'plain.mjs': SCOPE('mjs'),
  'typed/package.json': JSON.stringify({ name: 'typed', type: 'module' }),
  'typed/plain.js': SCOPE('type-module'),
  'typed/dep.js': SCOPE_DEP('typedDep'),
  'plain-dep.mjs': SCOPE_DEP('mjsDep'),
  'deps.cjs': `import('./plain-dep.mjs').then(() => import('./typed/dep.js')).then(() => { ${line("'deps'", 'globalThis.mjsDep', 'globalThis.typedDep').trim()} });\n`,
  // One with module syntax, and one that makes its own require.
  'esm-scope.mjs': `import { sep } from 'node:path';\n${line("'esm-scope'", 'typeof require', 'typeof exports', 'typeof __filename', 'sep')}`,
  'own-require.mjs': `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n${line("'own-require'", 'typeof require', "require('node:path').sep")}`,
  // What Node refuses: a require in an ES module, an import in a .cjs or a type:commonjs .js.
  'require-in-esm.mjs': "require('node:path');\n",
  // What a CommonJS name in an ES module throws: V8's ReferenceError, which
  // Node's loader explains where it leaves the module's job (an entry, an
  // import(), a require()), naming the package that made a .js a module, or
  // naming top-level await; anywhere else it is V8's own.
  'typed/module-exports.js': 'module.exports = 1;\n',
  'chain.mjs': "import './typed/module-exports.js';\n",
  'tla-require.mjs': "await 1;\nrequire('node:path');\n",
  'tla-scope.mjs': `await 0;\n${SCOPE('tla-scope')}`,
  'caught.mjs': 'try { exports.x = 1; } catch (e) { globalThis.caught = [e.name, e.message]; }\nexport {};\n',
  'later.mjs': "process.on('uncaughtException', (e) => { console.log(JSON.stringify(['later', e.name, e.message])); });\nsetTimeout(() => { __dirname; }, 0);\nexport {};\n",
  'scope-errors.cjs': `const report = [];
try { require('./require-in-esm.mjs'); } catch (e) { report.push(['require', e.name, e.message, e.code ?? null]); }
import('./typed/module-exports.js').catch((e) => { report.push(['import', e.name, e.message, e.code ?? null]); })
  .then(() => import('./tla-require.mjs')).catch((e) => { report.push(['tla', e.name, e.message, e.code ?? null]); })
  .then(() => import('./caught.mjs')).then(() => { report.push(['caught', ...globalThis.caught]); console.log(JSON.stringify(report)); });
`,
  'import-in.cjs': "import { sep } from 'node:path';\nconsole.log(sep);\n",
  // The starter a session is seeded with: its JavaScript is correct Node in
  // the module format its package.json gives it (a Vite project, "type":
  // "module"), and loads as node loads it.
  ...Object.fromEntries(SEED_FILES.filter(({ path }) => /\.(?:m?js|cjs|json)$/.test(path))
    .map(({ path, content }) => [`example-app/${path.slice(SEED_PROJECT_DIR.length + 1)}`, content])),
  'seed.mjs': `import { readFileSync } from 'node:fs';\nimport config from './example-app/tailwind.config.js';\nconst pkg = JSON.parse(readFileSync(new URL('./example-app/package.json', import.meta.url), 'utf8'));\n${line("'seed'", 'pkg.type', 'config')}`,
  'commonjs/package.json': JSON.stringify({ name: 'commonjs', type: 'commonjs' }),
  'commonjs/import.js': "import { sep } from 'node:path';\nconsole.log(sep);\n",
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
  ['--input-type', 'module', '-e', line("'input-type spaced'", 'typeof import.meta', 'typeof require')],
  ['-', { stdin: `import { sep } from 'node:path';\n${line("'stdin'", 'sep')}` }],
  ['plain.mjs'],
  ['typed/plain.js'],
  ['deps.cjs'],
  ['esm-scope.mjs'],
  ['own-require.mjs'],
  ['seed.mjs'],
  ['tla-scope.mjs'],
  ['scope-errors.cjs'],
  ['later.mjs'],
  ['require-in-esm.mjs', { fails: true }],
  ['typed/module-exports.js', { fails: true }],
  ['chain.mjs', { fails: true }],
  ['--input-type=module', '-e', "require('node:path');\n", { fails: true }],
  ['import-in.cjs', { fails: true }],
  ['commonjs/import.js', { fails: true }],
];
const argsOf = (run) => run.filter((arg) => typeof arg === 'string');
const stdinOf = (run) => run.find((arg) => typeof arg === 'object')?.stdin;
const failsWith = (run) => run.find((arg) => typeof arg === 'object')?.fails === true;
// What an uncaught error prints, as \`<Name>: <message>\` and any lines of the
// message, up to its first frame; and the file of that frame.
function uncaught(text) {
  const block = /^[A-Z]\w*Error(?::[^\n]*)?(?:\n(?!    at )[^\n]+)*/m.exec(text)?.[0] ?? null;
  const frame = block === null ? '' : text.slice(text.indexOf(block) + block.length).split('\n').find((l) => l.startsWith('    at ')) ?? '';
  return { block, frame: /([^/\s:()]+):\d+:\d+\)?$/.exec(frame)?.[1] ?? null };
}

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
    // What node says of the tree, said of the session's.
    const here = (text) => text.replaceAll(disk, ROOT);
    if (failsWith(run)) {
      assert.notEqual(node.status, 0, `premise: node ${argsOf(run).join(' ')} fails`);
      const error = uncaught(here(node.stderr));
      assert.ok(error.block, `premise: node ${argsOf(run).join(' ')} prints an error: ${node.stderr}`);
      expected.push(error);
      continue;
    }
    assert.equal(node.status, 0, `node ${argsOf(run).join(' ')}: ${node.stderr}`);
    expected.push(JSON.parse(here(node.stdout.trim().split('\n').at(-1))));
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
  if (failsWith(run)) {
    assert.notEqual(exitCode, 0, `${label} fails, as in node: ${stdout}${out}`);
    const error = uncaught(stderr + out + stdout);
    assert.equal(error.block, expected[i].block, `${label} throws what node throws: ${stderr}${out}`);
    // The frame the error names first is the entry's, where the entry threw,
    // as node's is (\`-e\` code is no file: node names it [eval1]).
    if (expected[i].frame === argsOf(run)[0].split('/').at(-1)) {
      assert.equal(error.frame, expected[i].frame, `${label}: the first frame is the module's: ${stderr}${out}`);
    }
    continue;
  }
  const printed = (out + stdout).trim().split('\n').at(-1) ?? '';
  assert.ok(printed.startsWith('['), `${label} printed no report (exit ${exitCode}): ${stderr}${out}`);
  assert.equal(exitCode, 0, `${label}: ${stderr}${out}`);
  assert.deepEqual(JSON.parse(printed), expected[i], `${label} runs as node runs it`);
}

console.log(`module-format-matches-node: ${RUNS.length} sources run under the module system node gives them`);
