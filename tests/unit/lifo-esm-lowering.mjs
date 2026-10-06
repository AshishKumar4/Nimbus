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
// createRequire(...)` shadows the wrapper's names as module scope does.
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
  }
  const ours = await ws.exec('cd /home/user/esm && node main.mjs');
  assert.equal(ours.stderr, '');
  assert.equal(ours.stdout, WANT);
  assert.equal((await ws.exec('cd /home/user/esm && node detect.js')).stdout, 'detected string\n', 'import.meta alone makes a .js an ES module');
  const broken = await ws.exec('cd /home/user/esm && node -e "require(\'./broken.mjs\')"');
  assert.equal(broken.exitCode, 1);
  assert.match(broken.stderr, /SyntaxError: \[\/home\/user\/esm\/broken\.mjs\]/, 'a module that does not parse names its file');
} finally {
  await ws.close();
  rmSync(disk, { recursive: true, force: true });
}
console.log(`lifo-esm-lowering: ok${node?.startsWith('v22') ? ` (Node ${node} agrees)` : ''}`);
