// The repo's compiler, tsrs, over a few files for a unit test, through its
// API (tsrs/unstable/sync, which runs the pinned tsrs binary): a program of
// root files under compiler options, where text a test gives stands in for
// files on disk. The API runs in Node (scripts/lib/tsrs-api.mjs): from a
// test, which bun runs, each function here runs in a node process.
import {
  isCallExpression, isClassDeclaration, isExportDeclaration, isGetAccessorDeclaration, isIdentifier, isImportDeclaration, isMethodDeclaration,
  isPropertyDeclaration, isSetAccessorDeclaration, isStringLiteral, isStringLiteralLikeNode, SyntaxKind,
} from 'tsrs/unstable/ast';
import { serverFS } from 'tsrs/unstable/fs';
import { API, JsxEmit } from 'tsrs/unstable/sync';
import { inNode, RUNS_TSRS_API } from '../../../scripts/lib/tsrs-api.mjs';

/**
 * Run `use` with an API whose filesystem is the disk, but for `overlay`
 * (absolute path → text): those files read as given, whether or not they
 * exist. The API's process ends when `use` returns. In Node only.
 *
 * @template T
 * @param {{ cwd?: string, overlay?: Record<string, string> }} options
 * @param {(api: API) => T} use
 * @returns {T}
 */
export function withTsrs({ cwd = process.cwd(), overlay = {} }, use) {
  const virtual = new Map(Object.entries(overlay));
  const fs = virtual.size === 0 ? undefined : {
    readFile: (/** @type {string} */ name) => virtual.get(name) ?? serverFS.useOS,
    fileExists: (/** @type {string} */ name) => (virtual.has(name) ? true : serverFS.useOS),
    realpath: (/** @type {string} */ name) => (virtual.has(name) ? serverFS.identity : serverFS.useOS),
    stat: (/** @type {string} */ name) => (virtual.has(name) ? serverFS.fakeStat : serverFS.useOS),
    directoryExists: serverFS.useOS,
    getAccessibleEntries: serverFS.useOS,
    writeFile: serverFS.noop,
    removeFile: serverFS.noop,
  };
  const api = new API({ cwd, fs });
  try {
    return use(api);
  } finally {
    api.close();
  }
}

/**
 * A diagnostic's message with its chain, as tsc prints it: each link on its
 * own line, indented two spaces deeper than the one it explains.
 *
 * @param {import('tsrs/unstable/sync').Diagnostic} diagnostic
 * @returns {string}
 */
export function diagnosticMessage(diagnostic, depth = 0) {
  const chain = diagnostic.messageChain ?? [];
  return `${'  '.repeat(depth)}${diagnostic.text}${chain.map((link) => `\n${diagnosticMessage(link, depth + 1)}`).join('')}`;
}

/**
 * The errors tsrs reports for `files` (by default `roots`) in the program of
 * `roots` under `options`: the options' and global ones, then each file's
 * syntactic and semantic ones, as { file, line (0-based), code, message }.
 * `overlay` stands in for files on disk (withTsrs).
 *
 * @param {{ roots: string[], options: import('tsrs/unstable/sync').CompilerOptions, files?: string[], overlay?: Record<string, string>, cwd?: string }} options
 * @returns {Array<{ file: string | undefined, line: number | undefined, code: number, message: string }>}
 */
export function programErrors({ roots, options, files = roots, overlay = {}, cwd }) {
  if (!RUNS_TSRS_API) return inNode(import.meta.url, 'programErrors', { roots, options, files, overlay, cwd });
  return withTsrs({ cwd, overlay }, (api) => {
    const program = api.createProgram(roots, options);
    return [
      ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(files),
      ...program.getSemanticDiagnostics(files),
    ].map((diagnostic) => ({
      file: diagnostic.fileName,
      line: diagnostic.startPosition?.line,
      code: diagnostic.code,
      message: diagnosticMessage(diagnostic),
    }));
  });
}

/**
 * A tsconfig's compiler options as tsrs reads them; an error in the config
 * throws.
 *
 * @param {string} configPath
 * @returns {import('tsrs/unstable/sync').CompilerOptions}
 */
export function configOptions(configPath) {
  if (!RUNS_TSRS_API) return inNode(import.meta.url, 'configOptions', configPath);
  return withTsrs({}, (api) => {
    const config = api.parseConfigFile(configPath);
    if (config.errors.length > 0) throw new Error(`${configPath}: ${config.errors.map((error) => diagnosticMessage(error)).join('\n')}`);
    return config.options;
  });
}

/**
 * The modules each of `files` (absolute paths) imports, statically, by
 * re-export or by a literal `import()`, as tsrs parses it by its extension;
 * null for a file that does not parse. One program that only parses.
 * `overlay` stands in for files on disk (withTsrs).
 *
 * @param {{ files: string[], overlay?: Record<string, string>, cwd?: string }} options
 * @returns {Array<string[] | null>}
 */
export function importSpecifiers({ files, overlay = {}, cwd }) {
  if (!RUNS_TSRS_API) return inNode(import.meta.url, 'importSpecifiers', { files, overlay, cwd });
  return withTsrs({ cwd, overlay }, (api) => {
    const program = api.createProgram(files, { allowJs: true, jsx: JsxEmit.Preserve, noResolve: true, noLib: true, types: [], noEmit: true });
    return files.map((file) => {
      if (program.getSyntacticDiagnostics(file).length > 0) return null;
      const found = [];
      /** @param {import('tsrs/unstable/ast').Node} node */
      const visit = (node) => {
        if ((isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
          found.push(node.moduleSpecifier.text);
        } else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword
          && node.arguments.length > 0 && isStringLiteralLikeNode(node.arguments[0])) {
          found.push(node.arguments[0].text);
        }
        node.forEachChild(visit);
      };
      visit(program.getSourceFile(file));
      return found;
    });
  });
}

/**
 * Where each of `members` of the class `className` in `text` (the file at
 * `path`) is declared: its declarations' [full start, end], in order.
 *
 * @param {{ path: string, text: string, className: string, members: string[] }} options
 * @returns {Record<string, Array<[number, number]>>}
 */
export function classMemberSpans({ path, text, className, members }) {
  if (!RUNS_TSRS_API) return inNode(import.meta.url, 'classMemberSpans', { path, text, className, members });
  return withTsrs({}, (api) => {
    const source = api.createSourceFile(path, text).sourceFile;
    const declared = source.statements.find((node) => isClassDeclaration(node) && node.name?.text === className);
    if (!declared || !isClassDeclaration(declared)) throw new Error(`${path} declares no class ${className}`);
    const named = (node) => (isMethodDeclaration(node) || isPropertyDeclaration(node) || isGetAccessorDeclaration(node) || isSetAccessorDeclaration(node))
      && isIdentifier(node.name) ? node.name.text : undefined;
    return Object.fromEntries(members.map((member) => [member, declared.members
      .filter((node) => named(node) === member)
      .map((node) => [node.getFullStart(), node.end])]));
  });
}
