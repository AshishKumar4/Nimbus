// No exported `const`/`let`/`var` statement in a published package declares
// more than one name. rolldown 1.0.0–1.1.3 with `output.keepNames` (vite
// 8.0's bundler) keeps `export` only on the first declarator of
// `export const a = 1, b = 2`, so a consumer's build fails with
// MISSING_EXPORT for every later name (Ask 21;
// /mnt/local/nimbus/spike/vite8-multidecl/README.md). tsc emits the
// statement as written, so the rule is checked in source, where the fix is
// made, and the build gate (scripts/dist-integrity.mjs) refuses a tree that
// breaks it.
//
// Every package under packages/ is published (each package.json has `files`
// and none is private), and its dist is built from its src. Read from the
// syntax tree, never a pattern: a generated module's string can hold
// `export const a = 1, b = 2` as text.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** What a published package's build compiles and a consumer's bundler reads. */
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
/** A file that may hold an exported variable statement: the rest are not parsed. */
const MAY_EXPORT_VARIABLE = /\bexport\s+(?:declare\s+)?(?:const|let|var)\b/;

/**
 * Every exported variable statement under packages/<name>/src that declares
 * more than one name, as { file (repo-relative), line (1-based), names }.
 * Ambient declarations (`declare`, .d.ts) emit no JavaScript and are skipped.
 *
 * @param {{ root: string }} options
 * @returns {Array<{ file: string, line: number, names: string[] }>}
 */
export function multiDeclaratorExports({ root }) {
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'packages/*/src'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
  const files = listed.stdout.split('\0').filter((file) => SOURCE.test(file) && !file.endsWith('.d.ts'));
  let ts = null;
  const found = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    if (!MAY_EXPORT_VARIABLE.test(text)) continue;
    // TypeScript is this workspace's own (the gate refuses a workspace without it).
    ts ??= createRequire(import.meta.url)('typescript');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(ts, file));
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const modifiers = ts.getModifiers(statement) ?? [];
      if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (modifiers.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) continue;
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
}

function scriptKind(ts, file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.(?:js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The refusal for `found`, naming each statement and the fix. */
export function multiDeclaratorReason(found) {
  return 'refusing to build — exported variable statements in published packages declare more than one name:\n'
    + found.map(({ file, line, names }) => `  ${file}:${line}  export … ${names.join(', ')}`).join('\n')
    + '\nrolldown before 1.1.4 with keepNames (vite 8.0) keeps `export` only on the first, so a consumer\'s build fails '
    + 'with MISSING_EXPORT. Declare each name in its own `export const` statement.';
}
