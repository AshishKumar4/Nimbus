// The interpreter's compiled code keeps nothing of the compile alive.
//
// compile.ts turns each function into closures that run as the program runs.
// V8 keeps, for every closure a function creates, everything any closure of
// that function invocation captures (they share one context). So if any
// closure in compile.ts captured the compiler (`this`), an AST node or an
// object of the scope analysis, every compiled closure created beside it
// would keep the whole AST and analysis of its unit alive: 5x the heap V8
// itself uses for the same code (tests/differential/interpreter-memory.mjs).
// This checks, with the type checker, that no closure in the modules whose
// closures outlive a compile (compile.ts and the runtime modules) captures a
// value of those types, or a value that holds one (an object, array or
// union whose members do, however deep: `const box = { node }` keeps the
// node as surely as `node` does). tests/unit/interpreter-retention.mjs
// checks the same at runtime, on the AST nodes a compile leaves alive.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const CORE = fileURLToPath(new URL('../../packages/core/', import.meta.url));
const DIR = join(CORE, 'src/interpreter');
/** Modules whose closures run only while a unit is analyzed or parsed, or that hold no code. */
const TRANSIENT = new Set(['scope.ts', 'reparse.ts', 'primordials.ts', 'host-ops.ts', 'unsupported.ts', 'unsupported-code.ts']);
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !TRANSIENT.has(f)).map((f) => join(DIR, f));
/**
 * Closures the guard must find, in a module of the interpreter's directory
 * (so acorn's types resolve as they do for the real ones): the node, the
 * node boxed in an object, nodes in an array in an object, a list of
 * analysis scopes. The last closure keeps only a string.
 */
const FIXTURE = join(DIR, '__closure-guard-fixture__.ts');
const FIXTURE_TEXT = `
import type { Node } from 'acorn';
import type { SafeList } from './intrinsics.js';
import type { Scope } from './scope.js';
export function direct(node: Node): () => string { return () => node.type; }
export function boxed(node: Node): () => string { const box = { node }; return () => box.node.type; }
export function listed(nodes: Node[]): () => number { const all = { nodes }; return () => all.nodes.length; }
export function scopes(list: SafeList<Scope>): () => number { return () => list.length; }
export function clean(node: Node): () => string { const type = node.type; return () => type; }
`;

/** Types a compiled closure must not keep: acorn's nodes, the scope analysis, the compiler. */
const HEAVY = new Set([
  'Compiler', 'Analysis', 'Analyzer', 'Scope', 'FunctionScope', 'Binding', 'Reference', 'ClassScopes',
  'Node', 'AnyNode', 'Program', 'Statement', 'Expression', 'Pattern', 'Identifier', 'Literal', 'ModuleDeclaration',
  'Super', 'SpreadElement', 'PrivateIdentifier', 'Property', 'PropertyDefinition', 'MethodDefinition', 'StaticBlock',
  'ClassBody', 'FunctionNode', 'ClassNode', 'TemplateElement', 'CatchClause', 'SwitchCase', 'VariableDeclarator',
]);
const NODE_NAME = /(Expression|Statement|Declaration|Pattern|Specifier|Element|Clause|Declarator)$/;
/**
 * Kept on purpose: a function compiled on its first call keeps what that
 * compile needs (LazySite: its unit's text and the scopes its analysis left,
 * released to what a later analysis reads, scope.ts releaseScopes).
 */
const RETAINED_ON_PURPOSE = new Set(['LazySite']);

const config = ts.getParsedCommandLineOfConfigFile(join(CORE, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const host = ts.createCompilerHost(config.options);
const { getSourceFile, fileExists, readFile } = host;
host.getSourceFile = (name, ...rest) => (name === FIXTURE ? ts.createSourceFile(name, FIXTURE_TEXT, ts.ScriptTarget.Latest, true) : getSourceFile(name, ...rest));
host.fileExists = (name) => name === FIXTURE || fileExists(name);
host.readFile = (name) => (name === FIXTURE ? FIXTURE_TEXT : readFile(name));
const program = ts.createProgram([...FILES, FIXTURE], config.options, host);
const checker = program.getTypeChecker();

/** Whether a value of `type` is, or holds, something a compiled closure must not keep. */
function heavy(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (type.isUnion() || type.isIntersection()) return type.types.some((t) => heavy(t, seen));
  const symbol = type.aliasSymbol || type.symbol;
  if (symbol && RETAINED_ON_PURPOSE.has(symbol.name)) return false;
  if (symbol && (HEAVY.has(symbol.name) || NODE_NAME.test(symbol.name))) return true;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return checker.getTypeArguments(type).some((t) => heavy(t, seen));
  // A collection holds what its type arguments are.
  if ((type.flags & ts.TypeFlags.Object) && (type.objectFlags & ts.ObjectFlags.Reference) && checker.getTypeArguments(type).some((t) => heavy(t, seen))) return true;
  // An object holds what its properties hold; a function's own type says nothing of what it closes over.
  if (!(type.flags & ts.TypeFlags.Object) || type.getCallSignatures().length > 0) return false;
  if (symbol && symbol.declarations && symbol.declarations.some((d) => d.getSourceFile().isDeclarationFile)) return false;
  return type.getProperties().some((p) => heavy(checker.getTypeOfSymbol(p), seen));
}

function enclosingFunction(node) {
  let p = node.parent;
  while (p && !ts.isFunctionLike(p) && !ts.isSourceFile(p)) p = p.parent;
  return p;
}

/** What `closure` captures from the functions around it that a compiled closure must not keep. */
function heavyCaptures(closure, source) {
  const found = new Set();
  const visit = (n) => {
    if (n.kind === ts.SyntaxKind.ThisKeyword && ts.isArrowFunction(closure)) {
      let p = n.parent;
      while (p !== closure && !(ts.isFunctionLike(p) && !ts.isArrowFunction(p))) p = p.parent;
      if (p === closure) found.add('this');
    }
    const isName = ts.isIdentifier(n)
      && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
      && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n);
    if (isName) {
      const symbol = checker.getSymbolAtLocation(n);
      const declaration = symbol && symbol.declarations && symbol.declarations[0];
      const local = declaration && declaration.getSourceFile() === source
        && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isBindingElement(declaration));
      if (local && !(declaration.pos >= closure.pos && declaration.end <= closure.end)) {
        const owner = enclosingFunction(declaration);
        if (owner && !ts.isSourceFile(owner) && heavy(checker.getTypeAtLocation(n))) found.add(n.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(closure, visit);
  return found;
}

/** The closures of `file` that capture what a compiled closure must not keep, by line. */
function violationsIn(file) {
  const source = program.getSourceFile(file);
  assert.ok(source, `${file} is part of the program`);
  const found = [];
  let closures = 0;
  const walk = (n) => {
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      closures++;
      const captured = heavyCaptures(n, source);
      if (captured.size > 0) {
        const line = source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
        found.push(`${file.slice(DIR.length + 1)}:${line} captures ${[...captured].join(', ')}`);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(source);
  return { found, closures };
}

assert.deepEqual(violationsIn(FIXTURE).found, [
  '__closure-guard-fixture__.ts:5 captures node',
  '__closure-guard-fixture__.ts:6 captures box',
  '__closure-guard-fixture__.ts:7 captures all',
  '__closure-guard-fixture__.ts:8 captures list',
], 'the guard finds a node however it is held');
const violations = [];
let closures = 0;
for (const file of FILES) {
  const result = violationsIn(file);
  violations.push(...result.found);
  closures += result.closures;
}
assert.ok(closures > 300, `the checker saw the interpreter's closures (${closures})`);
assert.deepEqual(violations, [], `closures that would keep the compile alive:\n${violations.join('\n')}`);
console.log(`${closures} closures in ${FILES.length} modules, none keeps the compiler, the AST or the analysis`);
