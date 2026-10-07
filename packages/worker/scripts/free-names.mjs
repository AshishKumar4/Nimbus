/**
 * free-names.mjs — the names a script reads that nothing in it declares: the
 * globals it needs from wherever it is evaluated. A bundle spliced into a
 * facet module (scripts/bundle-facet-workers.mjs) may reach only the
 * module-local imports the facet makes for it and the globals every facet
 * has; anything else is a ReferenceError inside the facet, which no
 * typecheck sees.
 *
 * Scopes are a script's or module's top level, each function (its
 * parameters, `arguments`, its `var`s and function declarations, hoisted),
 * each block (`let`, `const`, `class`, and a function declared in it), a
 * catch clause, a `for` head, and a class or function expression's own
 * name. A property name, a label and `import.meta` are not references.
 */
import { parse } from 'acorn';

/**
 * The free names of `source`, a script (or, with `sourceType: 'module'`, a module).
 *
 * @param {string} source
 * @param {{ sourceType?: 'script' | 'module' }} [options]
 * @returns {Set<string>}
 */
export function freeNames(source, { sourceType = 'script' } = {}) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType, allowHashBang: true });
  const free = new Set();
  const scopes = [];
  const declare = (name) => scopes[scopes.length - 1].add(name);
  const declared = (name) => scopes.some((scope) => scope.has(name));
  const reference = (name) => {
    if (!declared(name)) free.add(name);
  };

  /** Every name a binding pattern declares. */
  const patternNames = (pattern, out = []) => {
    if (!pattern) return out;
    switch (pattern.type) {
      case 'Identifier': out.push(pattern.name); break;
      case 'ObjectPattern':
        for (const property of pattern.properties) patternNames(property.type === 'RestElement' ? property.argument : property.value, out);
        break;
      case 'ArrayPattern': for (const element of pattern.elements) patternNames(element, out); break;
      case 'AssignmentPattern': patternNames(pattern.left, out); break;
      case 'RestElement': patternNames(pattern.argument, out); break;
    }
    return out;
  };
  /** The expressions inside a pattern: defaults and computed keys. */
  const patternExpressions = (pattern) => {
    if (!pattern) return;
    switch (pattern.type) {
      case 'ObjectPattern':
        for (const property of pattern.properties) {
          if (property.type === 'RestElement') patternExpressions(property.argument);
          else {
            if (property.computed) walk(property.key);
            patternExpressions(property.value);
          }
        }
        break;
      case 'ArrayPattern': for (const element of pattern.elements) patternExpressions(element); break;
      case 'AssignmentPattern': patternExpressions(pattern.left); walk(pattern.right); break;
      case 'RestElement': patternExpressions(pattern.argument); break;
      case 'MemberExpression': walk(pattern); break;
    }
  };
  /** A function body's hoisted declarations: `var`s and function declarations, not into nested functions. */
  const hoist = (node) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'VariableDeclaration':
        if (node.kind === 'var') for (const d of node.declarations) for (const name of patternNames(d.id)) declare(name);
        return;
      case 'FunctionDeclaration':
        if (node.id) declare(node.id.name);
        return;
      case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassDeclaration': case 'ClassExpression':
        return;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(hoist);
      else if (value && typeof value.type === 'string' && key !== 'test' && !/Expression$/.test(value.type)) hoist(value);
    }
  };
  /** A block's lexical declarations. */
  const lexical = (statements) => {
    for (const statement of statements) {
      const node = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
      if (!node) continue;
      if (node.type === 'VariableDeclaration' && node.kind !== 'var') for (const d of node.declarations) for (const name of patternNames(d.id)) declare(name);
      else if ((node.type === 'ClassDeclaration' || node.type === 'FunctionDeclaration') && node.id) declare(node.id.name);
      else if (node.type === 'ImportDeclaration') for (const specifier of node.specifiers) declare(specifier.local.name);
    }
  };
  const inScope = (body) => {
    scopes.push(new Set());
    try { body(); } finally { scopes.pop(); }
  };
  const fn = (node) => inScope(() => {
    if (node.type !== 'ArrowFunctionExpression') declare('arguments');
    for (const param of node.params) for (const name of patternNames(param)) declare(name);
    if (node.body.type === 'BlockStatement') {
      hoist(node.body);
      lexical(node.body.body);
    }
    for (const param of node.params) patternExpressions(param);
    if (node.body.type === 'BlockStatement') for (const statement of node.body.body) walk(statement);
    else walk(node.body);
  });

  function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Identifier': reference(node.name); return;
      case 'FunctionDeclaration': fn(node); return;
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.type === 'FunctionExpression' && node.id) inScope(() => { declare(node.id.name); fn(node); });
        else fn(node);
        return;
      case 'ClassDeclaration': case 'ClassExpression':
        inScope(() => {
          if (node.id) declare(node.id.name);
          walk(node.superClass);
          for (const member of node.body.body) {
            if (member.computed) walk(member.key);
            if (member.type === 'StaticBlock') inScope(() => { lexical(member.body); member.body.forEach(walk); });
            else walk(member.value);
          }
        });
        return;
      case 'BlockStatement': case 'StaticBlock':
        inScope(() => { lexical(node.body); node.body.forEach(walk); });
        return;
      case 'SwitchStatement':
        walk(node.discriminant);
        inScope(() => {
          for (const c of node.cases) lexical(c.consequent);
          for (const c of node.cases) { walk(c.test); c.consequent.forEach(walk); }
        });
        return;
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement':
        inScope(() => {
          const head = node.type === 'ForStatement' ? node.init : node.left;
          if (head && head.type === 'VariableDeclaration' && head.kind !== 'var') for (const d of head.declarations) for (const name of patternNames(d.id)) declare(name);
          for (const key of ['init', 'test', 'update', 'left', 'right', 'body']) walk(node[key]);
        });
        return;
      case 'CatchClause':
        inScope(() => {
          for (const name of patternNames(node.param)) declare(name);
          patternExpressions(node.param);
          walk(node.body);
        });
        return;
      case 'VariableDeclaration':
        for (const d of node.declarations) { patternExpressions(d.id); walk(d.init); }
        return;
      case 'MemberExpression':
        walk(node.object);
        if (node.computed) walk(node.property);
        return;
      case 'Property':
        if (node.computed) walk(node.key);
        walk(node.value);
        return;
      case 'MethodDefinition': case 'PropertyDefinition':
        if (node.computed) walk(node.key);
        walk(node.value);
        return;
      case 'LabeledStatement': walk(node.body); return;
      case 'BreakStatement': case 'ContinueStatement': case 'MetaProperty': return;
      case 'AssignmentExpression':
        if (node.left.type === 'Identifier') reference(node.left.name);
        else patternExpressions(node.left), patternNames(node.left).forEach(reference);
        walk(node.right);
        return;
      case 'ImportDeclaration': return;
      case 'ExportNamedDeclaration':
        if (node.declaration) walk(node.declaration);
        else if (!node.source) for (const specifier of node.specifiers) reference(specifier.local.name);
        return;
      case 'ExportSpecifier': return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value.type === 'string') walk(value);
    }
  }

  inScope(() => {
    hoist(ast);
    lexical(ast.body);
    ast.body.forEach(walk);
  });
  return free;
}

/** What every facet module has in scope without importing it: ECMAScript's globals and the Workers runtime's (nodejs_compat's `process` among them). */
export const FACET_GLOBALS = new Set([
  'globalThis', 'undefined', 'NaN', 'Infinity', 'Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Math', 'JSON', 'Reflect', 'Proxy', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Promise', 'RegExp', 'Date',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Uint16Array', 'Int16Array',
  'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Atomics',
  'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'console', 'queueMicrotask', 'setTimeout', 'clearTimeout',
  'structuredClone', 'atob', 'btoa', 'performance', 'process',
]);
