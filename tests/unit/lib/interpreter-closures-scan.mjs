// The guard of tests/unit/interpreter-closures.mjs: which closures of the
// interpreter capture what a compiled closure must not keep, by tsrs's type
// checker. It runs in Node, where tsrs's API runs (scripts/lib/tsrs-api.mjs).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isArrowFunction, isBindingElement, isFunctionExpression, isFunctionLike, isIdentifier, isParameter, isPropertyAccessExpression,
  isPropertyAssignment, isSourceFile, isVariableDeclaration, SyntaxKind } from 'tsrs/unstable/ast';
import { ObjectFlags, TypeFlags } from 'tsrs/unstable/sync';
import { inNode, RUNS_TSRS_API } from '../../../scripts/lib/tsrs-api.mjs';
import { withTsrs } from './tsrs-program.mjs';

const CORE = fileURLToPath(new URL('../../../packages/core/', import.meta.url));
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

/** Whether a value of `type` is, or holds, something a compiled closure must not keep. */
function heavy(checker, type, seen = new Set()) {
  if (!type || seen.has(type.id)) return false;
  seen.add(type.id);
  if (type.flags & (TypeFlags.Union | TypeFlags.Intersection)) return type.getTypes().some((t) => heavy(checker, t, seen));
  const symbol = type.getAliasSymbol() || type.getSymbol();
  if (symbol && RETAINED_ON_PURPOSE.has(symbol.name)) return false;
  if (symbol && (HEAVY.has(symbol.name) || NODE_NAME.test(symbol.name))) return true;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return checker.getTypeArguments(type).some((t) => heavy(checker, t, seen));
  // A collection holds what its type arguments are.
  if ((type.flags & TypeFlags.Object) && (type.objectFlags & ObjectFlags.Reference) && checker.getTypeArguments(type).some((t) => heavy(checker, t, seen))) return true;
  // An object holds what its properties hold; a function's own type says nothing of what it closes over.
  if (!(type.flags & TypeFlags.Object) || type.getCallSignatures().length > 0) return false;
  if (symbol && symbol.declarations.some((d) => /\.d\.[mc]?ts$/.test(d.path))) return false;
  return type.getProperties().some((p) => heavy(checker, checker.getTypeOfSymbol(p), seen));
}

function enclosingFunction(node) {
  let p = node.parent;
  while (p && !isFunctionLike(p) && !isSourceFile(p)) p = p.parent;
  return p;
}

/** What `closure` captures from the functions around it that a compiled closure must not keep. */
function heavyCaptures(checker, closure, source) {
  const found = new Set();
  const visit = (n) => {
    if (n.kind === SyntaxKind.ThisKeyword && isArrowFunction(closure)) {
      let p = n.parent;
      while (p !== closure && !(isFunctionLike(p) && !isArrowFunction(p))) p = p.parent;
      if (p === closure) found.add('this');
    }
    const isName = isIdentifier(n)
      && !(isPropertyAccessExpression(n.parent) && n.parent.name === n)
      && !(isPropertyAssignment(n.parent) && n.parent.name === n);
    if (isName) {
      const symbol = checker.getSymbolAtLocation(n);
      const handle = symbol && symbol.declarations[0];
      const declaration = handle && handle.path === source.path ? handle.resolve() : undefined;
      const local = declaration && (isVariableDeclaration(declaration) || isParameter(declaration) || isBindingElement(declaration));
      if (local && !(declaration.pos >= closure.pos && declaration.end <= closure.end)) {
        const owner = enclosingFunction(declaration);
        if (owner && !isSourceFile(owner) && heavy(checker, checker.getTypeAtLocation(n))) found.add(n.text);
      }
    }
    n.forEachChild(visit);
  };
  closure.forEachChild(visit);
  return found;
}

/** The closures of `file` that capture what a compiled closure must not keep, by line. */
function violationsIn(program, checker, file) {
  const source = program.getSourceFile(file);
  assert.ok(source, `${file} is part of the program`);
  const found = [];
  let closures = 0;
  const walk = (n) => {
    if (isArrowFunction(n) || isFunctionExpression(n)) {
      closures++;
      const captured = heavyCaptures(checker, n, source);
      if (captured.size > 0) {
        const line = source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
        found.push(`${file.slice(DIR.length + 1)}:${line} captures ${[...captured].join(', ')}`);
      }
    }
    n.forEachChild(walk);
  };
  walk(source);
  return { found, closures };
}

/**
 * The closures that would keep the compile alive: in the fixture, which the
 * guard must find, and in the interpreter's modules, which must have none;
 * and how many closures the checker saw there. tsrs's checker, over those
 * modules and the fixture, under core's own settings.
 *
 * @returns {{ fixture: string[], violations: string[], closures: number, modules: number }}
 */
export function closureScan() {
  if (!RUNS_TSRS_API) return inNode(import.meta.url, 'closureScan');
  return withTsrs({ cwd: CORE, overlay: { [FIXTURE]: FIXTURE_TEXT } }, (api) => {
    const config = api.parseConfigFile(join(CORE, 'tsconfig.json'));
    const program = api.createProgram([...FILES, FIXTURE], config.options);
    const checker = program.getProject().checker;
    const all = FILES.map((file) => violationsIn(program, checker, file));
    return {
      fixture: violationsIn(program, checker, FIXTURE).found,
      violations: all.flatMap((result) => result.found),
      closures: all.reduce((sum, result) => sum + result.closures, 0),
      modules: FILES.length,
    };
  });
}

