#!/usr/bin/env bun
// The lifo node runs an ES module through the shared CommonJS emitter
// (async-module-lowering.ts, as the transform and esbuild-service do), and
// answers as Node 22 does for the same files; each case runs in both where
// `node` is installed. Its own regex lowering rewrote `import.meta` inside
// strings, and threw a missing dynamic import() synchronously. Exports are
// live (a namespace reads `export let n` as the module last set it); a named
// import is read once, when the module is required, as the shared emitter
// reads it. A
// module's own `const __dirname`, `import process from`, or `const require =
// createRequire(...)` shadows the wrapper's names as module scope does, and
// the names the lowering generates are ones the module's text does not hold
// (a module declaring `__nimbusModule` ran into a TDZ). A CommonJS program's
// import() loads through the same loader, from the workspace (it was left
// to the host's native import(), which cannot see the workspace). import()
// answers what require does: of a CommonJS module, its exports, where Node's
// namespace would also carry them as `default`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const FILES = {
  'counter.mjs': 'export let n = 1;\nexport function inc() { n++; }\nexport default function () { return "anonymous default"; }\n',
  'meta.mjs': 'import { fileURLToPath } from "node:url";\nexport const same = import.meta.filename === fileURLToPath(import.meta.url) && import.meta.dirname + "/meta.mjs" === import.meta.filename;\nexport const text = "import.meta.url";\n',
  'shadow.mjs': [
    'import process from "node:process";',
    'import { createRequire } from "node:module";',
    'import { dirname } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'const __dirname = dirname(fileURLToPath(import.meta.url));',
    'const require = createRequire(import.meta.url);',
    'export const answer = [typeof process.cwd, __dirname.endsWith("esm"), require("./plain.cjs").value].join(" ");',
    '',
  ].join('\n'),
  'plain.cjs': 'exports.value = 42;\n',
  'detect.js': 'console.log("detected", typeof import.meta.url);\n',
  'main.mjs': [
    'import def, * as counter from "./counter.mjs";',
    'import * as meta from "./meta.mjs";',
    'import { answer } from "./shadow.mjs";',
    'counter.inc();',
    'console.log("live", counter.n, def());',
    'console.log("meta", meta.same, meta.text);',
    'console.log("shadow", answer);',
    'console.log("dynamic", (await import("./plain.cjs")).value);',
    'let threw = false;',
    'const pending = (() => { try { return import("./missing.mjs"); } catch { threw = true; } })();',
    'await pending?.then(() => console.log("loaded?"), () => console.log("rejected", threw));',
    '',
  ].join('\n'),
  'broken.mjs': 'export const = 1;\n',
  // A CommonJS program (no ESM syntax) whose import() reaches a workspace file.
  'dynamic.js': "import('./plain.cjs').then((m) => console.log('cjs-dynamic', m.value));\n",
  // A module whose own names are the ones a lowering might generate.
  'collide.mjs': [
    'const __nimbusModule = {};',
    "const __nimbusRequire = () => 'shadowed';",
    'const __importMeta = 1;',
    'const __importDynamic = 2;',
    "import { value } from './plain.cjs';",
    'export const x = 1;',
    "console.log('collide', x, value, typeof import.meta.url, __nimbusRequire(), __importMeta + __importDynamic, typeof __nimbusModule);",
    '',
  ].join('\n'),
};
/** What `node FILE` prints, for the programs run one by one. */
const ALONE = {
  'dynamic.js': 'cjs-dynamic 42\n',
  'collide.mjs': 'collide 1 42 string shadowed 3 object\n',
};
const WANT = [
  'live 2 anonymous default',
  'meta true import.meta.url',
  'shadow function true 42',
  'dynamic 42',
  'rejected false',
  '',
].join('\n');

const node = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout?.trim();
const disk = mkdtempSync(join(tmpdir(), 'lifo-esm-'));
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  for (const [name, text] of Object.entries(FILES)) {
    const path = join(disk, 'esm', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    await ws.fs.mkdir('/home/user/esm', { recursive: true });
    await ws.fs.writeFile(`/home/user/esm/${name}`, text);
  }
  if (node?.startsWith('v22')) {
    const reference = spawnSync('node', ['main.mjs'], { cwd: join(disk, 'esm'), encoding: 'utf8' });
    assert.equal(reference.stdout, WANT, `Node ${node} agrees: ${reference.stderr}`);
    assert.equal(spawnSync('node', ['detect.js'], { cwd: join(disk, 'esm'), encoding: 'utf8' }).stdout, 'detected string\n');
    for (const [file, want] of Object.entries(ALONE)) {
      assert.equal(spawnSync('node', [file], { cwd: join(disk, 'esm'), encoding: 'utf8' }).stdout, want, `Node ${node}: ${file}`);
    }
  }
  const ours = await ws.exec('cd /home/user/esm && node main.mjs');
  assert.equal(ours.stderr, '');
  assert.equal(ours.stdout, WANT);
  assert.equal((await ws.exec('cd /home/user/esm && node detect.js')).stdout, 'detected string\n', 'import.meta alone makes a .js an ES module');
  for (const [file, want] of Object.entries(ALONE)) {
    const alone = await ws.exec(`cd /home/user/esm && node ${file}`);
    assert.deepEqual([alone.stdout, alone.stderr], [want, ''], file);
  }
  const broken = await ws.exec('cd /home/user/esm && node -e "require(\'./broken.mjs\')"');
  assert.equal(broken.exitCode, 1);
  assert.match(broken.stderr, /SyntaxError: \[\/home\/user\/esm\/broken\.mjs\]/, 'a module that does not parse names its file');
} finally {
  await ws.close();
  rmSync(disk, { recursive: true, force: true });
}
console.log(`lifo-esm-lowering: ok${node?.startsWith('v22') ? ` (Node ${node} agrees)` : ''}`);
