#!/usr/bin/env bun
/**
 * The project scan's lexer (comment-strip.ts maskSourceForImports +
 * importedSpecifiers) against TypeScript's parser (tsrs's): every module a source
 * imports, statically, by re-export or by `import()`, as the AST names it,
 * the lexer finds too. The lexer may find more (a `from "x"` inside a string
 * is copied verbatim and read), never less: a missed import is a package
 * left out of the pre-bundle, or a barrel served its no-imports stub.
 *
 * The corpus is this repository's TypeScript, TSX and JavaScript sources
 * (its packages, scripts, tests and apps),
 * plus JSX shapes the repository has few of: a closing tag before an import,
 * a URL and an apostrophe in JSX text, `return <a/>`, expressions inside
 * elements, generic arrows and function types in TSX, each again with every
 * specifier scoped. A file the lexer cannot decide must say so, never
 * mis-read: the scan reads it with a parser.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isCallExpression, isExportDeclaration, isImportDeclaration, isStringLiteral, isStringLiteralLike, SyntaxKind } from 'tsrs/unstable/ast';
import { JsxEmit } from 'tsrs/unstable/sync';
import { importedSpecifiers, maskSourceForImports, UndecidableSourceError } from '../../packages/core/src/runtime/comment-strip.ts';
import { withTsrs } from './lib/tsrs-program.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;

const JSX_SHAPES = {
  'closing-tag.tsx': "const view = <div></div>; import { Icon } from '@scope/icons';",
  'url-text.jsx': "const a = <a>See http://example.com</a>; const lazy = () => import('lazy-link');",
  'apostrophe.tsx': "const n = <p>Don't</p>; import Quoted from 'after-apostrophe'; const m = <p>it's</p>; import('q2');",
  'return.jsx': "function r() { return <a href=\"/x\">open</a>; } import T from 'tail';",
  'default.jsx': "export default <main>a/b</main>; export { x } from 'reexported';",
  'expression.tsx': "const v = <p title={`a${b}`} {...rest}>{cond && <b>x</b>} {items.map((i) => <li key={i}>{i}</li>)} {import('in-jsx')}</p>; import 'side-effect';",
  'fragment.jsx': "const f = <><a/>text/with/slashes</>; import { F } from 'after-fragment';",
  'generic-arrow.tsx': "const id = <T,>(x: T) => x; const k = <K extends string>(x: K) => x; import { B } from 'after-generics';",
  'generic-type.tsx': "type Fn = <T>(x: T) => T; const el = <div>ok</div>; import { A } from 'after-generic-type';",
  'type-args.tsx': "const n = useState<number>(0); const m = a < b && c > d; import { C } from 'after-comparison';",
  'assertion.ts': "const n = <number>value / 2; import { D } from 'after-assertion';",
  'regex.js': "const r = /<div>'\"/g; const s = x.split(/\\//); import E from 'after-regex'; if (a) return /\\/*x/.test(b);",
  // A generic function type, then JSX, then a scoped import: the type's `<T>`
  // is decided locally, so the JSX after it is still JSX.
  'generic-type-then-jsx.tsx': "type F = <T>(x: T) => T; const view = <div></div>; import { Icon } from '@scope/icons';",
  // Comments between a tag's attributes: an apostrophe in one opens no string.
  'tag-comments.tsx': "const f = <iframe\n  src={u}\n  // the token's claims\n  /* it's */ title='t'\n/>; import { G } from 'after-tag-comments';",
};

// Each hazard again, every specifier scoped: a scoped specifier's slash is
// the one a mis-read closing tag or regex would run on to.
for (const [name, text] of Object.entries(JSX_SHAPES)) {
  JSX_SHAPES[name.replace(/(\.[a-z]+)$/, '-scoped$1')] = text.replace(/(from\s*|import\(\s*|import\s+)(['"])(?!@)([^'"]+)\2/g, '$1$2@scope/$3$2');
}

/** The modules `file` imports, as its AST names them. */
function astSpecifiers(file) {
  const found = [];
  const visit = (node) => {
    if ((isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword
      && node.arguments.length > 0 && isStringLiteralLike(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    node.forEachChild(visit);
  };
  visit(file);
  return found;
}

// The fixtures stand at paths of their own under the repository, each parsed by its extension.
const corpus = Object.entries(JSX_SHAPES).map(([name, text]) => [`import-scan-fixtures/${name}`, text]);
const fixtures = new Set(corpus.map(([path]) => path));
const listed = execSync(
  "git ls-files 'packages/*/src/*' 'packages/worker/frontend/*' 'packages/*/scripts/*' 'tests/*' 'apps/*'",
  { cwd: ROOT, encoding: 'utf8' },
).trim().split('\n').filter((path) => /\.(?:[mc]?[jt]s|[jt]sx)$/.test(path) && !path.endsWith('.d.ts') && !path.includes('.generated.'));
for (const path of listed) {
  const text = readFileSync(ROOT + path, 'utf8');
  if (text.length < 1_000_000) corpus.push([path, text]);
}

// One parse-only program over the corpus: each file's syntax errors and AST.
// A file that does not parse is left out, as the parser cannot name its imports.
const parsed = withTsrs({ cwd: ROOT, overlay: Object.fromEntries(corpus.filter(([path]) => fixtures.has(path)).map(([path, text]) => [ROOT + path, text])) }, (api) => {
  const program = api.createProgram(corpus.map(([path]) => ROOT + path), { allowJs: true, jsx: JsxEmit.Preserve, noResolve: true, noLib: true, types: [], noEmit: true });
  return new Map(corpus.map(([path]) => [path, program.getSyntacticDiagnostics(ROOT + path).length > 0 ? null : astSpecifiers(program.getSourceFile(ROOT + path))]));
});

let compared = 0;
let imports = 0;
const missed = [];
// Files the lexer cannot decide: it says so (UndecidableSourceError), and the
// scan reads them with the parser. None of the fixtures is one.
const undecided = [];
for (const [path, text] of corpus) {
  const expected = parsed.get(path);
  if (expected === null) {
    assert.ok(!fixtures.has(path), `${path}: the fixture parses`);
    continue;
  }
  compared++;
  imports += expected.length;
  let view;
  try {
    view = maskSourceForImports(text, path);
  } catch (error) {
    assert.ok(error instanceof UndecidableSourceError, `${path}: ${error}`);
    assert.ok(!fixtures.has(path), `${path}: the lexer decides the fixture`);
    undecided.push(path);
    continue;
  }
  const found = new Set(importedSpecifiers(view));
  for (const specifier of expected) if (!found.has(specifier)) missed.push(`${path}: ${specifier}`);
}
assert.deepEqual(missed, [], 'the lexer finds every import the parser does');
assert.ok(compared > 1500, `compared ${compared} sources`);

console.log(`import-scan-differential: ${compared} sources (${Object.keys(JSX_SHAPES).length} fixtures), ${imports} imports, none missed; ${undecided.length} left to the parser${undecided.length ? ': ' + undecided.join(', ') : ''}`);
