/**
 * build-reads.mjs — the files the packages' builds run and read, as their
 * sources say, for dist-integrity's input fingerprint to cover
 * (tests/unit/dist-integrity.mjs [27]).
 *
 * Walked from what a build runs: every file under each package's scripts,
 * every script a package.json command names, and the root script files among
 * the inputs. From each, through what it names by a literal (parsed by
 * TypeScript, so comments and spacing cannot hide an edge): a static or
 * dynamic import, a re-export, a require, and a `new URL(<literal>,
 * import.meta.url)`, the way a script names a file it reads. A reference it
 * cannot resolve to a literal (an import or URL built at run time) is
 * returned as unresolved, for the caller to account for.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

const SCRIPT = /\.(?:mjs|cjs|js|ts|mts|cts)$/;

/**
 * @param {{ root: string, packages: readonly string[], inputs: readonly string[] }} options
 * @returns {{ reads: string[], uncovered: string[], unresolved: Array<{ file: string, line: number, text: string }> }}
 */
export function buildReads({ root, packages, inputs }) {
  const ts = createRequire(import.meta.url)('typescript');
  const covered = (rel) => inputs.some((input) => rel === input || rel.startsWith(`${input}/`));
  // A built package's dist is an output the build writes first (generate-wrangler-configs reads config's).
  const output = (rel) => packages.some((pkg) => rel.startsWith(`packages/${pkg}/dist/`));
  const seen = new Set();
  const queue = [];
  const unresolved = [];
  const visit = (abs) => {
    const rel = relative(root, abs);
    if (rel.startsWith('..') || output(rel) || seen.has(rel) || !existsSync(abs) || !statSync(abs).isFile()) return;
    seen.add(rel);
    queue.push(rel);
  };
  const walkDir = (abs) => {
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walkDir(child);
      else if (SCRIPT.test(entry.name)) visit(child);
    }
  };
  for (const pkg of packages) {
    walkDir(join(root, 'packages', pkg, 'scripts'));
    const manifest = JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8'));
    for (const command of Object.values(manifest.scripts ?? {})) {
      for (const [path] of String(command).matchAll(/(?:\.\.\/)+scripts\/[\w./-]+\.(?:mjs|cjs|js|ts)/g)) visit(join(root, 'packages', pkg, path));
    }
  }
  for (const input of inputs) if (input.startsWith('scripts/') && SCRIPT.test(input)) visit(join(root, input));

  const literal = (node) => node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const importMetaUrl = (node) => node !== undefined && ts.isPropertyAccessExpression(node) && node.name.text === 'url'
    && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
  while (queue.length > 0) {
    const rel = queue.shift();
    if (!SCRIPT.test(rel)) continue;
    const source = ts.createSourceFile(rel, readFileSync(join(root, rel), 'utf8'), ts.ScriptTarget.Latest, true);
    const refer = (specifier, node) => {
      if (specifier === null) {
        unresolved.push({ file: rel, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.getText(source).slice(0, 120) });
      } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
        visit(join(root, dirname(rel), specifier));
      }
    };
    const walk = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
        refer(literal(node.moduleSpecifier), node);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        refer(literal(node.arguments[0]), node);
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
        && importMetaUrl(node.arguments?.[1])) {
        refer(literal(node.arguments[0]), node);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  const reads = [...seen].sort();
  return { reads, uncovered: reads.filter((rel) => !covered(rel)), unresolved };
}
