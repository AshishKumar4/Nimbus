// The interpreter's compiled code keeps nothing of the compile alive.
//
// compile.ts turns each function into closures that run as the program runs.
// V8 keeps, for every closure a function creates, everything any closure of
// that function invocation captures (they share one context). So if any
// closure in compile.ts captured the compiler (`this`), an AST node or an
// object of the scope analysis, every compiled closure created beside it
// would keep the whole AST and analysis of its unit alive: 5x the heap V8
// itself uses for the same code (tests/differential/interpreter-memory.mjs).
// This checks, with the type checker, that no closure in compile.ts captures
// a value of those types.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const CORE = fileURLToPath(new URL('../../packages/core/', import.meta.url));
const FILE = join(CORE, 'src/interpreter/compile.ts');

/** Types a compiled closure must not keep: acorn's nodes, the scope analysis, the compiler. */
const HEAVY = new Set([
  'Compiler', 'Analysis', 'Analyzer', 'Scope', 'FunctionScope', 'Binding', 'Reference', 'ClassScopes',
  'Node', 'AnyNode', 'Program', 'Statement', 'Expression', 'Pattern', 'Identifier', 'Literal', 'ModuleDeclaration',
  'Super', 'SpreadElement', 'PrivateIdentifier', 'Property', 'PropertyDefinition', 'MethodDefinition', 'StaticBlock',
  'ClassBody', 'FunctionNode', 'ClassNode', 'TemplateElement', 'CatchClause', 'SwitchCase', 'VariableDeclarator',
]);
const NODE_NAME = /(Expression|Statement|Declaration|Pattern|Specifier|Element|Clause|Declarator)$/;

const config = ts.getParsedCommandLineOfConfigFile(join(CORE, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const program = ts.createProgram([FILE], config.options);
const checker = program.getTypeChecker();
const source = program.getSourceFile(FILE);
assert.ok(source, 'compile.ts is part of the program');

function heavy(type, depth = 0) {
  if (!type || depth > 3) return false;
  if (type.isUnion() || type.isIntersection()) return type.types.some((t) => heavy(t, depth + 1));
  const symbol = type.aliasSymbol || type.symbol;
  if (symbol && (HEAVY.has(symbol.name) || NODE_NAME.test(symbol.name))) return true;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return checker.getTypeArguments(type).some((t) => heavy(t, depth + 1));
  return false;
}

function enclosingFunction(node) {
  let p = node.parent;
  while (p && !ts.isFunctionLike(p) && !ts.isSourceFile(p)) p = p.parent;
  return p;
}

/** What `closure` captures from the functions around it that a compiled closure must not keep. */
function heavyCaptures(closure) {
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

const violations = [];
let closures = 0;
const walk = (n) => {
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
    closures++;
    const captured = heavyCaptures(n);
    if (captured.size > 0) {
      const line = source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
      violations.push(`compile.ts:${line} captures ${[...captured].join(', ')}`);
    }
  }
  ts.forEachChild(n, walk);
};
walk(source);
assert.ok(closures > 300, `the checker saw compile.ts's closures (${closures})`);
assert.deepEqual(violations, [], `closures that would keep the compile alive:\n${violations.join('\n')}`);
console.log(`${closures} closures in compile.ts, none keeps the compiler, the AST or the analysis`);
