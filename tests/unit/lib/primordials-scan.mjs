// The check of tests/unit/primordials-audit.mjs: what the interpreter and the
// guest's module loading reach that a program can replace, by tsrs's type
// checker. It runs in Node, where tsrs's API runs (scripts/lib/tsrs-api.mjs).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isArrayBindingPattern, isArrayLiteralExpression, isBinaryExpression, isBindingElement, isBreakOrContinueStatement, isCallExpression,
  isElementAccessExpression, isEnumMember, isExportSpecifier, isExpressionWithTypeArguments, isForOfStatement, isFunctionDeclaration,
  isFunctionExpression, isGetAccessorDeclaration, isHeritageClause, isIdentifier, isImportClause, isImportSpecifier, isLabeledStatement,
  isMethodDeclaration, isNamespaceImport, isObjectBindingPattern, isObjectLiteralExpression, isPropertyAccessExpression,
  isPropertyAssignment, isPropertyDeclaration, isPropertySignatureDeclaration, isQualifiedName, isSetAccessorDeclaration, isSpreadElement, isTypeNode,
  isTypeReferenceNode, SyntaxKind,
} from 'tsrs/unstable/ast';
import { isIntersectionType, isUnionType, SymbolFlags } from 'tsrs/unstable/sync';
import { inNode, RUNS_TSRS_API } from '../../../scripts/lib/tsrs-api.mjs';
import { withTsrs } from './tsrs-program.mjs';

const CORE = fileURLToPath(new URL('../../../packages/core/', import.meta.url));
const DIR = join(CORE, 'src/interpreter');
/**
 * Not checked: primordials.ts, where the captures are made, and host-ops.ts,
 * whose code runs at build time to make the source text of the host module
 * (which takes its built-ins from the runtime it is bound to).
 */
const UNCHECKED = new Set(['primordials.ts', 'host-ops.ts']);
/** The mark of a line that reaches the program's realm because Node's own code does (posix-path.ts: lib/path.js join's push). */
const LIVE_AS_NODE = /\/\/ as Node's, live:/;
/** The guest's module loading, as it is converted: node:path's posix half, the module resolvers, their package maps and TypeScript rules, Node's errors. */
const GUEST_LOADING = [
  ...['posix-path.ts', 'esm-resolver.ts', 'package-map.ts', 'node-error.ts', 'commonjs-resolver.ts', 'typescript-specifiers.ts']
    .map((file) => join(CORE, 'src/_shared', file)),
  // The late graph's link and the wasm images a module names.
  join(CORE, 'src/runtime/esm-late-link.ts'),
  // What identifies the code a program produces, keyed as it compiles.
  join(CORE, 'src/_shared/runtime-code-identity.ts'),
  join(CORE, 'src/_shared/relative-wasm-paths.ts'),
  // The filesystem reads it makes: the resident namespace's walk.
  fileURLToPath(new URL('../../../packages/worker/src/vfs/resident/namespace-lookup.ts', import.meta.url)),
  fileURLToPath(new URL('../../../packages/worker/src/vfs/resident/namespace.ts', import.meta.url)),
  fileURLToPath(new URL('../../../packages/worker/src/vfs/resident/transport.ts', import.meta.url)),
  fileURLToPath(new URL('../../../packages/worker/src/vfs/resident/cells.ts', import.meta.url)),
  fileURLToPath(new URL('../../../packages/worker/src/vfs/resident/cell-cost.ts', import.meta.url)),
];
const FILES = [
  ...readdirSync(DIR).filter((f) => f.endsWith('.ts') && !UNCHECKED.has(f)).map((f) => join(DIR, f)),
  join(CORE, 'src/_shared/runtime-function-source.ts'),
  join(CORE, 'src/_shared/importer-url.ts'),
  join(CORE, 'src/runtime/binding-pattern.ts'),
  join(CORE, 'src/runtime/esm-interop.ts'),
  ...GUEST_LOADING,
];
/** Globals that are not writable or configurable, so nothing can replace them. */
const FIXED_GLOBALS = new Set(['undefined', 'NaN', 'Infinity']);
/** Library properties that are own data properties of the objects that have them. */
const OWN_PROPERTIES = new Set(['length', 'prototype']);
/**
 * Library types whose members are own data properties of every object the
 * interpreter reads them on: descriptors it makes (dataDescriptor,
 * accessorDescriptor) or [[GetOwnProperty]] returns, the results of its
 * own generators' next(), and what RegExp.prototype.exec returns (each
 * element, `index`).
 */
const OWN_RECORDS = /^(PropertyDescriptor|TypedPropertyDescriptor|IteratorResult|IteratorYieldResult|IteratorReturnResult|RegExpExecArray)$/;
/** What gives a generator function SafeGeneratorPrototype. */
const SAFE_GENERATOR_MAKERS = new Set(['safeGenerator', 'genCode']);
/** Collections whose methods primordials.ts copies onto their own prototypes. */
const SAFE = /^Safe(Map|Set|WeakMap|WeakSet)$/;

/** A symbol's declarations, as handles: each names its file, and is read as a node only when asked for. */
const declared = (symbol) => (symbol ? symbol.declarations : []);
const ours = (symbol) => declared(symbol).some((d) => d.path.startsWith(DIR) || GUEST_LOADING.includes(d.path));

function isValueName(node) {
  const p = node.parent;
  if (isPropertyAccessExpression(p) && p.name === node) return false;
  if ((isPropertyAssignment(p) || isPropertyDeclaration(p) || isMethodDeclaration(p) || isPropertySignatureDeclaration(p)
    || isGetAccessorDeclaration(p) || isSetAccessorDeclaration(p) || isEnumMember(p)) && p.name === node) return false;
  if ((isImportSpecifier(p) || isExportSpecifier(p) || isNamespaceImport(p) || isImportClause(p)) ) return false;
  if (isBindingElement(p) && p.propertyName === node) return false;
  if (isQualifiedName(p) || isTypeReferenceNode(p) || isExpressionWithTypeArguments(p) && isHeritageClause(p.parent) && p.parent.token === SyntaxKind.ImplementsKeyword) return false;
  if (isLabeledStatement(p) || isBreakOrContinueStatement(p)) return false;
  for (let a = node; a; a = a.parent) if (isTypeNode(a) && !isExpressionWithTypeArguments(a)) return false;
  return true;
}

/** The name a type is known by: its alias's, else its symbol's. */
const typeName = (type) => (type.getAliasSymbol() || type.getSymbol())?.name;

/**
 * What the interpreter and the guest's module loading reach that a program
 * can replace, each as `<file>:<line> <what>`; and how many files were
 * checked. tsrs's checker, over those files under core's own settings.
 *
 * @returns {{ violations: string[], files: number }}
 */
export function primordialViolations() {
  if (!RUNS_TSRS_API) return inNode(import.meta.url, 'primordialViolations');
  const violations = withTsrs({ cwd: CORE }, (api) => {
    const config = api.parseConfigFile(join(CORE, 'tsconfig.json'));
    const program = api.createProgram(FILES, config.options);
    const checker = program.getProject().checker;
    /** Whether the file at `path` is the library's: the default library's, or @types/node's. */
    const libraries = new Map();
    const library = (path) => {
      if (!libraries.has(path)) libraries.set(path, /[\\/]@types[\\/]node[\\/]/.test(path) || program.isSourceFileDefaultLibrary(program.getSourceFile(path)));
      return libraries.get(path);
    };
    const fromLibrary = (symbol) => declared(symbol).length > 0 && declared(symbol).every((d) => library(d.path));
    const receiverIsSafe = (expression) => SAFE.test(typeName(checker.getTypeAtLocation(expression)) ?? '');
    const found = [];
    for (const file of FILES) {
      const source = program.getSourceFile(file);
      assert.ok(source, `${file} is part of the program`);
      const at = (node, what) => {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        // A call Node's own code makes through the program's realm, which a port of it must make too: marked on its line.
        if (LIVE_AS_NODE.test(source.text.split('\n')[line - 1])) return;
        found.push(`${file.startsWith(CORE) ? file.slice(CORE.length) : file}:${line} ${what}`);
      };
      const visit = (node) => {
        if (isIdentifier(node) && isValueName(node) && !FIXED_GLOBALS.has(node.text)) {
          const symbol = checker.getSymbolAtLocation(node);
          if (fromLibrary(symbol)) at(node, `names the global ${node.text}`);
        }
        if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
          const symbol = checker.getSymbolAtLocation(isPropertyAccessExpression(node) ? node.name : node.argumentExpression);
          const name = symbol && symbol.name;
          const library = fromLibrary(symbol);
          // The interfaces a library property is declared in, read only for a library property.
          const owners = library ? declared(symbol).map((d) => d.resolve()).map((d) => (d && d.parent && d.parent.name ? d.parent.name.text : '')) : [];
          const record = owners.length > 0 && owners.every((owner) => OWN_RECORDS.test(owner));
          if (library && !OWN_PROPERTIES.has(name) && !record && !receiverIsSafe(node.expression)) {
            at(node, `uses the built-in ${checker.typeToString(checker.getTypeAtLocation(node.expression))}.${name}`);
          }
          if (isPropertyAccessExpression(node) && symbol && (symbol.flags & SymbolFlags.Optional) && ours(symbol)) {
            at(node, `reads the optional property ${name}, which may be inherited`);
          }
        }
        if ((isFunctionExpression(node) || isFunctionDeclaration(node) || isMethodDeclaration(node)) && node.asteriskToken) {
          const call = node.parent;
          const made = isCallExpression(call) && call.arguments[0] === node && isIdentifier(call.expression)
            && SAFE_GENERATOR_MAKERS.has(call.expression.text);
          if (!made) at(node, 'makes a generator function outside safeGenerator');
        }
        if (isForOfStatement(node)) at(node, 'iterates with for-of');
        if (isSpreadElement(node)) at(node, 'spreads with the array iterator');
        if (isArrayBindingPattern(node)) at(node, 'destructures with the array iterator');
        if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken && isArrayLiteralExpression(node.left)) {
          at(node, 'destructures with the array iterator');
        }
        if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.InKeyword) at(node, "looks up a key with 'in'");
        if (isObjectBindingPattern(node)) {
          const type = checker.getTypeAtLocation(node);
          for (const element of node.elements) {
            const key = element.propertyName || element.name;
            if (!isIdentifier(key)) continue;
            const property = type.getProperty(key.text);
            if (property && (property.flags & SymbolFlags.Optional) && ours(property)) at(element, `destructures the optional property ${key.text}`);
          }
        }
        if (isObjectLiteralExpression(node)) {
          const contextual = checker.getContextualType(node);
          const parts = !contextual ? [] : isUnionType(contextual) || isIntersectionType(contextual) ? contextual.getTypes() : [contextual];
          if (parts.some((t) => /PropertyDescriptor$/.test(typeName(t) ?? ''))) {
            at(node, 'makes a property descriptor that inherits (dataDescriptor and accessorDescriptor do not)');
          }
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
    return found;
  });
  return { violations, files: FILES.length };
}

