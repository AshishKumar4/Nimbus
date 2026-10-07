#!/usr/bin/env bun
// The build gate's rule on what the published packages ship
// (scripts/lib/export-declarators.mjs): no exported variable statement under
// packages/*/src declares more than one name, read from the syntax tree.
// On a fixture checkout: every shape it must find, and every one it must
// not (text in a string, an ambient declaration, a .d.ts, an export list,
// a file outside src). Then the repository itself, which must hold none.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { multiDeclaratorExports, multiDeclaratorReason } from '../../scripts/lib/export-declarators.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const root = mkdtempSync(join(tmpdir(), 'export-declarators-'));
try {
  const files = {
    'packages/a/src/modes.ts': '/** POSIX access(2) modes. */\nexport const F_OK = 0, X_OK = 1, W_OK = 2, R_OK = 4;\nexport const ONE = 1;\n',
    'packages/a/src/later.ts': 'import x from "y";\n\nexport let g, h;\nexport var i = 1;\n',
    'packages/b/src/view.tsx': 'export const A = () => <b>a</b>, B = () => <i>b</i>;\n',
    'packages/b/src/plain.mjs': 'export const p = 1, q = 2;\n',
    // Comments between `export` and the keyword: legal, and no pattern over
    // the text (`export\s+const`) sees them.
    'packages/b/src/commented.ts': 'export/*c*/const j = 1, k = 2;\nexport // c\nconst l = 1, m = 2;\nexport\n/* a\n   comment */\nlet n, o;\n',
    // Must not be found:
    'packages/a/src/generated.ts': 'export const PREAMBLE: string = "export const a = 1, b = 2;";\n',
    'packages/a/src/ambient.ts': 'export declare const c: number, d: number;\n',
    'packages/a/src/types.d.ts': 'export const e: number, f: number;\n',
    'packages/a/src/list.ts': 'const e = 1, f = 2;\nexport { e, f };\n',
    'packages/a/src/nested.ts': 'export function n() { const s = 1, t = 2; return s + t; }\n',
    'packages/a/scripts/tool.mjs': 'export const u = 1, v = 2;\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '-A'], { cwd: root });
  const found = multiDeclaratorExports({ root });
  assert.deepEqual(found, [
    { file: 'packages/a/src/later.ts', line: 3, names: ['g', 'h'] },
    { file: 'packages/a/src/modes.ts', line: 2, names: ['F_OK', 'X_OK', 'W_OK', 'R_OK'] },
    { file: 'packages/b/src/commented.ts', line: 1, names: ['j', 'k'] },
    { file: 'packages/b/src/commented.ts', line: 2, names: ['l', 'm'] },
    { file: 'packages/b/src/commented.ts', line: 4, names: ['n', 'o'] },
    { file: 'packages/b/src/plain.mjs', line: 1, names: ['p', 'q'] },
    { file: 'packages/b/src/view.tsx', line: 1, names: ['A', 'B'] },
  ]);
  const reason = multiDeclaratorReason(found);
  assert.match(reason, /packages\/a\/src\/modes\.ts:2 {2}export … F_OK, X_OK, W_OK, R_OK/);
  assert.match(reason, /Declare each name in its own `export const` statement/);
  console.log('  ok  every multi-declarator export under packages/*/src is found, by file, line and names, comments between export and its keyword too; strings, ambient declarations, .d.ts, export lists, inner declarations and files outside src are not');
} finally {
  rmSync(root, { recursive: true, force: true });
}

assert.deepEqual(multiDeclaratorExports({ root: REPO }), [], 'the published packages declare one name per exported variable statement');
// Not vacuously: the scan reaches the file this rule was written for.
{
  const scratch = mkdtempSync(join(tmpdir(), 'export-declarators-repo-'));
  try {
    const path = 'packages/core/src/runtime/process-files.ts';
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), 'export const F_OK = 0, X_OK = 1;\n');
    spawnSync('git', ['init', '-q'], { cwd: scratch });
    spawnSync('git', ['add', '-A'], { cwd: scratch });
    assert.deepEqual(multiDeclaratorExports({ root: scratch }).map((entry) => entry.file), [path]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
console.log('  ok  the repository\'s published packages hold none');
console.log('export-declarators OK');
