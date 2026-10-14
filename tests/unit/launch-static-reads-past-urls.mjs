#!/usr/bin/env bun
// A launch stages what its code reads by a path the code spells out, wherever
// on the line the read is: after a URL string too. The scanners that stage
// those files stripped comments with a regex, which read `//` inside
// "http://example.com" as one and erased the rest of the line, so a read
// after a URL on the same line was never staged.
//
// `node -e` code reading an absolute path outside the working tree has only
// that pass to stage it: the one-shot runs as real node does. A module's
// reads are checked on the launch's own module map (_buildProcessBundle),
// with the shapes the staging covers: path.resolve or path.join of
// __dirname, an alias of the path function, SWC's `(0, fs_1.readFileSync)`,
// a dotfile or version sentinel, and an absolute path a module names.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createAuthority } from './lib/resident-body.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';

const ROOT = '/home/user/scan';
const CWD = `${ROOT}/proj`;
const URL_LINE = 'const home = "http://example.com";';
const evalCode = (root) => `${URL_LINE} console.log(require("fs").readFileSync("${root}/data/x.txt", "utf8"));`;
const PKG = 'proj/node_modules/assets';
const files = {
  'data/x.txt': 'x-data',
  'data/y.txt': 'y-data',
  'data/z.txt': 'z-data',
  'proj/package.json': JSON.stringify({ name: 'proj', private: true }),
  'proj/main.js': "require('assets');\n",
  [`${PKG}/package.json`]: JSON.stringify({ name: 'assets', version: '1.0.0', main: 'index.js' }),
  [`${PKG}/index.js`]: "require('./url'); require('./alias'); require('./swc'); require('./version'); require('./abs'); require('./abs-url');\n",
  [`${PKG}/url.js`]: `const fs = require('fs'); const path = require('path'); ${URL_LINE} module.exports = fs.readFileSync(path.resolve(__dirname, 'style.css'), 'utf8');\n`,
  [`${PKG}/style.css`]: 'body {}',
  [`${PKG}/alias.js`]: "const fs = require('fs');\nconst resolve = require('path').resolve;\nmodule.exports = fs.readFileSync(resolve(__dirname, 'theme.css'), 'utf8');\n",
  [`${PKG}/theme.css`]: 'main {}',
  [`${PKG}/swc.js`]: 'var fs_1 = require("fs");\nvar path_1 = require("path");\nexports.DIGEST = (0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, ".assets-digest"), "utf8");\n',
  [`${PKG}/.assets-digest`]: 'd1',
  [`${PKG}/version.js`]: "const fs = require('fs');\nconst path = require('path');\nmodule.exports = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8');\n",
  [`${PKG}/VERSION`]: '1.0.0',
  [`${PKG}/abs.js`]: `module.exports = { file: '${ROOT}/data/y.txt' };\n`,
  [`${PKG}/abs-url.js`]: `${URL_LINE} module.exports = { file: '${ROOT}/data/z.txt' };\n`,
};

// ── real node ────────────────────────────────────────────────────────────
const disk = realpathSync(mkdtempSync(join(tmpdir(), 'launch-static-reads-')));
let expected;
try {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(disk, rel)), { recursive: true });
    writeFileSync(join(disk, rel), body);
  }
  const node = spawnSync('node', ['-e', evalCode(disk)], { cwd: join(disk, 'proj'), encoding: 'utf8' });
  assert.equal(node.status, 0, `node -e: ${node.stderr}`);
  expected = node.stdout;
} finally {
  rmSync(disk, { recursive: true, force: true });
}
assert.equal(expected, 'x-data\n', 'premise: node reads the file named after the URL');

// ── the session ──────────────────────────────────────────────────────────
const { host, rawVfs, kfs } = createAuthority();
let out = '';
adoptSessionSupervisor(host, (chunk) => { out += chunk; });
const manager = oneShotManager('launch-static-reads-past-urls', { host, rawVfs, loader: runnerLoader('static-reads') });
for (const [rel, body] of Object.entries(files)) {
  const path = `${ROOT.slice(1)}/${rel}`;
  kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kfs.writeFile(path, body);
}

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
let result;
try {
  result = await manager.exec(evalCode(ROOT), { filename: '<eval>', dirname: CWD, cwd: CWD, captureOutput: true });
} finally { Object.assign(globalThis, real); }
assert.equal(result.exitCode, 0, `node -e: ${result.stderr}${out}`);
assert.equal(out + result.stdout, expected, 'node -e reads the file it names after a URL, as node does');

// The module map a launch of main.js builds.
const spec = { scriptPath: `${CWD}/main.js`, cwd: CWD, entryCode: files['proj/main.js'] };
const entry = host.processes.spawn('node main.js', ['node', 'main.js'], CWD, { cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
const vfsState = await manager._buildProcessBundle(entry, spec, manager._launchPacer(entry.pid));
const staged = new Set(vfsState.bundlePaths);
const want = {
  'a resolve(__dirname) read after a URL on its line': `${ROOT.slice(1)}/${PKG}/style.css`,
  "a read through an alias of path's resolve": `${ROOT.slice(1)}/${PKG}/theme.css`,
  "SWC's (0, fs_1.readFileSync) of a dotfile": `${ROOT.slice(1)}/${PKG}/.assets-digest`,
  'a join(__dirname) read of a version sentinel': `${ROOT.slice(1)}/${PKG}/VERSION`,
  'an absolute path a module names': `${ROOT.slice(1)}/data/y.txt`,
  'an absolute path a module names after a URL on its line': `${ROOT.slice(1)}/data/z.txt`,
};
for (const [what, path] of Object.entries(want)) assert.ok(staged.has(path), `the module map stages ${what}: ${path}`);

console.log(`launch-static-reads-past-urls: node -e reads past a URL, and the map stages ${Object.keys(want).length} spelled-out reads`);
