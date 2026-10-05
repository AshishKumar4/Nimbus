import { simple } from 'acorn-walk';
import MagicString from 'magic-string';

import {
  type AstNode,
  literalStringValue,
  nodeList,
  nodeProp,
  parseJavaScriptModule,
  stringField,
} from './javascript-ast.js';

export interface StaticModuleSpecifierContext {
  nodeType: string;
  isSideEffectImport: boolean;
}

export interface ModuleSourceRewriteOptions {
  staticSpecifier(specifier: string, context: StaticModuleSpecifierContext): string | undefined;
  /** The text the whole `import(specifier)` expression becomes. */
  dynamicImport?(specifier: string): string | undefined;
  /** The specifier an `import(specifier)` takes instead, the rest of the expression kept. */
  dynamicImportSpecifier?(specifier: string): string | undefined;
  createRequireCallee?: string;
}

export function rewriteJavaScriptModuleSource(
  source: string,
  options: ModuleSourceRewriteOptions,
): string {
  const ast = parseJavaScriptModule(source);
  const edits = new MagicString(source);

  simple(ast, {
    ImportDeclaration(node) {
      rewriteStaticSpecifier(node as AstNode, options, edits);
    },
    ExportNamedDeclaration(node) {
      rewriteStaticSpecifier(node as AstNode, options, edits);
    },
    ExportAllDeclaration(node) {
      rewriteStaticSpecifier(node as AstNode, options, edits);
    },
    ImportExpression(node) {
      rewriteDynamicImport(node as AstNode, options, edits);
    },
    CallExpression(node) {
      rewriteCreateRequireCall(node as AstNode, options, edits);
    },
  });

  return edits.toString();
}

function rewriteStaticSpecifier(
  node: AstNode,
  options: ModuleSourceRewriteOptions,
  edits: MagicString,
): void {
  const sourceNode = nodeProp(node, 'source');
  const specifier = literalStringValue(sourceNode);
  if (!specifier) return;
  const replacement = options.staticSpecifier(specifier, {
    nodeType: node.type,
    isSideEffectImport: node.type === 'ImportDeclaration' && nodeList(node, 'specifiers').length === 0,
  });
  if (replacement) overwriteNode(edits, sourceNode, JSON.stringify(replacement));
}

function rewriteDynamicImport(
  node: AstNode,
  options: ModuleSourceRewriteOptions,
  edits: MagicString,
): void {
  if (!options.dynamicImport && !options.dynamicImportSpecifier) return;

  const sourceNode = nodeProp(node, 'source');
  const specifier = literalStringValue(sourceNode);
  if (!specifier) return;
  const replacement = options.dynamicImport?.(specifier);
  if (replacement) {
    overwriteNode(edits, node, replacement);
    return;
  }
  const renamed = options.dynamicImportSpecifier?.(specifier);
  if (renamed) overwriteNode(edits, sourceNode, JSON.stringify(renamed));
}

function rewriteCreateRequireCall(
  node: AstNode,
  options: ModuleSourceRewriteOptions,
  edits: MagicString,
): void {
  if (!options.createRequireCallee || node.type !== 'CallExpression') return;
  const callee = nodeProp(node, 'callee');
  if (callee?.type !== 'Identifier' || stringField(callee, 'name') !== 'createRequire') return;
  overwriteNode(edits, callee, options.createRequireCallee);
}

function overwriteNode(edits: MagicString, node: AstNode | undefined, text: string): void {
  if (typeof node?.start !== 'number' || typeof node.end !== 'number') return;
  edits.overwrite(node.start, node.end, text);
}
