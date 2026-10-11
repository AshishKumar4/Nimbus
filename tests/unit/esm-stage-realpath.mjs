#!/usr/bin/env bun
// Staging's realpath by directory listing (esm-stage.ts EsmStageFs.entries):
// a file that is no link is its directory's realpath and its name, so a
// launch asks one listing and one realpath per directory, not a realpath per
// file. What it stages must be what a realpath per file stages: a package
// reached through a linked directory, a linked file, a file in a linked
// directory.

import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readEsModule } from '../../packages/core/src/runtime/native-esm.ts';
import { stageEsModules } from '../../packages/worker/src/facets/esm-stage.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'esm-stage-realpath-')));
try {
  const FILES = {
    'w/linked/package.json': '{"name":"linked-pkg","type":"module","exports":"./index.js"}',
    'w/linked/index.js': 'import { s } from "./sibling.js";\nexport const x = s;\n',
    'w/linked/sibling.js': 'export const s = 1;\n',
    'w/linked/real.js': 'export const r = 2;\n',
    'w/package.json': '{"type":"module"}',
    'w/app/main.js': 'import { x } from "linked-pkg";\nimport { r } from "../linked/alias.js";\nimport { y } from "./same.js";\nimport "./a.js";\nimport "./b.js";\nimport "./c.js";\nconsole.log(x, r, y);\n',
    'w/app/same.js': 'export const y = 3;\n',
    'w/app/a.js': 'export const a = 1;\n',
    'w/app/b.js': 'export const b = 1;\n',
    'w/app/c.js': 'export const c = 1;\n',
  };
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  symlinkSync('real.js', join(root, 'w/linked/alias.js'));
  mkdirSync(join(root, 'w/node_modules'));
  symlinkSync('../linked', join(root, 'w/node_modules/linked-pkg'));

  const local = (path) => join(root, path.replace(/^\/+/, ''));
  const asked = { realpath: 0, entries: 0 };
  const files = {
    exists: async (path) => existsSync(local(path)),
    isDirectory: async (path) => { try { return statSync(local(path)).isDirectory(); } catch { return false; } },
    readFileString: async (path) => readFileSync(local(path), 'utf8'),
    stat: async (path) => { try { const s = statSync(local(path)); return { size: s.size, type: s.isDirectory() ? 'directory' : 'file' }; } catch { return null; } },
    lstat: async (path) => { try { const s = lstatSync(local(path)); return { size: s.size, type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : 'file' }; } catch { return null; } },
    readBytes: async (path) => { try { return readFileSync(local(path)); } catch { return null; } },
  };
  const realpath = async (path) => { asked.realpath++; return '/' + realpathSync(local(path)).slice(root.length + 1); };
  const entries = async (dir) => {
    asked.entries++;
    try {
      return new Map(readdirSync(local(dir), { withFileTypes: true }).map((e) => [e.name, e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file']));
    } catch {
      return null;
    }
  };
  const cells = new Map();
  for (const key of ['w/app/main.js', 'w/app/same.js', 'w/linked/index.js', 'w/linked/sibling.js', 'w/linked/real.js', 'w/app/a.js', 'w/app/b.js', 'w/app/c.js']) {
    const code = readFileSync(join(root, key), 'utf8');
    cells.set(key, { code, sites: readEsModule(code, 'node') });
  }
  const options = { conditions: [], cwd: '/w', isCode: () => true, gate: true };
  const perFile = await stageEsModules({ files, realpath }, cells, options);
  const filesAsked = asked.realpath;
  asked.realpath = 0;
  const listed = await stageEsModules({ files, realpath, entries }, cells, options);
  const shape = (stage) => JSON.stringify({ table: stage.table, missing: stage.missing, members: stage.members, modules: [...stage.modules].map(([key, m]) => [key, m.text]) });
  assert.equal(shape(listed), shape(perFile), 'the listing stages what a realpath per file stages');
  assert.deepEqual(perFile.table[0], ['module', 'w/app/main.js', [2, 4, 1, 5, 6, 7]], 'main links the package behind its link, the linked file\'s target and its siblings');
  assert.equal(perFile.missing.length, 0);
  assert.ok(asked.realpath < filesAsked, `fewer realpaths by listing (${asked.realpath} and ${asked.entries} listings, against ${filesAsked})`);
  console.log(`esm-stage-realpath: listings stage what realpaths do (${asked.realpath} realpaths and ${asked.entries} listings, against ${filesAsked} realpaths)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
