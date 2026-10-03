/**
 * parser-audit.mjs — what of the realm the parser the interpreter bundles can
 * reach, checked with nothing of the rewrite that made it.
 *
 * acorn-primordials.mjs rewrites acorn to reach the realm only through
 * core src/interpreter/parser-realm.ts. A check sharing its scope analysis
 * and its tables would share its blind spots, so this one has its own,
 * deliberately simple: scopes are functions and catch clauses (a `let`,
 * `const` or class is refused rather than scoped), and a form is allowed
 * only where this proves it reaches nothing a program can replace. It
 * refuses what it cannot prove:
 *
 *   - any syntax but a fixed set: no destructuring, rest, spread, default
 *     parameters, templates, classes, arrows, generators, async, `in`,
 *     `instanceof`, `with`, optional chains;
 *   - any free name but parser-realm's namespace and undefined, NaN, Infinity;
 *   - parser-realm's exports anywhere but where their kind allows: a function
 *     called, tested, or held by a variable that is itself only called,
 *     tested, or handed to parser-realm's `call`; a record's member read; a
 *     symbol as a computed key; RegExp also constructed; an error constructor
 *     only constructed, its error only thrown or given fields by `define`;
 *     nothing read of any of them, or of what holds them, but a record's member;
 *   - `new` but of RegExp, the errors, `ownConstructor(this)`, or a variable
 *     whose value is a function literal made to inherit nothing by
 *     `nullPrototypes` where it is declared, which is the only thing
 *     `nullPrototypes` may be given; a field of such a function only once so made;
 *   - an object literal but as `own(...)`'s argument, a list literal at all,
 *     a regexp literal but as `regexp(...)`'s argument;
 *   - a read or call of a name a built-in prototype has, but a field the
 *     parser sets itself (a call, a field it sets to a function);
 *   - a computed read but `typeof o === "string" ? index(o, k) : o[k]`, a
 *     call by a computed key but of a variable whose value is a list literal;
 *   - for-in but over `owned(...)`; `arguments` but read for its `length`
 *     or as `argument(arguments, k)`; a caught exception but compared or
 *     rethrown;
 *   - a call of a method by a name the parser sets nowhere; a member of a
 *     function (or what holds one) not made to inherit nothing; a function
 *     declared anywhere but at the top of the module or of a function.
 *
 * One thing it takes as given, which no syntax shows: the value a field is
 * read from or set on, an operand of `+` or a comparison, and `this`, is a
 * primitive or an object the parser made, which inherits nothing of the
 * realm's. tests/unit/interpreter-parser-realm.mjs checks that by running
 * the parser in a realm that logs every built-in it reaches.
 */

import { parse } from 'acorn';

/** The namespace the parser imports parser-realm as. */
const REALM = '$$';
const FIXED = new Set(['undefined', 'NaN', 'Infinity']);

/** Names a built-in prototype has: what a value of the realm's answers, read or called, from its prototype. */
function prototypeNames() {
  const iterator = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  const prototypes = [
    Object.prototype, Function.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype,
    BigInt.prototype, Symbol.prototype, RegExp.prototype, Error.prototype, iterator,
  ];
  const names = new Set();
  for (const prototype of prototypes) for (const name of Object.getOwnPropertyNames(prototype)) names.add(name);
  names.delete('length');
  return names;
}

/** What each of parser-realm's exports is, from the module itself. */
function exportKinds(realm) {
  const kinds = new Map();
  for (const name of Object.keys(realm)) {
    const value = realm[name];
    if (typeof value === 'function' && (value === Error || Error.prototype.isPrototypeOf(value.prototype))) {
      kinds.set(name, { kind: 'error' });
    } else if (typeof value === 'function') {
      // A function whose regexps inherit nothing of RegExp.prototype may be constructed.
      let constructs = false;
      try {
        const made = Reflect.construct(value, ['a']);
        constructs = made instanceof Object === false && Object.getPrototypeOf(made) !== RegExp.prototype && typeof made.exec === 'function';
      } catch {
        constructs = false;
      }
      kinds.set(name, { kind: constructs ? 'constructor' : 'function' });
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const members = new Set(Object.keys(value).filter((member) => typeof value[member] === 'function'));
      kinds.set(name, { kind: 'record', members });
    } else {
      kinds.set(name, { kind: typeof value === 'symbol' ? 'symbol' : 'value' });
    }
  }
  return kinds;
}

const ALLOWED = new Set([
  'Program', 'ImportDeclaration', 'ImportNamespaceSpecifier', 'ExportNamedDeclaration', 'ExportSpecifier',
  'VariableDeclaration', 'VariableDeclarator', 'FunctionDeclaration', 'FunctionExpression',
  'ReturnStatement', 'IfStatement', 'ForStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement',
  'BreakStatement', 'ContinueStatement', 'LabeledStatement', 'BlockStatement', 'ExpressionStatement', 'EmptyStatement',
  'DebuggerStatement', 'ThrowStatement', 'TryStatement', 'CatchClause', 'SwitchStatement', 'SwitchCase',
  'Identifier', 'Literal', 'ThisExpression', 'ObjectExpression', 'Property', 'UnaryExpression', 'UpdateExpression',
  'BinaryExpression', 'AssignmentExpression', 'LogicalExpression', 'MemberExpression', 'ConditionalExpression',
  'CallExpression', 'NewExpression', 'SequenceExpression',
]);

/** Each child node of `node`, once, in source order. */
function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const value = node[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item && typeof item.type === 'string' && !out.includes(item)) out.push(item);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Whether the Identifier `id` under `parent` names a binding (rather than a field, a label or an export's name). */
function isReference(id, parent) {
  switch (parent.type) {
    case 'MemberExpression': return parent.object === id || parent.computed;
    case 'Property': return parent.value === id || parent.computed;
    case 'LabeledStatement': case 'BreakStatement': case 'ContinueStatement': return false;
    case 'ExportSpecifier': return parent.local === id;
    case 'ImportNamespaceSpecifier': return false;
    case 'VariableDeclarator': return parent.init === id;
    case 'FunctionDeclaration': case 'FunctionExpression': return parent.body === id;
    case 'CatchClause': return false;
    default: return true;
  }
}

/** The audit's findings for the parser module `code` (none, for the parser the interpreter bundles). */
export function auditParser(code, realm) {
  const program = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const kinds = exportKinds(realm);
  const builtins = prototypeNames();
  const findings = [];
  const line = (node) => code.slice(0, node.start).split('\n').length;
  const find = (node, what) => findings.push(`line ${line(node)}: ${what}`);
  const parents = new Map();
  const visitAll = (node, parent, visit) => {
    parents.set(node, parent);
    visit(node, parent);
    for (const child of children(node)) visitAll(child, node, visit);
  };
  visitAll(program, null, () => {});

  // ── Bindings: functions and catch clauses scope; var and function declarations hoist to their function ──
  const scopes = new Map();
  const bindings = new Map();
  const declare = (scope, id, kind, extra = {}) => {
    let binding = scope.names.get(id.name);
    if (!binding) {
      binding = { name: id.name, kind, scope, values: [], refs: [], assigned: false, ...extra };
      scope.names.set(id.name, binding);
    }
    bindings.set(id, binding);
    return binding;
  };
  const hoist = (body, scope) => {
    const visit = (node) => {
      if (node.type === 'FunctionDeclaration') { declare(scope, node.id, 'function').values.push(node); return; }
      if (node.type === 'FunctionExpression') return;
      if (node.type === 'VariableDeclaration') {
        if (node.kind !== 'var') find(node, `a ${node.kind} declaration, which this does not scope`);
        for (const d of node.declarations) {
          if (d.id.type !== 'Identifier') { find(d.id, `a ${d.id.type}, which this does not allow`); continue; }
          const binding = declare(scope, d.id, 'var');
          binding.values.push(d.init ?? null);
        }
      }
      for (const child of children(node)) visit(child);
    };
    for (const child of children(body)) visit(child);
  };
  const root = { parent: null, kind: 'module', names: new Map() };
  scopes.set(program, root);
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      const spec = statement.specifiers;
      if (statement !== program.body[0] || spec.length !== 1 || spec[0].type !== 'ImportNamespaceSpecifier' || spec[0].local.name !== REALM) {
        find(statement, `an import other than parser-realm's namespace, ${REALM}, first`);
      } else {
        declare(root, spec[0].local, 'realm');
      }
    }
  }
  hoist(program, root);
  const enter = (node, parent) => {
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
      if (node.async || node.generator) find(node, 'an async or generator function');
      const scope = { parent: scopeOf(parent), kind: 'function', names: new Map() };
      scopes.set(node, scope);
      if (node.type === 'FunctionExpression' && node.id) declare(scope, node.id, 'function').values.push(node);
      for (const param of node.params) {
        if (param.type !== 'Identifier') find(param, `a ${param.type} parameter, which this does not allow`);
        else declare(scope, param, 'param');
      }
      scope.names.set('arguments', { name: 'arguments', kind: 'arguments', scope, values: [], refs: [], assigned: false });
      hoist(node.body, scope);
    } else if (node.type === 'CatchClause') {
      const scope = { parent: scopeOf(parent), kind: 'catch', names: new Map() };
      scopes.set(node, scope);
      if (node.param && node.param.type !== 'Identifier') find(node.param, `a ${node.param.type} caught, which this does not allow`);
      else if (node.param) declare(scope, node.param, 'caught');
    }
  };
  const scopeOf = (node) => {
    for (let n = node; n; n = parents.get(n)) if (scopes.has(n)) return scopes.get(n);
    return root;
  };
  visitAll(program, null, (node, parent) => { if (node !== program) enter(node, parent); });
  const resolve = (id) => {
    for (let scope = scopeOf(parents.get(id)); scope; scope = scope.parent) {
      if (scope.names.has(id.name)) return scope.names.get(id.name);
    }
    return null;
  };
  const references = new Map();
  visitAll(program, null, (node, parent) => {
    if (node.type !== 'Identifier' || !parent || bindings.has(node) || !isReference(node, parent)) return;
    const binding = resolve(node);
    references.set(node, binding);
    if (binding) binding.refs.push(node);
  });
  for (const [id, binding] of references) {
    if (!binding) continue;
    const parent = parents.get(id);
    if ((parent.type === 'AssignmentExpression' && parent.left === id) || parent.type === 'UpdateExpression') {
      binding.assigned = true;
      if (parent.type === 'AssignmentExpression') binding.values.push(parent.right);
    }
  }
  const bindingOf = (n) => (n && n.type === 'Identifier' ? references.get(n) ?? null : null);
  /** The binding of the function `binding` holds: itself, if its value is a function literal, or (following aliases) another's. */
  const functionBinding = (binding, seen = new Set()) => {
    if (!binding || seen.has(binding)) return null;
    seen.add(binding);
    for (const value of binding.values) {
      if (value && (value.type === 'FunctionExpression' || value.type === 'FunctionDeclaration')) return binding;
      if (value && value.type === 'Identifier') { const held = functionBinding(bindingOf(value), seen); if (held) return held; }
    }
    return null;
  };

  // ── What parser-realm's exports, and what holds them, are ──
  const isRealm = (n) => n && n.type === 'Identifier' && bindingOf(n)?.kind === 'realm';
  const exportOf = (n) => (n && n.type === 'MemberExpression' && !n.computed && isRealm(n.object) ? n.property.name : null);
  const isRealmCall = (n, name) => n && n.type === 'CallExpression' && exportOf(n.callee) === name;
  const kindOf = (name) => kinds.get(name)?.kind ?? null;
  /** A record of parser-realm's, named or held: its export's name. */
  const recordOf = (n) => {
    const name = exportOf(n);
    if (name !== null) return kindOf(name) === 'record' ? name : null;
    const binding = bindingOf(n);
    if (!binding || binding.kind !== 'var' || binding.assigned || binding.values.length !== 1) return null;
    return recordOf(binding.values[0]);
  };
  /** Whether `value` is a function of parser-realm's, or what holds one. */
  const holdsCapture = (value, seen = new Set()) => {
    if (!value) return false;
    const name = exportOf(value);
    if (name !== null) return ['function', 'constructor', 'value'].includes(kindOf(name));
    if (value.type === 'MemberExpression' && !value.computed && recordOf(value.object) !== null) return true;
    if (value.type === 'LogicalExpression') return holdsCapture(value.left, seen) || holdsCapture(value.right, seen);
    const binding = bindingOf(value);
    if (binding && !seen.has(binding)) { seen.add(binding); return binding.values.some((v) => holdsCapture(v, seen)); }
    return false;
  };
  const isCaptureBinding = (binding) => binding && binding.kind === 'var' && binding.values.some((v) => holdsCapture(v));
  /** Whether `n`'s value is only tested for truth. */
  const isTested = (n) => {
    const parent = parents.get(n);
    if (['IfStatement', 'WhileStatement', 'DoWhileStatement', 'ConditionalExpression', 'ForStatement'].includes(parent.type) && parent.test === n) return true;
    if (parent.type === 'UnaryExpression' && parent.operator === '!') return true;
    return parent.type === 'LogicalExpression' && isTested(parent);
  };
  /** Where a function, or what holds one, may be: called, tested, held, or given to parser-realm's `call`. */
  const usedAsFunction = (n) => {
    const parent = parents.get(n);
    if (parent.type === 'CallExpression' && parent.callee === n) return true;
    if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return true;
    if (isTested(n)) return true;
    if (parent.type === 'VariableDeclarator' && parent.init === n) return true;
    if (parent.type === 'LogicalExpression' && parents.get(parent).type === 'VariableDeclarator') return true;
    return isRealmCall(parent, 'call') && parent.arguments[0] === n;
  };

  // ── acorn's own constructors, and the fields the parser sets ──
  const functionLiteral = (binding) => binding && binding.scope === root && !binding.assigned && binding.values.length === 1
    && (binding.values[0].type === 'FunctionExpression' || binding.values[0].type === 'FunctionDeclaration');
  const nulled = new Set();
  const imports = program.body.filter((s) => s.type === 'ImportDeclaration').length;
  program.body.forEach((statement, index) => {
    if (statement.type !== 'ExpressionStatement' || !isRealmCall(statement.expression, 'nullPrototypes')) return;
    const target = statement.expression.arguments[0];
    const binding = bindingOf(target);
    if (statement.expression.arguments.length !== 1 || !functionLiteral(binding)) {
      find(statement, 'nullPrototypes given something other than a variable whose value is a function literal');
      return;
    }
    // Where it is declared: right after its var statement; a function declaration's, before any statement but these.
    const declaration = binding.values[0];
    const declared = declaration.type === 'FunctionDeclaration'
      ? program.body.slice(imports, index).every((s) => s.type === 'ExpressionStatement' && isRealmCall(s.expression, 'nullPrototypes'))
      : program.body[index - 1]?.type === 'VariableDeclaration' && program.body[index - 1].declarations.some((d) => d.init === declaration);
    if (!declared) find(statement, `nullPrototypes(${target.name}) away from where ${target.name} is declared`);
    else nulled.add(binding);
  });
  const fieldsSet = new Set();
  const methodsSet = new Set();
  const isFunctionValue = (n) => n && (n.type === 'FunctionExpression' || (n.type === 'MemberExpression' && !n.computed && methodsSet.has(n.property.name))
    || (n.type === 'Identifier' && bindingOf(n)?.kind === 'param'));
  for (let size = -1; size !== fieldsSet.size + methodsSet.size;) {
    size = fieldsSet.size + methodsSet.size;
    visitAll(program, null, (node) => {
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed) {
        fieldsSet.add(node.left.property.name);
        if (isFunctionValue(node.right)) methodsSet.add(node.left.property.name);
      }
      if (node.type === 'Property' && !node.computed && node.key.type === 'Identifier') {
        fieldsSet.add(node.key.name);
        if (node.value.type === 'FunctionExpression') methodsSet.add(node.key.name);
      }
    });
  }

  // ── The checks ──
  visitAll(program, null, (node, parent) => {
    if (!ALLOWED.has(node.type)) { find(node, `${node.type}, which this does not allow`); return; }
    if (node.type === 'FunctionDeclaration' && parent.type !== 'Program' && !(parent.type === 'BlockStatement' && scopes.get(parents.get(parent))?.kind === 'function')) {
      find(node, 'a function declared in a block, which a module scopes to the block');
    }
    switch (node.type) {
      case 'Identifier': {
        if (!references.has(node)) return;
        const binding = references.get(node);
        if (binding === null) {
          if (!FIXED.has(node.name)) find(node, `the global ${node.name}`);
          return;
        }
        if (binding.kind === 'realm') {
          if (!(parent.type === 'MemberExpression' && parent.object === node && !parent.computed && kinds.has(parent.property.name))) {
            find(node, `${REALM} used other than for one of its exports`);
          }
          return;
        }
        if (binding.kind === 'arguments') {
          const length = parent.type === 'MemberExpression' && parent.object === node && !parent.computed && parent.property.name === 'length'
            && !(parents.get(parent).type === 'AssignmentExpression' && parents.get(parent).left === parent) && parents.get(parent).type !== 'UpdateExpression';
          const key = isRealmCall(parent, 'argument') ? parent.arguments[1] : null;
          const element = key !== null && parent.arguments.length === 2 && parent.arguments[0] === node
            && !(key.type === 'Literal' && typeof key.value !== 'number');
          if (!length && !element) find(node, 'arguments used other than for its length or argument(arguments, k)');
        }
        if (binding.kind === 'caught' && parent.type !== 'ThrowStatement' && !(parent.type === 'BinaryExpression' && ['===', '!=='].includes(parent.operator))) {
          find(node, `the caught ${node.name} used other than compared or rethrown`);
        }
        if (isCaptureBinding(binding) && !usedAsFunction(node) && !(parent.type === 'MemberExpression' && parent.object === node && recordOf(node) !== null)) {
          find(node, `${node.name}, which holds a function of the realm's, used other than called or tested`);
        }
        if (recordOf(node) !== null && !(parent.type === 'MemberExpression' && parent.object === node && !parent.computed) && !(parent.type === 'VariableDeclarator')) {
          find(node, `${node.name}, which holds a record of captures, used other than for a member`);
        }
        return;
      }
      case 'MemberExpression': {
        const name = exportOf(node);
        if (name !== null) { checkExport(node, name); return; }
        if (isRealm(node.object)) return;
        const record = recordOf(node.object);
        if (record !== null) {
          if (node.computed || !kinds.get(record).members.has(node.property.name)) find(node, `a member of the record ${record} it does not hold`);
          else if (!usedAsFunction(node)) find(node, `${record}.${node.property.name}, a function of the realm's, used other than called or tested`);
          return;
        }
        if (node.object.type === 'Identifier' && isCaptureBinding(bindingOf(node.object))) {
          find(node, `a member of ${node.object.name}, which holds a function of the realm's`);
          return;
        }
        if (node.object.type === 'Identifier' && bindingOf(node.object)?.kind === 'arguments') return;
        const objectBinding = bindingOf(node.object);
        const fn = functionBinding(objectBinding);
        if (fn && !nulled.has(fn)) find(node, `a member of ${node.object.name}, a function that inherits Function.prototype`);
        const write = (parent.type === 'AssignmentExpression' && parent.left === node) || parent.type === 'UpdateExpression'
          || (parent.type === 'UnaryExpression' && parent.operator === 'delete');
        const called = parent.type === 'CallExpression' && parent.callee === node;
        if (node.computed) {
          if (called) {
            const list = objectBinding && objectBinding.kind === 'var' && !objectBinding.assigned && objectBinding.values.length === 1 && isRealmCall(objectBinding.values[0], 'list');
            if (!list) find(node, 'a call by a computed key of something other than a list the parser made');
          } else if (!write && !isGuardedIndex(node, parent)) {
            find(node, 'a computed read, which may read a string past its end');
          }
          return;
        }
        const field = node.property.name;
        if (builtins.has(field) && (called ? !methodsSet.has(field) : !fieldsSet.has(field))) {
          find(node, `${called ? 'a call' : write ? 'a write' : 'a read'} of ${field}, which a built-in prototype has`);
        } else if (called && !fieldsSet.has(field)) {
          find(node, `a call of ${field}, a name the parser sets nowhere`);
        }
        return;
      }
      case 'CallExpression':
        if (isRealmCall(node, 'own') && (node.arguments.length !== 1 || node.arguments[0].type !== 'ObjectExpression')) find(node, 'own given other than one object literal');
        return;
      case 'NewExpression': {
        const callee = node.callee;
        const name = exportOf(callee);
        if (name !== null && (kindOf(name) === 'constructor' || kindOf(name) === 'error')) return;
        if (isRealmCall(callee, 'ownConstructor') && callee.arguments.length === 1 && callee.arguments[0].type === 'ThisExpression') return;
        const binding = bindingOf(callee);
        if (functionLiteral(binding) && nulled.has(binding)) return;
        find(node, `new of ${code.slice(callee.start, callee.end)}, which is not a constructor that inherits nothing`);
        return;
      }
      case 'ObjectExpression':
        if (!(isRealmCall(parent, 'own') && parent.arguments[0] === node)) find(node, 'an object literal that inherits Object.prototype');
        for (const p of node.properties) {
          if (p.type !== 'Property' || p.kind !== 'init' || p.computed) find(p, 'a property that is computed, a getter or a setter');
          else if ((p.key.type === 'Identifier' && p.key.name === '__proto__') || (p.key.type === 'Literal' && p.key.value === '__proto__')) find(p, 'a property naming the prototype');
        }
        return;
      case 'Literal':
        if (node.regex && !(isRealmCall(parent, 'regexp') && parent.arguments[0] === node)) find(node, 'a regexp literal that inherits RegExp.prototype');
        return;
      case 'ForInStatement':
        if (!(isRealmCall(node.right, 'owned') && node.right.arguments.length === 1)) find(node, 'for-in over an object not checked by owned');
        return;
      case 'ThisExpression':
        if (parent.type === 'NewExpression' && parent.callee === node) find(node, 'new this, unchecked');
        return;
      case 'BinaryExpression':
        if (node.operator === 'in' || node.operator === 'instanceof') find(node, `\`${node.operator}\`, which consults the realm`);
        return;
      case 'AssignmentExpression':
        if (node.left.type !== 'Identifier' && node.left.type !== 'MemberExpression') find(node, `an assignment to a ${node.left.type}`);
        return;
      default:
        return;
    }
  });

  /** `typeof o === "string" ? $$.index(o, k) : o[k]`, with `member` its `o[k]`. */
  function isGuardedIndex(member, conditional) {
    if (conditional.type !== 'ConditionalExpression' || conditional.alternate !== member) return false;
    const text = (n) => code.slice(n.start, n.end);
    const { test, consequent } = conditional;
    return test.type === 'BinaryExpression' && test.operator === '===' && test.left.type === 'UnaryExpression' && test.left.operator === 'typeof'
      && text(test.left.argument) === text(member.object) && test.right.type === 'Literal' && test.right.value === 'string'
      && isRealmCall(consequent, 'index') && consequent.arguments.length === 2
      && text(consequent.arguments[0]) === text(member.object) && text(consequent.arguments[1]) === text(member.property);
  }

  /** Whether `member`, `$$.name`, is where its export's kind allows. */
  function checkExport(member, name) {
    const parent = parents.get(member);
    const kind = kindOf(name);
    if (kind === null) { find(member, `${REALM}.${name}, which parser-realm does not export`); return; }
    if (parent.type === 'AssignmentExpression' && parent.left === member) { find(member, `a write of ${REALM}.${name}`); return; }
    switch (kind) {
      case 'record':
        if (!(parent.type === 'MemberExpression' && parent.object === member && !parent.computed) && parent.type !== 'VariableDeclarator') {
          find(member, `the record ${name} used other than for a member`);
        }
        return;
      case 'symbol':
        if (!(parent.type === 'MemberExpression' && parent.computed && parent.property === member)) find(member, `the symbol ${name} used other than as a key`);
        return;
      case 'error': {
        if (!(parent.type === 'NewExpression' && parent.callee === member)) { find(member, `the error constructor ${name} used other than constructed`); return; }
        const holder = parents.get(parent);
        if (holder.type === 'ThrowStatement') return;
        const binding = holder.type === 'VariableDeclarator' && holder.init === parent ? bindings.get(holder.id) : null;
        const onlyThrownOrGiven = binding && !binding.assigned && binding.refs.every((ref) => {
          const at = parents.get(ref);
          return at.type === 'ThrowStatement' || (isRealmCall(at, 'define') && at.arguments[0] === ref);
        });
        if (!onlyThrownOrGiven) find(member, `an error of ${name} used other than thrown or given fields by define`);
        return;
      }
      case 'constructor':
        if (!(parent.type === 'NewExpression' && parent.callee === member) && !usedAsFunction(member)) find(member, `${name} used other than called, constructed or tested`);
        return;
      default:
        if (!usedAsFunction(member)) find(member, `${name} used other than called or tested`);
    }
  }

  return findings;
}
