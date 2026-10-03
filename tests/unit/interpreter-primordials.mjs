// The interpreter reaches nothing a program can replace.
//
// The interpreter shares its realm with the program it runs, and the program
// may replace any built-in it can reach: a global (`Array`, `TypeError`), a
// prototype method (`Array.prototype.push`, `WeakMap.prototype.set`), the
// array iterator, an accessor on Object.prototype or Array.prototype. Each
// time the interpreter went through one, the replacement could watch or
// change the interpreter's own objects (its environments, private names,
// argument lists), which no native code can reach. So every built-in the
// interpreter uses is captured before any program code runs
// (primordials.ts, loaded at the launch's start), and the rest of the
// interpreter calls only those captures.
//
// This checks the interpreter's sources with the type checker, outside
// primordials.ts, for what would go through the program's realm instead:
//   - a global value (Array, Object, TypeError, Promise, globalThis, ...);
//   - a method or accessor declared by the built-in library (`.push`,
//     `.slice`, `.then`, `.call`, `.description`), except on the Safe*
//     collections, whose methods are copied when they are captured;
//   - for-of, spread and array destructuring, which run the array iterator;
//   - `in`, and the read of an optional property, which look up the
//     prototype chain when the property is absent;
//   - a property descriptor that inherits (ToPropertyDescriptor reads
//     `get` and `set` through Object.prototype);
//   - a generator function not made by safeGenerator (or genCode, which
//     calls it): driving its generators (next(), yield*) would look up
//     %GeneratorPrototype% and %IteratorPrototype%.
//
// And the parser bundled with it: acorn, as the interpreter bundle rewrites
// it (worker scripts/acorn-primordials.mjs), checked by parserReaches. acorn
// is JavaScript, which the type checker cannot type, so that check is by its
// syntax tree and acorn's own declarations: no global but the parser realm,
// no built-in method called but through it, no literal or constructor whose
// objects inherit, nothing iterated. tests/unit/interpreter-parser-realm.mjs
// runs the bundled parser in a realm that logs every built-in it reaches.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const CORE = fileURLToPath(new URL('../../packages/core/', import.meta.url));
const DIR = join(CORE, 'src/interpreter');
/**
 * Not checked: primordials.ts, where the captures are made, and host-ops.ts,
 * whose code runs at build time to make the source text of the host module
 * (which takes its built-ins from the runtime it is bound to).
 */
const UNCHECKED = new Set(['primordials.ts', 'host-ops.ts']);
const FILES = [
  ...readdirSync(DIR).filter((f) => f.endsWith('.ts') && !UNCHECKED.has(f)).map((f) => join(DIR, f)),
  join(CORE, 'src/_shared/runtime-function-source.ts'),
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

const config = ts.getParsedCommandLineOfConfigFile(join(CORE, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const program = ts.createProgram(FILES, config.options);
const checker = program.getTypeChecker();

const library = (declaration) => {
  const file = declaration.getSourceFile();
  return program.isSourceFileDefaultLibrary(file) || /[\\/]@types[\\/]node[\\/]/.test(file.fileName);
};
const fromLibrary = (symbol) => !!symbol && !!symbol.declarations && symbol.declarations.length > 0 && symbol.declarations.every(library);
const ours = (symbol) => !!symbol && !!symbol.declarations && symbol.declarations.some((d) => d.getSourceFile().fileName.startsWith(DIR));

function isValueName(node) {
  const p = node.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)
    || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === node) return false;
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isNamespaceImport(p) || ts.isImportClause(p)) ) return false;
  if (ts.isBindingElement(p) && p.propertyName === node) return false;
  if (ts.isQualifiedName(p) || ts.isTypeReferenceNode(p) || ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent) && p.parent.token === ts.SyntaxKind.ImplementsKeyword) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  for (let a = node; a; a = a.parent) if (ts.isTypeNode(a) && !ts.isExpressionWithTypeArguments(a)) return false;
  return true;
}

function receiverIsSafe(expression) {
  const type = checker.getTypeAtLocation(expression);
  const symbol = type.aliasSymbol || type.symbol;
  return !!symbol && SAFE.test(symbol.name);
}

const violations = [];
for (const file of FILES) {
  const source = program.getSourceFile(file);
  assert.ok(source, `${file} is part of the program`);
  const at = (node, what) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    violations.push(`${file.slice(CORE.length)}:${line} ${what}`);
  };
  const visit = (node) => {
    if (ts.isIdentifier(node) && isValueName(node) && !FIXED_GLOBALS.has(node.text)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (fromLibrary(symbol)) at(node, `names the global ${node.text}`);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression);
      const name = symbol && symbol.name;
      const owners = symbol && symbol.declarations ? symbol.declarations.map((d) => (d.parent && d.parent.name ? d.parent.name.text : '')) : [];
      const record = owners.length > 0 && owners.every((owner) => OWN_RECORDS.test(owner));
      if (fromLibrary(symbol) && !OWN_PROPERTIES.has(name) && !record && !receiverIsSafe(node.expression)) {
        at(node, `uses the built-in ${checker.typeToString(checker.getTypeAtLocation(node.expression))}.${name}`);
      }
      if (ts.isPropertyAccessExpression(node) && symbol && (symbol.flags & ts.SymbolFlags.Optional) && ours(symbol)) {
        at(node, `reads the optional property ${name}, which may be inherited`);
      }
    }
    if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.asteriskToken) {
      const call = node.parent;
      const made = ts.isCallExpression(call) && call.arguments[0] === node && ts.isIdentifier(call.expression)
        && SAFE_GENERATOR_MAKERS.has(call.expression.text);
      if (!made) at(node, 'makes a generator function outside safeGenerator');
    }
    if (ts.isForOfStatement(node)) at(node, 'iterates with for-of');
    if (ts.isSpreadElement(node)) at(node, 'spreads with the array iterator');
    if (ts.isArrayBindingPattern(node)) at(node, 'destructures with the array iterator');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(node.left)) {
      at(node, 'destructures with the array iterator');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) at(node, "looks up a key with 'in'");
    if (ts.isObjectBindingPattern(node)) {
      const type = checker.getTypeAtLocation(node);
      for (const element of node.elements) {
        const key = element.propertyName || element.name;
        if (!ts.isIdentifier(key)) continue;
        const property = type.getProperty(key.text);
        if (property && (property.flags & ts.SymbolFlags.Optional) && ours(property)) at(element, `destructures the optional property ${key.text}`);
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const contextual = checker.getContextualType(node);
      const parts = !contextual ? [] : contextual.isIntersection() || contextual.isUnion() ? contextual.types : [contextual];
      const descriptor = parts.some((t) => { const named = t.aliasSymbol || t.symbol; return !!named && /PropertyDescriptor$/.test(named.name); });
      if (descriptor) at(node, 'makes a property descriptor that inherits (dataDescriptor and accessorDescriptor do not)');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

console.log(violations.join('\n'));
assert.deepEqual(violations, [], `the interpreter goes through ${violations.length} built-ins a program can replace`);
console.log(`${FILES.length} files: the interpreter calls only the built-ins primordials.ts captured`);

const { bundleInterpreter } = await import('../../packages/worker/scripts/interpreter-bundle.mjs');
const { parserReaches, primordialAcorn } = await import('../../packages/worker/scripts/acorn-primordials.mjs');
const { parser } = await bundleInterpreter({ start: fileURLToPath(new URL('../../packages/worker/', import.meta.url)) });
const reaches = parserReaches(parser);
console.log(reaches.join('\n'));
assert.deepEqual(reaches, [], `the bundled parser reaches ${reaches.length} built-ins a program can replace`);
console.log(`the bundled parser (${parser.length} characters) reaches the realm only through parser-realm.ts`);

// What an acorn upgrade could add, which the rewrite must refuse or make safe however it is spelled.
const acornSource = readFileSync(createRequire(join(CORE, 'package.json')).resolve('acorn').replace(/acorn\.js$/, 'acorn.mjs'), 'utf8');
const ANCHOR = 'var lineBreakG = new RegExp(lineBreak.source, "g");';
assert.ok(acornSource.includes(ANCHOR) && acornSource.includes('switch (this.input[this.pos]) {'), 'the upgrade fixtures still find their places in acorn');
// A regexp is safe however it is read once it inherits only captures: each regexp fixture checks lineBreak's is.
const SAFE_LINE_BREAK = 'var lineBreak = $$.regexp(/\\r\\n?|\\n|\\u2028|\\u2029/);';
const upgrades = {
  'a cached RegExp.prototype method': [acornSource.replace(ANCHOR, `${ANCHOR}\nvar runRegExp = RegExp.prototype.exec;`), null],
  'a cached method of a regexp': [acornSource.replace(ANCHOR, `${ANCHOR}\nvar testLine = lineBreak.test;`), SAFE_LINE_BREAK],
  'an alias of the source text, indexed': [acornSource.replace('switch (this.input[this.pos]) {', 'var text = this.input; switch (text[this.pos]) {'), '$$.index(text, this.pos)'],
  'an alias of a regexp, read for its source': [acornSource.replace(ANCHOR, 'var lineBreakAlias = lineBreak;\nvar lineBreakG = new RegExp(lineBreakAlias.source, "g");'), SAFE_LINE_BREAK],
  "a regexp's source, read by a computed key": [acornSource.replace(ANCHOR, 'var lineBreakG = new RegExp(lineBreak["source"], "g");'), SAFE_LINE_BREAK],
};
for (const [name, [text, routed]] of Object.entries(upgrades)) {
  let rewritten = null;
  try { rewritten = primordialAcorn(text, '/parser-realm.ts').code; } catch (e) { assert.equal(routed, null, `${name}: refused (${e.message})`); continue; }
  assert.ok(routed !== null && rewritten.includes(routed), `${name}: made safe (${routed})`);
  assert.deepEqual(parserReaches(rewritten), [], `${name}: no reach once rewritten`);
  assert.ok(parserReaches(text).length > 0, `${name}: found by the check unrewritten`);
}
console.log(`${Object.keys(upgrades).length} upgrade fixtures: refused or made safe`);
