#!/usr/bin/env bun
/**
 * The project scan's lexer (comment-strip.ts maskSourceForImports +
 * importedSpecifiers) against TypeScript's own parser: every module a source
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
import ts from 'typescript';
import { importedSpecifiers, maskSourceForImports, UndecidableSourceError } from '../../packages/core/src/runtime/comment-strip.ts';

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

function astSpecifiers(path, text) {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX
    : /\.[mc]?ts$/.test(path) ? ts.ScriptKind.TS
    : path.endsWith('.jsx') ? ts.ScriptKind.JSX
    : ts.ScriptKind.JS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  if (file.parseDiagnostics.length > 0) return null;
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const corpus = Object.entries(JSX_SHAPES);
const listed = execSync(
  "git ls-files 'packages/*/src/*' 'packages/worker/frontend/*' 'packages/*/scripts/*' 'tests/*' 'apps/*'",
  { cwd: ROOT, encoding: 'utf8' },
).trim().split('\n').filter((path) => /\.(?:[mc]?[jt]s|[jt]sx)$/.test(path) && !path.endsWith('.d.ts') && !path.includes('.generated.'));
for (const path of listed) {
  const text = readFileSync(ROOT + path, 'utf8');
  if (text.length < 1_000_000) corpus.push([path, text]);
}

let compared = 0;
let imports = 0;
const missed = [];
// Files the lexer cannot decide: it says so (UndecidableSourceError), and the
// scan reads them with the parser. None of the fixtures is one.
const undecided = [];
for (const [path, text] of corpus) {
  const expected = astSpecifiers(path, text);
  if (expected === null) {
    assert.ok(!(path in JSX_SHAPES), `${path}: the fixture parses`);
    continue;
  }
  compared++;
  imports += expected.length;
  let view;
  try {
    view = maskSourceForImports(text, path);
  } catch (error) {
    assert.ok(error instanceof UndecidableSourceError, `${path}: ${error}`);
    assert.ok(!(path in JSX_SHAPES), `${path}: the lexer decides the fixture`);
    undecided.push(path);
    continue;
  }
  const found = new Set(importedSpecifiers(view));
  for (const specifier of expected) if (!found.has(specifier)) missed.push(`${path}: ${specifier}`);
}
assert.deepEqual(missed, [], 'the lexer finds every import the parser does');
assert.ok(compared > 1500, `compared ${compared} sources`);

console.log(`import-scan-differential: ${compared} sources (${Object.keys(JSX_SHAPES).length} fixtures), ${imports} imports, none missed; ${undecided.length} left to the parser${undecided.length ? ': ' + undecided.join(', ') : ''}`);
