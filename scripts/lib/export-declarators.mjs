// No exported `const`/`let`/`var` statement in a published package declares
// more than one name. rolldown 1.0.0–1.1.3 with `output.keepNames` (vite
// 8.0's bundler) keeps `export` only on the first declarator of
// `export const a = 1, b = 2`, so a consumer's build fails with
// MISSING_EXPORT for every later name. Fixed in rolldown 1.1.4
// (https://github.com/rolldown/rolldown/pull/9974), which vite 8.1 and
// later bundle; a consumer on vite 8.0 still has the bug. tsrs emits the
// statement as written, so the rule is checked in source, where the fix is
// made, and the build gate (scripts/dist-integrity.mjs) refuses a tree that
// breaks it.
//
// Every package under packages/ is published (each package.json has `files`
// and none is private), and its dist is built from its src. Read from the
// syntax tree, never a pattern: a generated module's string can hold
// `export const a = 1, b = 2` as text.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { isVariableStatement, SyntaxKind } from 'tsrs/unstable/ast';
import { API, JsxEmit } from 'tsrs/unstable/sync';
import { inNode, RUNS_TSRS_API } from './tsrs-api.mjs';

/** What a published package's build compiles and a consumer's bundler reads. */
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/**
 * Every exported variable statement under packages/<name>/src that declares
 * more than one name, as { file (repo-relative), line (1-based), names }.
 * Ambient declarations (`declare`, .d.ts) emit no JavaScript and are skipped.
 *
 * @param {{ root: string }} options
 * @returns {Array<{ file: string, line: number, names: string[] }>}
 */
export function multiDeclaratorExports({ root }) {
  if (!RUNS_TSRS_API) return inNode(import.meta.url, 'multiDeclaratorExports', { root });
  // `:(glob)`: `*` stays within a directory and `**` crosses them. A bare `packages/*/src` names no file under src.
  const listed = spawnSync('git', ['ls-files', '-z', '--', ':(glob)packages/*/src/**'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
  const files = listed.stdout.split('\0').filter((file) => SOURCE.test(file) && !file.endsWith('.d.ts'));
  // tsrs is this workspace's own (the gate refuses a workspace without it).
  // Every file is parsed, in one program that only parses (each file by its
  // extension): a text prefilter must see every way to write the statement
  // (`export/*c*/const a = 1, b = 2;` passed `export\s+const` by).
  const api = new API({ cwd: root });
  try {
    const program = api.createProgram(files.map((file) => join(root, file)), { allowJs: true, jsx: JsxEmit.Preserve, noResolve: true, noLib: true, types: [], noEmit: true });
    const found = [];
    for (const file of files) {
      const source = program.getSourceFile(join(root, file));
      if (!source) throw new Error(`${file} is not in the program that parses the published sources`);
      for (const statement of source.statements) {
        if (!isVariableStatement(statement)) continue;
        const modifiers = statement.modifiers ?? [];
        if (!modifiers.some((m) => m.kind === SyntaxKind.ExportKeyword)) continue;
        if (modifiers.some((m) => m.kind === SyntaxKind.DeclareKeyword)) continue;
        const declarations = statement.declarationList.declarations;
        if (declarations.length < 2) continue;
        found.push({
          file,
          line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
          names: declarations.map((declaration) => declaration.name.getText(source)),
        });
      }
    }
    return found;
  } finally {
    api.close();
  }
}

/** The refusal for `found`, naming each statement and the fix. */
export function multiDeclaratorReason(found) {
  return 'refusing to build — exported variable statements in published packages declare more than one name:\n'
    + found.map(({ file, line, names }) => `  ${file}:${line}  export … ${names.join(', ')}`).join('\n')
    + '\nrolldown before 1.1.4 with keepNames (vite 8.0) keeps `export` only on the first, so a consumer\'s build fails '
    + 'with MISSING_EXPORT. Declare each name in its own `export const` statement.';
}
