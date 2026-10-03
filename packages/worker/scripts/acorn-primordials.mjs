/**
 * acorn-primordials.mjs — acorn as the interpreter bundles it: rewritten, by
 * its syntax tree, to reach no built-in a program can replace.
 *
 * The interpreter parses code a program produced, in that program's realm,
 * after the program may have replaced any built-in. acorn as published calls
 * the realm's built-ins and makes objects that inherit from its prototypes,
 * so a replaced Array.prototype.push receives every node acorn builds and
 * can change the program being parsed (core src/interpreter/parser-realm.ts
 * says what that allows). The rewrite, of acorn's own source text, with the
 * same names and structure:
 *
 *   - a built-in acorn names (Object.create, String.fromCharCode, RegExp,
 *     SyntaxError, ...) is parser-realm's, captured at the launch's start;
 *   - a call of a method a string, list, regexp or function has
 *     (`s.charCodeAt(i)`, `list.push(x)`, `re.test(s)`, `f.call(t)`) is a
 *     call of parser-realm's function of that name, on any receiver but
 *     `this` (always one of acorn's own objects);
 *   - an object literal inherits nothing (parser-realm `own`), a list
 *     literal is a list that inherits nothing (`list`), a regexp (a literal,
 *     or made with RegExp) inherits only RegExp.prototype's members as
 *     captured (`regexp`), and each of acorn's constructors and its prototype
 *     inherit nothing from the statement that declares it on
 *     (`nullPrototypes`), so a field a node lacks is not looked up anywhere,
 *     no field acorn sets runs a setter, and nothing read of a regexp is the
 *     realm's;
 *   - a field set on an error acorn made with the realm's constructor is
 *     defined (`define`); a computed read of a string is parser-realm's
 *     `index`, which reads its character without looking past its end; a
 *     built-in's member acorn reads is its capture, and any other read of a
 *     built-in method's name, but a field acorn sets, stops the build.
 *
 *   - a built-in acorn names is held only where it is called, constructed or
 *     tested with typeof, or by a variable used the same way: nothing of it is
 *     read, and nothing but RegExp and the errors constructed;
 *   - `new` constructs only acorn's own constructors (variables whose value is
 *     a function literal, made to inherit nothing), the RegExp and errors
 *     above, or `this` once parser-realm has checked it is such a constructor;
 *     `for (k in o)` enumerates `o` once parser-realm has checked it inherits
 *     nothing of the realm's; `arguments` is only read for its length or,
 *     through parser-realm's `argument`, an element it has; a caught exception
 *     is only compared and rethrown;
 *   - a method is called only by a name acorn sets somewhere, and nothing is
 *     read of a function of acorn's but one made to inherit nothing; a function
 *     is declared only at the top of a module or function;
 *   - a method called by a constant computed key is called as by its name; by
 *     any other key, only on a list acorn made.
 *
 * Anything the rewrite does not know how to make safe (a global it has no
 * capture for, `instanceof`, a template literal, an iteration, a
 * destructuring pattern, a rest parameter) stops the build, so an acorn
 * upgrade that reaches something new fails here rather than at runtime.
 * parser-audit.mjs checks the output with nothing of this rewrite's:
 * tests/unit/interpreter-primordials.mjs requires it to find nothing.
 */

import { parse } from 'acorn';

/** The namespace the rewritten parser imports parser-realm as. */
const REALM = '$$';

/** Globals that are not writable or configurable. */
const FIXED = new Set(['undefined', 'NaN', 'Infinity']);

/** A built-in's member acorn reads, by global, and the parser-realm export that is its capture. */
const GLOBAL_MEMBERS = {
  Object: { create: 'objectCreate', keys: 'objectKeys', defineProperties: 'objectDefineProperties', hasOwn: 'objectHasOwn', prototype: 'ObjectPrototypeMethods' },
  Array: { isArray: 'arrayIsArray' },
  String: { fromCharCode: 'stringFromCharCode' },
  Symbol: { iterator: 'symbolIterator' },
  console: { warn: 'consoleWarn' },
};

/**
 * parser-realm's exports that are records of captured methods, and the names
 * they hold: what acorn reads of Object.prototype, through the binding it
 * keeps it in (`var ref = Object.prototype; var toString = ref.toString`).
 */
const RECORDS = { ObjectPrototypeMethods: new Set(['hasOwnProperty', 'toString']) };

/** parser-realm's exports that are symbols, which may be a computed key: a key as they are. */
const SYMBOLS = new Set(['symbolIterator']);

/**
 * Globals acorn names, each parser-realm's export of the same name: called,
 * constructed or tested with typeof, never read from. RegExp is a function
 * that makes a regexp safe however it is called; an error constructor may
 * only be constructed where what is set on the error can be rewritten.
 */
const GLOBALS = new Set(['String', 'RegExp', 'SyntaxError', 'Error', 'BigInt', 'parseInt', 'parseFloat', 'Symbol', 'console']);

/** Methods of strings, lists, regexps and functions acorn calls: parser-realm's functions of these names. */
export const ROUTED_METHODS = new Set([
  'charCodeAt', 'charAt', 'substr', 'slice', 'indexOf', 'lastIndexOf', 'push', 'pop',
  'test', 'exec', 'replace', 'split', 'match', 'call', 'toString',
]);

/** Realm constructors whose instances acorn sets fields on. */
const REALM_CONSTRUCTORS = new Set(['SyntaxError', 'Error']);

/**
 * Names the built-in prototypes have, in the realm running the build: what
 * a read of a string, number, list, regexp, function or error (or any object
 * that inherits from Object.prototype) finds there. (A constructor's own
 * members, `String.raw`, are read only through the constructor, which acorn
 * names only as a global.) Not `length`, which each of those has as its own.
 */
const BUILTIN_NAMES = (() => {
  const iterator = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  const owners = [
    Object.prototype, Function.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype,
    BigInt.prototype, Symbol.prototype, RegExp.prototype, Error.prototype, iterator,
  ];
  const names = new Set();
  for (const owner of owners) for (const name of Object.getOwnPropertyNames(owner)) names.add(name);
  names.delete('length');
  return names;
})();

/** Names acorn sets as fields of its objects: assigned, or keys of its object literals. */
function acornFieldNames(program) {
  const names = new Set();
  walk(program, (node) => {
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed) names.add(node.left.property.name);
    if (node.type === 'Property' && !node.computed && node.key.type === 'Identifier') names.add(node.key.name);
  });
  return names;
}

/** A name, `this`, or a chain of fields from one: what can be read again without doing anything else. */
function isPlainChain(node) {
  if (node.type === 'Identifier') return node.name !== REALM;
  if (node.type === 'ThisExpression') return true;
  return node.type === 'MemberExpression' && !node.computed && isPlainChain(node.object);
}

/** Whether `member` is read: not called, assigned, updated or deleted. */
function isRead(member, parent) {
  if (!parent) return true;
  if (parent.type === 'CallExpression' && parent.callee === member) return false;
  if (parent.type === 'AssignmentExpression' && parent.left === member) return false;
  if (parent.type === 'UpdateExpression') return false;
  if (parent.type === 'UnaryExpression' && parent.operator === 'delete') return false;
  if (parent.type === 'ForInStatement' && parent.left === member) return false;
  return true;
}

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);

function isNode(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string';
}

/**
 * A node's child nodes in source order, each once: acorn gives `export { x }`
 * one node for both names, and a shorthand property's key is its value's text.
 */
function childNodes(node) {
  const out = [];
  const add = (child) => { if (isNode(child) && !out.includes(child)) out.push(child); };
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (node.type === 'Property' && node.shorthand && key === 'key') continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const item of value) add(item); } else add(value);
  }
  return out.sort((a, b) => a.start - b.start);
}

function walk(node, visit, parent = null) {
  visit(node, parent);
  for (const child of childNodes(node)) walk(child, visit, node);
}

function where(source, node) {
  let line = 1;
  for (let i = 0; i < node.start; i++) if (source.charCodeAt(i) === 10) line++;
  return `acorn.mjs:${line}`;
}

// ── Scopes ──

const isFunction = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';

function patternNames(pattern, out) {
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier': out.push(pattern); break;
    case 'ObjectPattern': for (const p of pattern.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const e of pattern.elements) patternNames(e, out); break;
    case 'RestElement': patternNames(pattern.argument, out); break;
    case 'AssignmentPattern': patternNames(pattern.left, out); break;
    default: break;
  }
  return out;
}

/**
 * Each identifier reference's declaration (an Identifier node), or null when
 * it is a global. var and function declarations belong to their function (or
 * the module), let, const and class to their block, parameters and
 * `arguments` to their function, a catch parameter to its clause.
 */
function resolveReferences(program) {
  const scopes = new Map();
  const scopeOf = (node, parent, kind) => {
    const scope = { parent, kind, names: new Map() };
    scopes.set(node, scope);
    return scope;
  };
  const declare = (scope, id) => { if (!scope.names.has(id.name)) scope.names.set(id.name, id); };
  const functionScope = (scope) => { let s = scope; while (s.kind !== 'function') s = s.parent; return s; };
  const references = new Map();
  const declarations = new Set();

  // Declarations, into the scope each belongs to.
  const declareIn = (node, scope) => {
    if (isFunction(node)) {
      if (node.type === 'FunctionDeclaration') { declare(functionScope(scope), node.id); declarations.add(node.id); }
      const inner = scopeOf(node, scope, 'function');
      if (node.type === 'FunctionExpression' && node.id) { declare(inner, node.id); declarations.add(node.id); }
      for (const param of node.params) {
        for (const id of patternNames(param, [])) { declare(inner, id); declarations.add(id); }
        declareIn(param, inner);
      }
      if (node.type !== 'ArrowFunctionExpression') inner.names.set('arguments', null);
      const body = node.body.type === 'BlockStatement' ? node.body : null;
      if (body) { scopes.set(body, inner); for (const child of childNodes(body)) declareIn(child, inner); } else declareIn(node.body, inner);
      return;
    }
    let inner = scope;
    if (node.type === 'BlockStatement' || node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement' || node.type === 'SwitchStatement') {
      inner = scopeOf(node, scope, 'block');
    } else if (node.type === 'CatchClause') {
      inner = scopeOf(node, scope, 'block');
      for (const id of patternNames(node.param, [])) { declare(inner, id); declarations.add(id); }
    }
    if (node.type === 'VariableDeclaration') {
      const target = node.kind === 'var' ? functionScope(inner) : inner;
      for (const d of node.declarations) for (const id of patternNames(d.id, [])) { declare(target, id); declarations.add(id); }
    } else if (node.type === 'ClassDeclaration') {
      declare(inner, node.id); declarations.add(node.id);
    } else if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') {
      declare(inner, node.local); declarations.add(node.local);
    }
    for (const child of childNodes(node)) declareIn(child, inner);
  };
  const root = scopeOf(program, null, 'function');
  for (const child of childNodes(program)) declareIn(child, root);

  // References, resolved from the innermost scope out.
  const visit = (node, parent, scope) => {
    const own = scopes.get(node);
    const inner = own && own !== scope ? own : scope;
    if (node.type === 'Identifier' && !declarations.has(node) && isReference(node, parent)) {
      let found = null;
      for (let s = inner; s; s = s.parent) {
        if (s.names.has(node.name)) { found = s.names.get(node.name) ?? 'arguments'; break; }
      }
      references.set(node, found);
    }
    for (const child of childNodes(node)) visit(child, node, inner);
  };
  visit(program, null, root);
  return references;
}

function isReference(id, parent) {
  if (!parent) return true;
  switch (parent.type) {
    case 'MemberExpression': return parent.object === id || parent.computed;
    case 'Property': case 'MethodDefinition': case 'PropertyDefinition': return parent.value === id || parent.computed;
    case 'LabeledStatement': case 'BreakStatement': case 'ContinueStatement': return false;
    case 'ExportSpecifier': return parent.local === id;
    case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': return false;
    case 'MetaProperty': return false;
    default: return true;
  }
}

// ── The rewrite ──

/**
 * acorn's module source as the interpreter bundles it, importing parser-realm
 * from `realmSpecifier`. Throws on anything it cannot make safe.
 */
export function primordialAcorn(source, realmSpecifier) {
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const references = resolveReferences(program);
  const refuse = (node, what) => { throw new Error(`[acorn-primordials] ${where(source, node)}: ${what}`); };
  for (const id of references.keys()) if (id.name === REALM) refuse(id, `acorn names ${REALM}, the parser realm's namespace`);

  const rewrites = new Map();
  // Expressions parser-realm checks inherit nothing of the realm's, however they are rewritten.
  const checkedOwned = new Set();
  const emit = (node) => {
    const rewrite = rewrites.get(node);
    const text = rewrite ? rewrite() : spliced(node);
    return checkedOwned.has(node) ? `${REALM}.owned(${text})` : text;
  };
  const spliced = (node) => {
    let out = '';
    let at = node.start;
    for (const child of childNodes(node)) {
      out += source.slice(at, child.start) + emit(child);
      at = child.end;
    }
    return out + source.slice(at, node.end);
  };
  const args = (list) => list.map((a) => (a.type === 'SpreadElement' ? refuse(a, 'a spread argument') : emit(a)));

  // Module-level bindings: acorn's constructors, its regexp literals, and functions returning regexps.
  const moduleBindings = new Map();
  for (const statement of program.body) {
    if (statement.type === 'VariableDeclaration') for (const d of statement.declarations) if (d.id.type === 'Identifier') moduleBindings.set(d.id, { statement, init: d.init });
    if (statement.type === 'FunctionDeclaration') moduleBindings.set(statement.id, { statement, init: statement });
  }
  const bindingOf = (id) => {
    const decl = references.get(id);
    return decl && decl !== 'arguments' ? moduleBindings.get(decl) ?? null : null;
  };
  const acornFields = acornFieldNames(program);
  // One of parser-realm's records: named (`Object.prototype`), or a module binding that holds it (`ref`).
  const recordExpression = (n) => {
    if (!n || n.type !== 'MemberExpression' || n.computed || n.object.type !== 'Identifier' || references.get(n.object) !== null) return null;
    const members = GLOBAL_MEMBERS[n.object.name];
    const capture = members && members[n.property.name];
    return capture && RECORDS[capture] ? capture : null;
  };
  const recordOf = (n) => {
    const binding = n.type === 'Identifier' ? bindingOf(n) : null;
    return recordExpression(n) ?? recordExpression(binding && binding.init);
  };
  const parents = new Map();
  walk(program, (node, parent) => { parents.set(node, parent); });
  const declaratorOf = (id) => { const d = parents.get(id); return d && d.type === 'VariableDeclarator' && d.id === id ? d : null; };
  const assigned = new Set();
  walk(program, (node) => {
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') assigned.add(references.get(node.left));
    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') assigned.add(references.get(node.argument));
  });

  // What holds one of the realm's built-ins: the global itself, a member of one parser-realm captures,
  // and a variable whose value is one of those (or another such variable).
  const isGlobalCapture = (n) => {
    if (n.type === 'Identifier') return references.get(n) === null && GLOBALS.has(n.name);
    return n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && references.get(n.object) === null
      && Boolean(GLOBAL_MEMBERS[n.object.name]) && !recordExpression(n);
  };
  const captureAliases = new Set();
  const capturing = (init) => init && (isGlobalCapture(init) || (init.type === 'Identifier' && captureAliases.has(references.get(init)))
    || (init.type === 'MemberExpression' && !init.computed && recordOf(init.object) !== null)
    || (init.type === 'LogicalExpression' && init.operator === '||' && capturing(init.left)));
  for (let size = -1; size !== captureAliases.size;) {
    size = captureAliases.size;
    walk(program, (node) => { if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && capturing(node.init)) captureAliases.add(node.id); });
  }
  for (const id of captureAliases) if (assigned.has(id)) refuse(id, `${id.name}, which holds a built-in, is assigned`);
  /** Where a built-in, or what holds one, may be: called, constructed, tested with typeof, held by a variable, or the function `.call` calls. */
  /** Whether `n`'s value is only tested for truth: an if, loop or conditional test, `!`'s operand, or a logical operand tested so. */
  const isTested = (n) => {
    const parent = parents.get(n);
    if ((parent.type === 'IfStatement' || parent.type === 'WhileStatement' || parent.type === 'DoWhileStatement'
      || parent.type === 'ConditionalExpression' || parent.type === 'ForStatement') && parent.test === n) return true;
    if (parent.type === 'UnaryExpression' && parent.operator === '!') return true;
    return parent.type === 'LogicalExpression' && isTested(parent);
  };
  const holdsCaptureSafely = (n) => {
    const parent = parents.get(n);
    if ((parent.type === 'CallExpression' || parent.type === 'NewExpression') && parent.callee === n) return true;
    if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return true;
    if (isTested(n)) return true;
    if (parent.type === 'VariableDeclarator' && parent.init === n) return true;
    if (parent.type === 'LogicalExpression' && parent.left === n && parents.get(parent).type === 'VariableDeclarator') return true;
    if (parent.type === 'MemberExpression' && parent.object === n && !parent.computed && parent.property.name === 'call') {
      const call = parents.get(parent);
      return call.type === 'CallExpression' && call.callee === parent;
    }
    return false;
  };

  /** The declaration of the function a binding holds: its own, or (following aliases) another binding's. */
  const functionOf = (decl, seen = new Set()) => {
    if (!decl || decl === 'arguments' || seen.has(decl)) return null;
    seen.add(decl);
    const binding = moduleBindings.get(decl);
    const declarator = binding ? null : declaratorOf(decl);
    const init = binding ? binding.init : declarator && declarator.init;
    if (!init) return null;
    if (init.type === 'FunctionExpression' || init.type === 'FunctionDeclaration') return decl;
    return init.type === 'Identifier' ? functionOf(references.get(init), seen) : null;
  };
  // acorn's own constructors: variables whose value is a function literal, never assigned.
  const isConstructorBinding = (decl) => {
    const binding = decl && moduleBindings.get(decl);
    return Boolean(binding && binding.init && (binding.init.type === 'FunctionExpression' || binding.init.type === 'FunctionDeclaration') && !assigned.has(decl));
  };
  const constructors = new Set();
  const realmInstances = new Set();
  walk(program, (node, parent) => {
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && references.get(node.callee) !== null) {
      const decl = references.get(node.callee);
      if (!isConstructorBinding(decl)) refuse(node, `new ${node.callee.name}, which is not a constructor of acorn's own`);
      constructors.add(decl);
    }
    if (node.type === 'NewExpression' && node.callee.type !== 'Identifier' && node.callee.type !== 'ThisExpression') {
      refuse(node, 'new of an expression, which may be any constructor');
    }
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && bindingOf(node.object)) {
      const binding = bindingOf(node.object);
      const isFunctionBinding = binding.init && isFunction(binding.init);
      const written = parent && parent.type === 'AssignmentExpression' && parent.left === node;
      if (isFunctionBinding && ((!node.computed && node.property.name === 'prototype') || written)) {
        if (!isConstructorBinding(references.get(node.object))) refuse(node, `${node.object.name}, a function given fields, is assigned`);
        constructors.add(references.get(node.object));
      }
    }
    // An error of the realm's: thrown at once, or held by a local only fields are set on before it is thrown.
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && references.get(node.callee) === null
      && REALM_CONSTRUCTORS.has(node.callee.name)) {
      if (parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier') realmInstances.add(parent.id);
      else if (parent.type !== 'ThrowStatement') refuse(node, `an error of the realm's ${node.callee.name} used other than thrown`);
    }
  });
  const fieldSets = new Set();
  walk(program, (node) => {
    if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'MemberExpression' && !node.left.computed) fieldSets.add(node.left.object);
  });
  walk(program, (node, parent) => {
    if (node.type !== 'Identifier' || !realmInstances.has(references.get(node)) || realmInstances.has(node)) return;
    if (!(parent.type === 'ThrowStatement' || fieldSets.has(node))) refuse(node, `an error of the realm's, ${node.name}, used other than to set its fields and throw it`);
  });

  // A caught exception may be the realm's: only compared and rethrown.
  const caught = new Set();
  walk(program, (node) => { if (node.type === 'CatchClause' && node.param) for (const id of patternNames(node.param, [])) caught.add(id); });
  /** A list acorn made: a variable whose value is a list literal, never assigned. */
  const isOwnList = (n) => {
    if (n.type !== 'Identifier') return false;
    const decl = references.get(n);
    const declarator = decl && decl !== 'arguments' ? declaratorOf(decl) : null;
    return Boolean(declarator && declarator.init && declarator.init.type === 'ArrayExpression' && !assigned.has(decl));
  };

  walk(program, (node, parent) => {
    switch (node.type) {
      case 'Identifier': {
        if (!references.has(node)) return;
        const decl = references.get(node);
        if (decl === 'arguments') {
          // Its length, an own property; an element, through parser-realm, which reads only one it has.
          if (parent.type === 'MemberExpression' && parent.object === node && isRead(parent, parents.get(parent))) {
            if (!parent.computed && parent.property.name === 'length') return;
            if (parent.computed && !(parent.property.type === 'Literal' && typeof parent.property.value !== 'number')) {
              rewrites.set(parent, () => `${REALM}.argument(arguments, ${emit(parent.property)})`);
              return;
            }
          }
          refuse(node, 'arguments used other than for its length or an element');
        }
        if (decl !== null) {
          if (captureAliases.has(decl) && !captureAliases.has(node) && !holdsCaptureSafely(node) && !(parent.type === 'MemberExpression' && recordOf(parent.object) !== null)) {
            refuse(node, `${node.name}, which holds a built-in, used other than called or tested`);
          }
          if (caught.has(decl) && !caught.has(node) && parent.type !== 'ThrowStatement'
            && !(parent.type === 'BinaryExpression' && (parent.operator === '===' || parent.operator === '!=='))) {
            refuse(node, `the caught ${node.name}, which may be the realm's, used other than compared or rethrown`);
          }
          return;
        }
        if (FIXED.has(node.name)) return;
        const members = GLOBAL_MEMBERS[node.name];
        if (members && parent.type === 'MemberExpression' && parent.object === node && !parent.computed) {
          const capture = members[parent.property.name];
          if (!capture) refuse(node, `acorn reads ${node.name}.${parent.property.name}, which parser-realm has no capture of`);
          const asKey = SYMBOLS.has(capture) && parents.get(parent).type === 'MemberExpression' && parents.get(parent).computed && parents.get(parent).property === parent;
          if (!RECORDS[capture] && !asKey && !holdsCaptureSafely(parent)) refuse(node, `${node.name}.${parent.property.name}, a built-in, used other than called or tested`);
          if (RECORDS[capture] && !(parents.get(parent).type === 'VariableDeclarator' || (parents.get(parent).type === 'MemberExpression' && !parents.get(parent).computed))) {
            refuse(node, `${node.name}.${parent.property.name} used other than held or read`);
          }
          rewrites.set(parent, () => `${REALM}.${capture}`);
          return;
        }
        if (!GLOBALS.has(node.name)) refuse(node, `acorn names the global ${node.name}, which parser-realm has no capture of`);
        if (parent.type === 'MemberExpression' && parent.object === node) refuse(node, `acorn reads ${node.name}'s members, which are the realm's`);
        if (REALM_CONSTRUCTORS.has(node.name) && !(parent.type === 'NewExpression' && parent.callee === node)) {
          refuse(node, `acorn holds ${node.name} other than to construct it`);
        }
        if (!holdsCaptureSafely(node)) refuse(node, `${node.name}, a built-in, used other than called or tested`);
        if (parent.type === 'NewExpression' && parent.callee === node && node.name !== 'RegExp' && !REALM_CONSTRUCTORS.has(node.name)) {
          refuse(node, `new ${node.name}, which makes an object of the realm's`);
        }
        rewrites.set(node, () => `${REALM}.${node.name}`);
        return;
      }
      case 'ObjectExpression':
        for (const p of node.properties) {
          if (p.type !== 'Property' || p.kind !== 'init') refuse(p, 'an object literal with a spread or an accessor');
          if (!p.computed && ((p.key.type === 'Identifier' && p.key.name === '__proto__') || (p.key.type === 'Literal' && p.key.value === '__proto__'))) {
            refuse(p, 'an object literal naming its prototype');
          }
        }
        for (const p of node.properties) if (p.shorthand) rewrites.set(p, () => `${p.key.name}: ${emit(p.value)}`);
        rewrites.set(node, () => `${REALM}.own(${spliced(node)})`);
        return;
      case 'ArrayExpression':
        for (const e of node.elements) if (e === null) refuse(node, 'a list literal with a hole');
        rewrites.set(node, () => `${REALM}.list(${args(node.elements).join(', ')})`);
        return;
      case 'CallExpression': {
        const callee = node.callee;
        if (node.optional || (callee.type === 'MemberExpression' && callee.optional)) refuse(node, 'an optional call');
        if (callee.type !== 'MemberExpression' || callee.object.type === 'Super') return;
        // A global's member called is its capture (the Identifier case).
        if (callee.object.type === 'Identifier' && references.get(callee.object) === null && !callee.computed) return;
        // A method by a constant key is the method of that name; by any other key, only one of a list acorn made.
        const constant = callee.computed && callee.property.type === 'Literal' && typeof callee.property.value === 'string' ? callee.property.value : null;
        if (callee.computed && constant === null) {
          if (!isOwnList(callee.object)) refuse(node, 'a call of a method by a computed key, of something other than a list acorn made');
          return;
        }
        const name = constant ?? callee.property.name;
        if (!ROUTED_METHODS.has(name) && !acornFields.has(name)) refuse(node, `a call of ${name}, a name acorn sets nowhere`);
        if (callee.object.type === 'ThisExpression' && !callee.computed) return;
        if (ROUTED_METHODS.has(name)) {
          if (name === 'push' && node.arguments.length !== 1) refuse(node, 'a push of other than one item');
          rewrites.set(node, () => `${REALM}.${name}(${[emit(callee.object), ...args(node.arguments)].join(', ')})`);
          return;
        }
        if (BUILTIN_NAMES.has(name) && !acornFields.has(name)) refuse(node, `a call of the built-in method ${name}`);
        if (constant !== null) {
          if (!/^[A-Za-z_$][\w$]*$/.test(constant)) refuse(node, `a call of a method named ${JSON.stringify(constant)}`);
          rewrites.set(node, () => `${emit(callee.object)}.${constant}(${args(node.arguments).join(', ')})`);
        }
        return;
      }
      case 'ForInStatement':
        // Enumerating an object reaches every enumerable name its prototypes have.
        checkedOwned.add(node.right);
        return;
      case 'AssignmentExpression': {
        const left = node.left;
        if (node.operator !== '=' || left.type !== 'MemberExpression' || left.computed || left.object.type !== 'Identifier') return;
        if (!realmInstances.has(references.get(left.object))) return;
        rewrites.set(node, () => `${REALM}.define(${emit(left.object)}, ${JSON.stringify(left.property.name)}, ${emit(node.right)})`);
        return;
      }
      case 'MemberExpression': {
        // A global's member is the global's capture (above); `this` is always one of acorn's objects.
        if (node.object.type === 'Identifier' && references.get(node.object) === null) return;
        if (node.object.type === 'Identifier' && references.get(node.object) === 'arguments') return;
        // A function of acorn's inherits Function.prototype unless it is one of its constructors. (A routed
        // method called on one, `f.call(...)`, becomes parser-realm's, which reads nothing of it.)
        const routed = !node.computed && ROUTED_METHODS.has(node.property.name) && parent.type === 'CallExpression' && parent.callee === node;
        if (node.object.type === 'Identifier' && !routed) {
          const fn = functionOf(references.get(node.object));
          if (fn && !constructors.has(fn)) refuse(node, `a member of ${node.object.name}, a function that inherits Function.prototype`);
        }
        if (node.object.type === 'Identifier' && captureAliases.has(references.get(node.object)) && (node.computed || recordOf(node.object) === null)) {
          if (!(node.property.name === 'call' && !node.computed && holdsCaptureSafely(node.object))) refuse(node, `a member of ${node.object.name}, which holds a built-in`);
          return;
        }
        if (!isRead(node, parent) || node.object.type === 'ThisExpression') return;
        // A computed read may index a string: past its end, a string would look further. Where the
        // object is a name or a chain of fields (read twice, as reading them does nothing else), a
        // string goes to parser-realm and anything else is read here, where V8 caches its shape.
        if (node.computed) {
          if (isPlainChain(node.object)) {
            rewrites.set(node, () => {
              // An object rewritten into a call is not read twice.
              if (rewrites.has(node.object)) return `${REALM}.index(${emit(node.object)}, ${emit(node.property)})`;
              const object = emit(node.object);
              return `(typeof ${object} === "string" ? ${REALM}.index(${object}, ${emit(node.property)}) : ${object}[${emit(node.property)}])`;
            });
          } else {
            rewrites.set(node, () => `${REALM}.index(${emit(node.object)}, ${emit(node.property)})`);
          }
          return;
        }
        const name = node.property.name;
        const record = recordOf(node.object);
        if (record) {
          if (!RECORDS[record].has(name)) refuse(node, `acorn reads ${name} of ${record}, which parser-realm does not hold`);
          rewrites.set(node, () => `${REALM}.${record}.${name}`);
          return;
        }
        if (BUILTIN_NAMES.has(name) && !acornFields.has(name)) refuse(node, `a read of the built-in ${name}, which acorn has no field of`);
        return;
      }
      case 'Literal':
        if (node.regex) rewrites.set(node, () => `${REALM}.regexp(${source.slice(node.start, node.end)})`);
        return;
      case 'ThisExpression':
        if (parent.type === 'NewExpression' && parent.callee === node) rewrites.set(node, () => `(${REALM}.ownConstructor(this))`);
        return;
      case 'VariableDeclaration':
        if (node.kind !== 'var') refuse(node, `a ${node.kind} declaration, which the rewrite does not scope`);
        return;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        if (node.async || node.generator || node.type === 'ArrowFunctionExpression') refuse(node, 'an arrow, async or generator function');
        if (node.type === 'FunctionDeclaration' && parent.type !== 'Program' && !(parent.type === 'BlockStatement' && isFunction(parents.get(parent)))) {
          refuse(node, 'a function declared in a block, which a module scopes to the block');
        }
        return;
      case 'BinaryExpression':
        if (node.operator === 'in' || node.operator === 'instanceof') refuse(node, `\`${node.operator}\`, which consults the realm`);
        return;
      case 'TemplateLiteral': case 'TaggedTemplateExpression': case 'SpreadElement': case 'ForOfStatement': case 'ArrayPattern':
      case 'ObjectPattern': case 'RestElement': case 'AssignmentPattern':
      case 'ClassDeclaration': case 'ClassExpression': case 'YieldExpression': case 'AwaitExpression': case 'ChainExpression':
      case 'MetaProperty': case 'ImportExpression': case 'WithStatement':
        refuse(node, `${node.type}, which the rewrite has no safe form for`);
        return;
      default:
        return;
    }
  });

  // Each constructor and its prototype inherit nothing from where it is declared on.
  const hoisted = [];
  for (const id of constructors) {
    const { statement } = moduleBindings.get(id);
    const nulling = `\n${REALM}.nullPrototypes(${id.name});`;
    if (statement.type === 'FunctionDeclaration') {
      hoisted.push(nulling);
    } else {
      const previous = rewrites.get(statement);
      if (previous) refuse(statement, 'a constructor declared in a statement rewritten otherwise');
      rewrites.set(statement, () => spliced(statement) + nulling);
    }
  }

  const imports = program.body.filter((s) => s.type === 'ImportDeclaration');
  if (imports.length > 0) refuse(imports[0], 'an import of its own');
  const code = `import * as ${REALM} from ${JSON.stringify(realmSpecifier)};${hoisted.join('')}\n${spliced(program)}`;
  return { code, constructors: [...constructors].map((id) => id.name) };
}
