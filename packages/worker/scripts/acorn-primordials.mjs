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
 * Anything the rewrite does not know how to make safe (a global it has no
 * capture for, `instanceof`, a template literal, an iteration) stops the
 * build, so an acorn upgrade that reaches something new fails here rather
 * than at runtime. parserReaches() checks the output independently of the
 * rewrite: tests/unit/interpreter-primordials.mjs requires it to find none.
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

/** Globals acorn names, each parser-realm's export of the same name: called, constructed or tested with typeof, never read from. */
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

/** An object literal, or the one the rewrite gave parser-realm's `own`. */
function objectLiteral(node) {
  if (!node) return null;
  if (node.type === 'ObjectExpression') return node;
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier'
    && node.callee.object.name === REALM && node.callee.property.name === 'own') return objectLiteral(node.arguments[0]);
  return null;
}

/**
 * Names acorn gives functions: methods it assigns (or assigns from another
 * method, `pp.raiseRecoverable = pp.raise`) or defines in a literal, fields a
 * constructor sets from a parameter it is passed a function for
 * (TokContext's `override`), and its option slots (callbacks).
 */
function acornMethodNames(program) {
  const names = new Set();
  // Each module constructor's fields set from its parameters, by parameter index.
  const fieldsFromParams = new Map();
  for (const s of program.body) {
    for (const d of s.type === 'VariableDeclaration' ? s.declarations : []) {
      if (d.id.type !== 'Identifier' || !d.init || d.init.type !== 'FunctionExpression') continue;
      const fields = new Map();
      walk(d.init.body, (n) => {
        if (n.type !== 'AssignmentExpression' || n.left.type !== 'MemberExpression' || n.left.object.type !== 'ThisExpression' || n.right.type !== 'Identifier') return;
        const index = d.init.params.findIndex((param) => param.type === 'Identifier' && param.name === n.right.name);
        if (index >= 0 && !n.left.computed) fields.set(index, n.left.property.name);
      });
      fieldsFromParams.set(d.id.name, fields);
    }
  }
  walk(program, (node) => {
    if (node.type !== 'NewExpression' || node.callee.type !== 'Identifier' || !fieldsFromParams.has(node.callee.name)) return;
    const fields = fieldsFromParams.get(node.callee.name);
    node.arguments.forEach((arg, index) => { if (isFunction(arg) && fields.has(index)) names.add(fields.get(index)); });
  });
  const functionValued = (n) => isFunction(n) || (n.type === 'AssignmentExpression' && functionValued(n.right))
    || (n.type === 'MemberExpression' && !n.computed && names.has(n.property.name));
  for (let size = -1; size !== names.size;) {
    size = names.size;
    walk(program, (node) => {
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed && functionValued(node.right)) {
        names.add(node.left.property.name);
      }
      if (node.type === 'Property' && !node.computed && node.key.type === 'Identifier' && isFunction(node.value)) names.add(node.key.name);
      const options = node.type === 'VariableDeclarator' && node.id.name === 'defaultOptions' && objectLiteral(node.init);
      if (options) for (const p of options.properties) if (p.key && p.key.type === 'Identifier') names.add(p.key.name);
    });
  }
  return names;
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
  const emit = (node) => {
    const rewrite = rewrites.get(node);
    return rewrite ? rewrite() : spliced(node);
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
  const constructors = new Set();
  const realmInstances = new Set();
  walk(program, (node, parent) => {
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && bindingOf(node.callee)) constructors.add(references.get(node.callee));
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && bindingOf(node.object)) {
      const binding = bindingOf(node.object);
      const isFunctionBinding = binding.init && isFunction(binding.init);
      const written = parent && parent.type === 'AssignmentExpression' && parent.left === node;
      if (isFunctionBinding && ((!node.computed && node.property.name === 'prototype') || written)) constructors.add(references.get(node.object));
    }
    if (node.type === 'VariableDeclarator' && node.init && node.init.type === 'NewExpression' && node.init.callee.type === 'Identifier'
      && references.get(node.init.callee) === null && REALM_CONSTRUCTORS.has(node.init.callee.name)) {
      realmInstances.add(node.id);
    }
  });

  walk(program, (node, parent) => {
    switch (node.type) {
      case 'Identifier': {
        if (!references.has(node) || references.get(node) !== null || FIXED.has(node.name)) return;
        const members = GLOBAL_MEMBERS[node.name];
        if (members && parent.type === 'MemberExpression' && parent.object === node && !parent.computed) {
          const capture = members[parent.property.name];
          if (!capture) refuse(node, `acorn reads ${node.name}.${parent.property.name}, which parser-realm has no capture of`);
          rewrites.set(parent, () => `${REALM}.${capture}`);
          return;
        }
        if (!GLOBALS.has(node.name)) refuse(node, `acorn names the global ${node.name}, which parser-realm has no capture of`);
        if (parent.type === 'MemberExpression' && parent.object === node) refuse(node, `acorn reads ${node.name}'s members, which are the realm's`);
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
        if (callee.type === 'Identifier' && callee.name === 'RegExp' && references.get(callee) === null) {
          rewrites.set(node, () => `${REALM}.regexp(${spliced(node)})`);
          return;
        }
        if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type === 'ThisExpression' || callee.object.type === 'Super') return;
        const name = callee.property.name;
        if (!ROUTED_METHODS.has(name)) return;
        if (name === 'push' && node.arguments.length !== 1) refuse(node, 'a push of other than one item');
        rewrites.set(node, () => `${REALM}.${name}(${[emit(callee.object), ...args(node.arguments)].join(', ')})`);
        return;
      }
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
        if (!isRead(node, parent) || node.object.type === 'ThisExpression') return;
        // A computed read may index a string: past its end, a string would look further. Where the
        // object is a name or a chain of fields (read twice, as reading them does nothing else), a
        // string goes to parser-realm and anything else is read here, where V8 caches its shape.
        if (node.computed) {
          if (isPlainChain(node.object)) {
            rewrites.set(node, () => {
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
      case 'NewExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === 'RegExp' && references.get(node.callee) === null) {
          rewrites.set(node, () => `${REALM}.regexp(${spliced(node)})`);
        }
        return;
      case 'BinaryExpression':
        if (node.operator === 'in' || node.operator === 'instanceof') refuse(node, `\`${node.operator}\`, which consults the realm`);
        return;
      case 'TemplateLiteral': case 'TaggedTemplateExpression': case 'SpreadElement': case 'ForOfStatement': case 'ArrayPattern':
      case 'ClassDeclaration': case 'ClassExpression': case 'YieldExpression': case 'AwaitExpression': case 'ChainExpression':
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

// ── The check ──

/**
 * What of the realm the rewritten parser `code` can still reach, one line
 * each (none, for the parser the interpreter bundles): a global other than
 * parser-realm's namespace; a built-in method called or read by name, on
 * any receiver but `this`; a method no code of acorn's defines; a computed
 * read, or a read of a name a regexp answers, not made through parser-realm;
 * a member of one of parser-realm's exports other than what a record holds;
 * a list or object literal that inherits; a constructor whose prototype
 * inherits; a field set on an error made by the realm's constructor; syntax
 * that iterates or consults the realm.
 */
export function parserReaches(code) {
  const program = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const references = resolveReferences(program);
  const methods = acornMethodNames(program);
  const reaches = [];
  const at = (node, what) => reaches.push(`${where(code, node)}: ${what}`);
  const isRealm = (node) => node.type === 'Identifier' && node.name === REALM && references.get(node) !== null;
  /** `typeof o === "string" ? $$.index(o, k) : o[k]`, the rewrite's guarded computed read, for `o[k]` its alternate. */
  const guarded = (member, conditional) => {
    if (!conditional || conditional.type !== 'ConditionalExpression' || conditional.alternate !== member || !isPlainChain(member.object)) return false;
    const text = (n) => code.slice(n.start, n.end);
    const test = conditional.test, consequent = conditional.consequent;
    return test.type === 'BinaryExpression' && test.operator === '===' && test.left.type === 'UnaryExpression' && test.left.operator === 'typeof'
      && text(test.left.argument) === text(member.object) && test.right.type === 'Literal' && test.right.value === 'string'
      && isRealmCall(consequent, 'index') && text(consequent.arguments[0]) === text(member.object) && text(consequent.arguments[1]) === text(member.property);
  };
  const isRealmCall = (node, name) => node && node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
    && isRealm(node.callee.object) && !node.callee.computed && node.callee.property.name === name;

  // Module bindings: constructors and their nulling, realm instances.
  const declarations = new Map();
  for (const s of program.body) {
    if (s.type === 'VariableDeclaration') for (const d of s.declarations) declarations.set(d.id, { statement: s, init: d.init });
    if (s.type === 'FunctionDeclaration') declarations.set(s.id, { statement: s, init: s });
  }
  const initializers = new Map();
  walk(program, (n) => { if (n.type === 'VariableDeclarator') initializers.set(n.id, n.init); });
  const acornFields = acornFieldNames(program);

  const nulled = new Set();
  walk(program, (node) => {
    if (isRealmCall(node, 'nullPrototypes') && node.arguments[0] && node.arguments[0].type === 'Identifier') nulled.add(node.arguments[0].name);
  });
  const isNulling = (statement, name) => statement && statement.type === 'ExpressionStatement' && isRealmCall(statement.expression, 'nullPrototypes')
    && statement.expression.arguments[0].type === 'Identifier' && statement.expression.arguments[0].name === name;
  /** Whether `id`'s constructor is nulled where it is declared: right after its statement, or (hoisted) before any statement. */
  const nullingFollows = (id) => {
    const decl = references.get(id);
    const entry = decl && declarations.get(decl);
    if (!entry) return false;
    if (entry.statement.type === 'FunctionDeclaration') {
      for (let i = 0; i < program.body.length; i++) {
        const statement = program.body[i];
        if (statement.type === 'ImportDeclaration') continue;
        if (isNulling(statement, id.name)) return true;
        if (!isNulling(statement, statement.expression && statement.expression.arguments && statement.expression.arguments[0] && statement.expression.arguments[0].name)) return false;
      }
      return false;
    }
    return isNulling(program.body[program.body.indexOf(entry.statement) + 1], id.name);
  };

  walk(program, (node, parent) => {
    switch (node.type) {
      case 'Identifier':
        if (references.has(node) && references.get(node) === null && !FIXED.has(node.name)) at(node, `the global ${node.name}`);
        return;
      case 'ArrayExpression':
        at(node, 'a list literal');
        return;
      case 'ObjectExpression':
        if (!(parent && isRealmCall(parent, 'own') && parent.arguments.length === 1 && parent.arguments[0] === node)) at(node, 'an object literal that inherits');
        return;
      case 'Literal':
        if (node.regex && !(isRealmCall(parent, 'regexp') && parent.arguments[0] === node)) at(node, 'a regexp that inherits RegExp.prototype');
        return;
      case 'NewExpression': {
        const callee = node.callee;
        if (callee.type === 'ThisExpression') return;
        if (callee.type === 'MemberExpression' && isRealm(callee.object) && REALM_CONSTRUCTORS.has(callee.property.name)) return;
        if (callee.type === 'MemberExpression' && isRealm(callee.object) && callee.property.name === 'RegExp') {
          if (!(isRealmCall(parent, 'regexp') && parent.arguments[0] === node)) at(node, 'a regexp that inherits RegExp.prototype');
          return;
        }
        if (callee.type === 'Identifier' && nulled.has(callee.name) && nullingFollows(callee)) return;
        at(node, `new of a constructor whose prototype may inherit (${code.slice(callee.start, callee.end)})`);
        return;
      }
      case 'CallExpression': {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (isRealm(callee.object)) {
          if (callee.property.name === 'RegExp' && !(isRealmCall(parent, 'regexp') && parent.arguments[0] === node)) at(node, 'a regexp that inherits RegExp.prototype');
          return;
        }
        const name = callee.property.name;
        const own = callee.object.type === 'ThisExpression';
        if (BUILTIN_NAMES.has(name) && !(own && methods.has(name))) at(node, `a call of the built-in method ${name}`);
        else if (!methods.has(name)) at(node, `a call of ${name}, which no code of acorn's defines`);
        return;
      }
      case 'MemberExpression': {
        const object = node.object;
        if (object.type === 'MemberExpression' && isRealm(object.object)) {
          // A member of one of parser-realm's exports: only a record's, and only what it holds.
          const record = !object.computed && RECORDS[object.property.name];
          if (!record || node.computed || !record.has(node.property.name)) at(node, `a member of ${code.slice(object.start, object.end)}, which is the realm's`);
        } else if (isRead(node, parent) && object.type !== 'ThisExpression' && !isRealm(object)) {
          const name = node.computed ? null : node.property.name;
          if (name === null) {
            if (!guarded(node, parent)) at(node, 'a computed read, which may index a string past its end');
          } else if (BUILTIN_NAMES.has(name) && !acornFields.has(name)) {
            at(node, `a read of the built-in ${name}`);
          }
        }
        if (!node.computed && object.type === 'Identifier' && (node.property.name === 'prototype' || (parent && parent.type === 'AssignmentExpression' && parent.left === node))) {
          const decl = references.get(node.object);
          const entry = decl && declarations.get(decl);
          if (entry && entry.init && isFunction(entry.init) && !nullingFollows(node.object)) at(node, `a constructor whose prototype inherits (${node.object.name})`);
        }
        return;
      }
      case 'AssignmentExpression': {
        const left = node.left;
        if (left.type !== 'MemberExpression' || left.object.type !== 'Identifier') return;
        const decl = references.get(left.object);
        if (!decl || decl === 'arguments') return;
        // A local initialized by the realm's constructor (an error): fields set on it would run inherited setters.
        const init = initializers.get(decl);
        if (init && init.type === 'NewExpression' && init.callee.type === 'MemberExpression' && isRealm(init.callee.object)) {
          at(node, `a field set on an instance of the realm's ${init.callee.property.name}`);
        }
        return;
      }
      case 'BinaryExpression':
        if (node.operator === 'in' || node.operator === 'instanceof') at(node, `\`${node.operator}\``);
        return;
      case 'TemplateLiteral': case 'TaggedTemplateExpression': case 'SpreadElement': case 'ForOfStatement': case 'ArrayPattern':
      case 'ClassDeclaration': case 'ClassExpression': case 'YieldExpression': case 'AwaitExpression': case 'ChainExpression':
        if (node.type === 'SpreadElement' && parent && parent.type === 'CallExpression') { at(node, 'a spread argument'); return; }
        at(node, node.type);
        return;
      default:
        return;
    }
  });
  return reaches;
}
