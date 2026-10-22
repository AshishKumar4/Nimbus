// The check of tests/unit/identity-change-choke-point.mjs: where ProcessTable
// and its spawn are referred to, by what each reference resolves to (tsrs's
// type checker over the root tsconfig's program). It runs in Node, where
// tsrs's API runs (scripts/lib/tsrs-api.mjs).
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isClassDeclaration, isExportSpecifier, isFunctionDeclaration, isIdentifier, isImportClause, isImportSpecifier, isMethodDeclaration,
  isPropertyDeclaration, isTypeQueryNode, isTypeReferenceNode, SyntaxKind,
} from 'tsrs/unstable/ast';
import { SymbolFlags } from 'tsrs/unstable/sync';
import { inNode, RUNS_TSRS_API } from '../../../scripts/lib/tsrs-api.mjs';
import { withTsrs } from './tsrs-program.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const TABLE = join(repo, 'packages/core/src/runtime/process-table.ts');

/** Where `node` is, as `file Class.member` (or the function's name). */
function where(node) {
  let name = '';
  for (let at = node.parent; at && name === ''; at = at.parent) {
    if ((isMethodDeclaration(at) || isPropertyDeclaration(at)) && isClassDeclaration(at.parent)) name = `${at.parent.name?.text}.${at.name.getText()}`;
    else if (isFunctionDeclaration(at)) name = at.name?.text ?? '(function)';
  }
  return `${relative(repo, node.getSourceFile().fileName)} ${name}`;
}

/**
 * The places that refer to ProcessTable.spawn, and those that use the
 * ProcessTable class as a value (made, aliased, passed; not as a type or an
 * import's name), each as `file Class.member`.
 *
 * @returns {{ spawnReferences: string[], tableValues: string[] }}
 */
export function processTableReferences() {
  if (!RUNS_TSRS_API) return inNode(import.meta.url, 'processTableReferences');
  return withTsrs({ cwd: repo }, (api) => {
    const config = api.parseConfigFile(join(repo, 'tsconfig.json'));
    const program = api.createProgram(config.fileNames, config.options);
    const checker = program.getProject().checker;
    /** The declaration a symbol names, through import aliases, as a handle. */
    const declarationOf = (symbol) => {
      if (symbol && symbol.flags & SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    };
    const spawnReferences = [];
    const tableValues = [];
    for (const fileName of program.getSourceFileNames()) {
      if (!fileName.startsWith(repo) || /\.d\.[mc]?ts$/.test(fileName)) continue;
      const file = program.getSourceFile(fileName);
      const names = [];
      /** @param {import('tsrs/unstable/ast').Node} node */
      const collect = (node) => {
        if (isIdentifier(node) && !(node.parent && isMethodDeclaration(node.parent) && node.parent.name === node)) names.push(node);
        node.forEachChild(collect);
      };
      collect(file);
      if (names.length === 0) continue;
      // One request for the file's names; only a name declared in process-table.ts is read further.
      const symbols = checker.getSymbolAtLocation(names);
      names.forEach((node, i) => {
        const handle = declarationOf(symbols[i]);
        if (handle === undefined || handle.path !== TABLE) return;
        const declaration = handle.resolve();
        if (declaration === undefined) return;
        if (handle.kind === SyntaxKind.MethodDeclaration && declaration.parent.name?.text === 'ProcessTable' && declaration.name.getText() === 'spawn') {
          spawnReferences.push(where(node));
        }
        // The class's own name, where it is declared, is no use of it.
        const ownName = fileName === TABLE && node.pos === declaration.name?.pos;
        if (handle.kind === SyntaxKind.ClassDeclaration && declaration.name?.text === 'ProcessTable' && !ownName
          && !isTypeReferenceNode(node.parent) && !isTypeQueryNode(node.parent)
          && !isImportSpecifier(node.parent) && !isImportClause(node.parent) && !isExportSpecifier(node.parent)) tableValues.push(where(node));
      });
    }
    return { spawnReferences, tableValues };
  });
}
