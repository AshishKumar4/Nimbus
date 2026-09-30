/**
 * Whether running a program starts a server, judged from its code before it
 * runs.
 *
 * A port is reachable only from a resident process (node-runner.ts runFresh),
 * and that has to be chosen before the program runs; a program that finishes
 * in a resident process is never reported ended. So the question is not
 * whether a server appears somewhere in the text, but whether the code this
 * invocation runs reaches one. The program is parsed and walked the way it
 * runs:
 *
 * - Top-level statements run in order. A branch runs unless its condition is
 *   known to be false for this invocation: `process.argv` and values derived
 *   from it are known, as is `require.main === module` (true for the entry,
 *   false for a module it loads); anything else may go either way. Code after
 *   `return`, `throw` or `process.exit()` does not run.
 * - A function runs when it is called, constructed, invoked immediately, or
 *   handed to a call as a callback (a listener, `.then`, a CLI's action or a
 *   command's `handler`); not when it is only defined or exported. Logging a
 *   value does not call it.
 * - A server starts at a call of `createServer`, `createSecureServer` or
 *   `serve` (http, https, http2, net, Bun.serve, ...), however it was named (a
 *   destructured or aliased creator, `const make = http.createServer`,
 *   counts), and at a `.listen(...)` given a port, or nothing.
 * - Loading one of the program's own modules runs its top level. Using what
 *   it exports (calling, constructing, calling a method of, or handing it to a
 *   call) runs that export: the function exported under that name, a method
 *   of the exported class, or what it re-exports from a further module
 *   (`module.exports = require('./server')`, `export { x } from './server'`).
 *
 * The program's own modules are those inside the entry's package. They are
 * read lazily, only when the walk reaches them, within a bound on how many
 * and how large; a source past it, or one the parser cannot read, starts
 * nothing.
 */

import { parseJavaScriptProgram } from './javascript-ast.js';

/** An acorn node, read structurally by the walk (javascript-ast.ts parses it). */
interface AstNode {
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: ESTree children are read structurally, per node type.
  [key: string]: any;
}

/** Calls that create a server, as a member (`http.createServer`) or a bare name. */
const CREATORS = new Set(['createServer', 'createSecureServer', 'serve']);
/** A name that holds a port (`port`, `PORT`, `opts.port`, `httpPort`, `port_number`), not `reporter`. */
const PORT_NAME_RE = /(?:^|_)port(?:$|_|[A-Z0-9])|Port(?:$|[A-Z0-9_])|PORT/;
/** How many modules one decision reads, and how many bytes of source in all. */
const MODULE_LIMIT = 24;
const SOURCE_BYTE_BUDGET = 4 * 1024 * 1024;
/** How large a module may be to be walked: parsing costs about 50 ms a MiB. */
export const SERVER_LAUNCH_MODULE_BYTES = 2 * 1024 * 1024;
/** How many of its own modules deep the program is followed from the entry. */
const HOP_LIMIT = 3;
/** Extensions of modules that carry no code to walk. */
const DATA_MODULE_RE = /\.(json|node|wasm|css|txt)$/i;
const SKIPPED_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);

/** How the analysis reads the program's modules: the command's own view. */
export interface ServerLaunchHost {
  /** A relative specifier from `dir`, resolved to a VFS key, or null. */
  resolve(dir: string, specifier: string): Promise<string | null>;
  /** A module's source, or null when it cannot be read. */
  read(path: string): Promise<string | null>;
}

export interface ServerLaunchProgram {
  /** The entry's code, as it will run (after any TypeScript/ESM transform). */
  source: string;
  /** The entry's VFS key; null for `-e` and stdin programs. */
  path: string | null;
  /** The directory its relative modules resolve from. */
  dir: string;
  /** Modules outside this directory are not the program's own. */
  packageRoot: string;
  /** `process.argv` as the program sees it: [execPath, script?, ...args]. */
  argv: readonly string[];
}

/** Whether running `program` starts a server. */
export async function programLaunchesServer(program: ServerLaunchProgram, host: ServerLaunchHost): Promise<boolean> {
  const graph = new ModuleGraph(program, host);
  const entry = graph.addModule(program.path, program.dir, program.source, true);
  await graph.resolveDeps(entry);
  for (;;) {
    graph.resetResults();
    if (graph.onLoad(entry, HOP_LIMIT)) return true;
    // Modules the walk reached but had not read yet: read them and walk again.
    if (!(await graph.loadMissing())) return false;
  }
}

type Completion = 'normal' | 'abrupt' | 'break';

/** A value of one of the program's modules: the module itself, or an export (and members) of it. */
interface ModuleRef {
  path: string;
  members: string[];
}

interface ModuleRecord {
  path: string | null;
  dir: string;
  entry: boolean;
  ast: AstNode | null;
  /** Relative specifier → VFS key (null: not the program's own, or absent). */
  deps: Map<string, string | null>;
  scope: Scope | null;
  results: Map<string, boolean | 'pending'>;
}

interface Scope {
  /** Functions and classes a name is bound to. */
  functions: Map<string, AstNode[]>;
  /** Methods and function-valued properties of a name, by member name. */
  members: Map<string, Map<string, AstNode[]>>;
  /** Names bound to a value of one of the program's modules. */
  modules: Map<string, ModuleRef>;
  /** Names bound to a server creator (`const make = http.createServer`). */
  creators: Set<string>;
  /** Names bound to `new <Local>()`: the local class or function. */
  instances: Map<string, string>;
  /** A name's initializer, for evaluating conditions. */
  constants: Map<string, AstNode>;
  /** Names assigned after their declaration, or declared twice: not constants. */
  assigned: Set<string>;
  /** What the module exports, by name ('default' is `module.exports` / `export default`). */
  exports: Map<string, AstNode[]>;
  /** Names re-exported from another module: `export { x } from`, `export * from`. */
  reexports: Map<string, ModuleRef[]>;
  /** Modules whose every export this one re-exports (`export * from`). */
  starExports: string[];
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}

function isFunction(node: AstNode | null | undefined): boolean {
  return !!node && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
    || node.type === 'FunctionDeclaration');
}

function isClass(node: AstNode | null | undefined): boolean {
  return !!node && (node.type === 'ClassDeclaration' || node.type === 'ClassExpression');
}

/** Parentheses, `(0, f)`, `await` and `?.` do not change what is called. */
function unwrap(node: AstNode): AstNode {
  let at = node;
  for (;;) {
    if (at.type === 'ParenthesizedExpression' || at.type === 'ChainExpression') at = at.expression;
    else if (at.type === 'SequenceExpression') at = at.expressions[at.expressions.length - 1];
    else if (at.type === 'AwaitExpression') at = at.argument;
    else return at;
  }
}

function keyName(key: AstNode, computed: boolean): string | null {
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

function propertyName(member: AstNode): string | null {
  return member.type === 'MemberExpression' ? keyName(member.property, member.computed) : null;
}

function isNamed(node: AstNode, object: string, property: string): boolean {
  const n = unwrap(node);
  return n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === object
    && propertyName(n) === property;
}

/** `require('<literal>')`'s or `import('<literal>')`'s specifier. */
function requiredSpecifier(node: AstNode): string | null {
  const n = unwrap(node);
  if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require'
    && n.arguments.length >= 1 && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string') {
    return n.arguments[0].value;
  }
  if (n.type === 'ImportExpression' && n.source.type === 'Literal' && typeof n.source.value === 'string') {
    return n.source.value;
  }
  return null;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';
}

/** Each child node of `node`. */
function forEachChild(node: AstNode, visit: (child: AstNode) => void): void {
  for (const key in node) {
    if (SKIPPED_KEYS.has(key)) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (isNode(c)) visit(c);
    } else if (isNode(child)) {
      visit(child);
    }
  }
}

/** Every node below `node`, functions included, in source order. */
function forEachNode(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  forEachChild(node, (child) => forEachNode(child, visit));
}

/** `exports` or `module.exports`: the object exports are assigned on. */
function isExportsObject(node: AstNode): boolean {
  const n = unwrap(node);
  return (n.type === 'Identifier' && n.name === 'exports') || isNamed(n, 'module', 'exports');
}

class ModuleGraph {
  private readonly modules = new Map<string, ModuleRecord>();
  private readonly missing = new Set<string>();
  private readonly unreadable = new Set<string>();
  private reads = 0;
  private bytes = 0;

  constructor(private readonly program: ServerLaunchProgram, private readonly host: ServerLaunchHost) {}

  get argv(): readonly string[] { return this.program.argv; }

  addModule(path: string | null, dir: string, source: string | null, entry: boolean): ModuleRecord {
    const ast = source !== null && source.length <= SERVER_LAUNCH_MODULE_BYTES ? parseJavaScriptProgram(source) as unknown as AstNode | null : null;
    const record: ModuleRecord = { path, dir, entry, ast, deps: new Map(), scope: null, results: new Map() };
    if (path !== null) this.modules.set(path, record);
    return record;
  }

  /** Resolve every relative specifier a module names, once, before it is walked. */
  async resolveDeps(record: ModuleRecord): Promise<void> {
    if (record.ast === null) return;
    const specifiers = new Set<string>();
    forEachNode(record.ast, (n) => {
      const required = requiredSpecifier(n);
      if (required !== null) specifiers.add(required);
      if ((n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration')
        && n.source && typeof n.source.value === 'string') {
        specifiers.add(n.source.value);
      }
    });
    const root = this.program.packageRoot;
    for (const specifier of specifiers) {
      if (!isRelative(specifier) || DATA_MODULE_RE.test(specifier)) continue;
      const target = await this.host.resolve(record.dir, specifier);
      const own = target !== null && target !== record.path && (root === '' || target.startsWith(`${root}/`))
        && !DATA_MODULE_RE.test(target);
      record.deps.set(specifier, own ? target : null);
    }
  }

  /** Read the modules the last walk reached; false when there were none left to read. */
  async loadMissing(): Promise<boolean> {
    const pending = [...this.missing].filter((p) => !this.modules.has(p) && !this.unreadable.has(p));
    this.missing.clear();
    if (pending.length === 0) return false;
    for (const path of pending) {
      if (this.reads >= MODULE_LIMIT || this.bytes >= SOURCE_BYTE_BUDGET) { this.unreadable.add(path); continue; }
      this.reads++;
      const source = await this.host.read(path);
      if (source === null) { this.unreadable.add(path); continue; }
      this.bytes += source.length;
      const slash = path.lastIndexOf('/');
      const record = this.addModule(path, slash > 0 ? path.slice(0, slash) : '', source, false);
      await this.resolveDeps(record);
    }
    return true;
  }

  resetResults(): void {
    for (const record of this.modules.values()) record.results.clear();
  }

  /** The module at `path`, or undefined (noted to be read) when not read yet. */
  module(path: string | null | undefined): ModuleRecord | undefined {
    if (!path) return undefined;
    const record = this.modules.get(path);
    if (record === undefined && !this.unreadable.has(path)) this.missing.add(path);
    return record;
  }

  scope(record: ModuleRecord): Scope {
    if (record.scope === null) record.scope = buildScope(record);
    return record.scope;
  }

  private memo(record: ModuleRecord, key: string, compute: () => boolean): boolean {
    const known = record.results.get(key);
    if (known !== undefined) return known === true;
    record.results.set(key, 'pending');
    const launches = compute();
    record.results.set(key, launches);
    return launches;
  }

  /** Whether loading the module (running its top level) starts a server. */
  onLoad(record: ModuleRecord, hops: number): boolean {
    return this.memo(record, `load#${hops}`, () => {
      if (record.ast === null) return false;
      const walk = new Walk(this, record, hops);
      walk.statements(record.ast.body);
      return walk.launches;
    });
  }

  /** Whether using the module's export at `members` (calling it, constructing it, ...) starts a server. */
  onUse(record: ModuleRecord, members: string[], hops: number): boolean {
    return this.memo(record, `use#${members.join('.')}#${hops}`, () => {
      if (record.ast === null) return false;
      const walk = new Walk(this, record, hops);
      walk.useExport(members);
      return walk.launches;
    });
  }
}

function buildScope(record: ModuleRecord): Scope {
  const scope: Scope = {
    functions: new Map(), members: new Map(), modules: new Map(), creators: new Set(), instances: new Map(),
    constants: new Map(), assigned: new Set(), exports: new Map(), reexports: new Map(), starExports: [],
  };
  if (record.ast === null) return scope;
  const push = <V>(map: Map<string, V[]>, name: string, value: V) => {
    const list = map.get(name);
    if (list) list.push(value); else map.set(name, [value]);
  };
  const addMember = (owner: string, name: string, fn: AstNode) => {
    let byName = scope.members.get(owner);
    if (!byName) {
      byName = new Map();
      scope.members.set(owner, byName);
    }
    push(byName, name, fn);
  };
  const addClassMembers = (owner: string, cls: AstNode) => {
    for (const element of cls.body.body) {
      if (element.type !== 'MethodDefinition') continue;
      const name = keyName(element.key, element.computed);
      if (name !== null) addMember(owner, name, element.value);
    }
  };
  const moduleRef = (value: AstNode) => moduleOf(record, scope, value);
  const bindValue = (name: string, value: AstNode) => {
    const v = unwrap(value);
    if (isFunction(v) || isClass(v)) {
      push(scope.functions, name, v);
      if (isClass(v)) addClassMembers(name, v);
      return;
    }
    if (v.type === 'ObjectExpression') {
      for (const prop of v.properties) {
        const key = prop.type === 'Property' ? keyName(prop.key, prop.computed) : null;
        if (key !== null && isFunction(prop.value)) addMember(name, key, prop.value);
      }
      return;
    }
    const ref = moduleRef(v);
    if (ref !== null) { scope.modules.set(name, ref); return; }
    if (v.type === 'NewExpression' && v.callee.type === 'Identifier') { scope.instances.set(name, v.callee.name); return; }
    // `const make = http.createServer` / `server.listen.bind(server)`.
    const bound = v.type === 'CallExpression' && propertyName(unwrap(v.callee)) === 'bind' ? unwrap(unwrap(v.callee).object) : v;
    const created = propertyName(bound);
    if (created !== null && CREATORS.has(created)) scope.creators.add(name);
  };
  const constant = (name: string, init: AstNode) => {
    // A name declared twice (in two functions, say) is not one constant.
    if (scope.constants.has(name)) scope.assigned.add(name);
    scope.constants.set(name, init);
  };
  const bindPattern = (pattern: AstNode, init: AstNode | null) => {
    if (pattern.type === 'Identifier') {
      if (!init) return;
      bindValue(pattern.name, init);
      constant(pattern.name, init);
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      const ref = init ? moduleRef(init) : null;
      for (const prop of pattern.properties) {
        if (prop.type !== 'Property') continue;
        const local = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
        const key = keyName(prop.key, prop.computed);
        if (local.type !== 'Identifier' || key === null) continue;
        if (CREATORS.has(key)) scope.creators.add(local.name);
        if (ref !== null) scope.modules.set(local.name, { path: ref.path, members: [...ref.members, key] });
      }
      return;
    }
    if (pattern.type === 'ArrayPattern' && init) {
      pattern.elements.forEach((element: AstNode | null, index: number) => {
        if (element?.type === 'Identifier') {
          constant(element.name, { type: 'MemberExpression', computed: true, object: init, property: { type: 'Literal', value: index } });
        }
      });
    }
  };
  const exportValue = (name: string, value: AstNode) => {
    const v = unwrap(value);
    if (v.type === 'ObjectExpression' && name === 'default') {
      // `module.exports = { start, serve: require('./serve') }`: each property is an export.
      for (const prop of v.properties) {
        const key = prop.type === 'Property' ? keyName(prop.key, prop.computed) : null;
        if (key !== null) push(scope.exports, key, prop.value);
      }
    }
    push(scope.exports, name, v);
  };
  forEachNode(record.ast, (n) => {
    switch (n.type) {
      case 'VariableDeclarator':
        bindPattern(n.id, n.init ?? null);
        break;
      case 'FunctionDeclaration':
        if (n.id) push(scope.functions, n.id.name, n);
        break;
      case 'ClassDeclaration':
        if (n.id) { push(scope.functions, n.id.name, n); addClassMembers(n.id.name, n); }
        break;
      case 'ImportDeclaration': {
        const path = record.deps.get(n.source.value) ?? null;
        for (const s of n.specifiers) {
          if (s.type === 'ImportSpecifier' && CREATORS.has(keyName(s.imported, false) ?? '')) scope.creators.add(s.local.name);
          if (path === null) continue;
          const members = s.type === 'ImportDefaultSpecifier' ? ['default']
            : s.type === 'ImportSpecifier' ? [keyName(s.imported, false) ?? ''] : [];
          scope.modules.set(s.local.name, { path, members });
        }
        break;
      }
      case 'ExportNamedDeclaration': {
        const path = n.source ? record.deps.get(n.source.value) ?? null : null;
        for (const s of n.specifiers) {
          const exported = keyName(s.exported, false);
          const local = keyName(s.local, false);
          if (exported === null || local === null) continue;
          if (n.source) { if (path !== null) push(scope.reexports, exported, { path, members: [local] }); }
          else push(scope.exports, exported, s.local);
        }
        const d = n.declaration;
        if (d && (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) push(scope.exports, d.id.name, d);
        if (d?.type === 'VariableDeclaration') {
          for (const decl of d.declarations) if (decl.id.type === 'Identifier' && decl.init) push(scope.exports, decl.id.name, decl.init);
        }
        break;
      }
      case 'ExportAllDeclaration': {
        const path = record.deps.get(n.source.value) ?? null;
        if (path !== null) {
          const as = n.exported ? keyName(n.exported, false) : null;
          if (as !== null) push(scope.reexports, as, { path, members: [] });
          else scope.starExports.push(path);
        }
        break;
      }
      case 'ExportDefaultDeclaration':
        exportValue('default', n.declaration);
        break;
      case 'AssignmentExpression': {
        const left = n.left;
        if (left.type === 'Identifier') {
          scope.assigned.add(left.name);
          if (n.operator === '=') bindValue(left.name, n.right);
          break;
        }
        if (left.type !== 'MemberExpression' || n.operator !== '=') break;
        const name = propertyName(left);
        if (isNamed(left, 'module', 'exports')) { exportValue('default', n.right); break; }
        if (name !== null && isExportsObject(left.object)) { exportValue(name, n.right); break; }
        if (isFunction(unwrap(n.right))) {
          // `Owner.prototype.method = function` / `Owner.method = function`.
          let owner = unwrap(left.object);
          if (owner.type === 'MemberExpression' && propertyName(owner) === 'prototype') owner = unwrap(owner.object);
          if (name !== null && owner.type === 'Identifier') addMember(owner.name, name, unwrap(n.right));
        }
        break;
      }
      case 'UpdateExpression':
        if (n.argument.type === 'Identifier') scope.assigned.add(n.argument.name);
        break;
    }
  });
  return scope;
}

/**
 * The value of one of the program's modules an expression holds:
 * `require('./x')`, `import('./x')`, an interop wrapper around one
 * (`__toESM(require('./x'))`), a member of one (`require('./x').start`), a
 * name bound to one, or an instance of one. Null otherwise.
 */
function moduleOf(record: ModuleRecord, scope: Scope, node: AstNode): ModuleRef | null {
  const at = unwrap(node);
  const specifier = requiredSpecifier(at);
  if (specifier !== null) {
    const path = record.deps.get(specifier) ?? null;
    return path === null ? null : { path, members: [] };
  }
  switch (at.type) {
    case 'Identifier':
      return scope.modules.get(at.name) ?? null;
    case 'MemberExpression': {
      const base = moduleOf(record, scope, at.object);
      const name = propertyName(at);
      if (base === null || name === null) return base;
      return { path: base.path, members: [...base.members, name] };
    }
    case 'NewExpression':
      return moduleOf(record, scope, at.callee);
    case 'CallExpression':
      if (at.arguments.length > 0 && at.callee.type === 'Identifier' && requiredSpecifier(at.arguments[0]) !== null) {
        return moduleOf(record, scope, at.arguments[0]);
      }
      return null;
    default:
      return null;
  }
}

/** A value known before the program runs. */
interface Known { value: unknown }

/** One walk of a module's code as it runs; `launches` once it reaches a server start. */
class Walk {
  launches = false;
  private readonly scope: Scope;
  private readonly ran = new Set<AstNode>();

  constructor(private readonly graph: ModuleGraph, private readonly record: ModuleRecord, private readonly hops: number) {
    this.scope = graph.scope(record);
  }

  /** Run a function's body, or a class's construction (once per walk). */
  run(fn: AstNode): void {
    if (this.launches || this.ran.has(fn)) return;
    this.ran.add(fn);
    if (isClass(fn)) {
      if (fn.superClass) this.expression(fn.superClass);
      for (const element of fn.body.body) {
        if (element.type === 'MethodDefinition' && element.kind === 'constructor') this.run(element.value);
        else if (element.type === 'PropertyDefinition' && element.value) this.expression(element.value);
        else if (element.type === 'StaticBlock') this.statements(element.body);
      }
      return;
    }
    if (fn.body.type === 'BlockStatement') this.statements(fn.body.body);
    else this.expression(fn.body);
  }

  /** Use this module's export at `members`: run what is exported there. */
  useExport(members: string[]): void {
    const [name = 'default', ...rest] = members;
    for (const value of this.scope.exports.get(name) ?? []) {
      if (this.launches) return;
      if (rest.length === 0) this.invoke(value);
      else this.invokeMember(value, rest[0]);
    }
    for (const ref of this.scope.reexports.get(name) ?? []) this.use({ path: ref.path, members: [...ref.members, ...rest] });
    if (name !== 'default') {
      for (const path of this.scope.starExports) this.use({ path, members });
      // A member of the exported value: `module.exports = Server` with `Server.prototype.start`.
      for (const value of this.scope.exports.get('default') ?? []) this.invokeMember(value, name);
    }
  }

  statements(list: AstNode[]): Completion {
    for (const statement of list) {
      if (this.launches) return 'abrupt';
      const completion = this.statement(statement);
      if (completion !== 'normal') return completion;
    }
    return 'normal';
  }

  private statement(s: AstNode): Completion {
    switch (s.type) {
      case 'ExpressionStatement': {
        this.expression(s.expression);
        const e = unwrap(s.expression);
        return e.type === 'CallExpression' && isNamed(e.callee, 'process', 'exit') ? 'abrupt' : 'normal';
      }
      case 'VariableDeclaration':
        this.expression(s);
        return 'normal';
      case 'ReturnStatement':
      case 'ThrowStatement':
        if (s.argument) this.expression(s.argument);
        return 'abrupt';
      case 'IfStatement': {
        this.expression(s.test);
        const truth = this.truth(s.test);
        const taken = truth !== false ? this.statement(s.consequent) : 'normal';
        const other = truth !== true && s.alternate ? this.statement(s.alternate) : 'normal';
        if (truth === true) return taken;
        if (truth === false) return other;
        return taken === 'abrupt' && other === 'abrupt' ? 'abrupt' : 'normal';
      }
      case 'BlockStatement':
      case 'StaticBlock':
        return this.statements(s.body);
      case 'TryStatement':
        this.statements(s.block.body);
        if (s.handler) this.statements(s.handler.body.body);
        if (s.finalizer) this.statements(s.finalizer.body);
        return 'normal';
      case 'ForStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
        for (const key of ['init', 'test', 'update', 'right']) if (isNode(s[key])) this.expression(s[key]);
        this.statement(s.body);
        return 'normal';
      case 'SwitchStatement':
        return this.switchStatement(s);
      case 'LabeledStatement':
        return this.statement(s.body) === 'abrupt' ? 'abrupt' : 'normal';
      case 'BreakStatement':
      case 'ContinueStatement':
        return 'break';
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        this.load(s.source.value);
        return 'normal';
      case 'ExportNamedDeclaration':
        if (s.source) this.load(s.source.value);
        if (s.declaration) this.statement(s.declaration);
        return 'normal';
      case 'ExportDefaultDeclaration':
        if (!isFunction(s.declaration) && !isClass(s.declaration)) this.expression(s.declaration);
        return 'normal';
      default:
        // Function and class declarations run when used, not here.
        return 'normal';
    }
  }

  private switchStatement(s: AstNode): Completion {
    this.expression(s.discriminant);
    const discriminant = this.evaluate(s.discriminant);
    const tests = s.cases.map((c: AstNode) => (c.test ? this.evaluate(c.test) : null));
    if (discriminant !== undefined && tests.every((t: Known | null | undefined) => t !== undefined)) {
      const hit = tests.findIndex((t: Known | null) => t !== null && t.value === discriminant.value);
      const start = hit >= 0 ? hit : s.cases.findIndex((c: AstNode) => c.test === null);
      if (start < 0) return 'normal';
      for (let i = start; i < s.cases.length; i++) {
        const completion = this.statements(s.cases[i].consequent);
        if (completion === 'break') return 'normal';
        if (completion === 'abrupt') return 'abrupt';
      }
      return 'normal';
    }
    for (const c of s.cases) this.statements(c.consequent);
    return 'normal';
  }

  /** An expression that is evaluated: the calls in it run. */
  private expression(e: AstNode): void {
    if (this.launches) return;
    switch (e.type) {
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'FunctionDeclaration':
      case 'ClassExpression':
      case 'ClassDeclaration':
        return;
      case 'CallExpression':
      case 'NewExpression':
        this.call(e);
        return;
      case 'ImportExpression':
        this.load(e.source.type === 'Literal' ? e.source.value : null);
        return;
      case 'ConditionalExpression': {
        this.expression(e.test);
        const truth = this.truth(e.test);
        if (truth !== false) this.expression(e.consequent);
        if (truth !== true) this.expression(e.alternate);
        return;
      }
      case 'LogicalExpression': {
        this.expression(e.left);
        const left = this.evaluate(e.left);
        const runsRight = left === undefined
          || (e.operator === '&&' ? !!left.value : e.operator === '||' ? !left.value : left.value == null);
        if (runsRight) this.expression(e.right);
        return;
      }
      default:
        forEachChild(e, (child) => this.expression(child));
    }
  }

  private call(node: AstNode): void {
    const callee = unwrap(node.callee);
    if (this.startsServer(callee, node.arguments)) { this.launches = true; return; }
    const specifier = requiredSpecifier(node);
    if (specifier !== null) { this.load(specifier); return; }

    // The callee runs: an inline function, a local function or method, or a
    // value of one of the program's modules.
    if (isFunction(callee) || isClass(callee)) this.run(callee);
    else if (callee.type === 'MemberExpression' && ['call', 'apply'].includes(propertyName(callee) ?? '')
      && isFunction(unwrap(callee.object))) this.run(unwrap(callee.object));
    else this.invoke(callee);
    if (this.launches) return;
    this.expression(callee);

    // What a call is handed, it may call. Logging a value does not call it.
    const logs = callee.type === 'MemberExpression' && unwrap(callee.object).type === 'Identifier'
      && unwrap(callee.object).name === 'console';
    for (const argument of node.arguments) {
      if (this.launches) return;
      const a = unwrap(argument.type === 'SpreadElement' ? argument.argument : argument);
      if (isFunction(a)) { this.run(a); continue; }
      if (!logs) {
        this.invoke(a);
        // A command object's handler (yargs' `.command({ handler })`).
        if (a.type === 'ObjectExpression') {
          for (const prop of a.properties) if (prop.type === 'Property' && isFunction(prop.value)) this.run(prop.value);
        }
      }
      this.expression(a);
    }
  }

  /** A call that creates a server, or listens on a port. */
  private startsServer(callee: AstNode, args: AstNode[]): boolean {
    const member = propertyName(callee);
    if (member === 'listen') return args.length === 0 || this.portLike(args[0]);
    if (member !== null) return CREATORS.has(member);
    return callee.type === 'Identifier' && (CREATORS.has(callee.name) || this.scope.creators.has(callee.name));
  }

  /**
   * `.listen`'s first argument names a port: a number, a name holding a port
   * (`PORT`, `opts.port`, `process.env.PORT || 3000`), or options with one.
   * An emitter's or a messenger's `.listen(handler)` is not a server.
   */
  private portLike(arg: AstNode): boolean {
    let found = false;
    const a = unwrap(arg);
    if (isFunction(a) || a.type === 'ThisExpression') return false;
    forEachNode(a, (n) => {
      if (found || isFunction(n)) return;
      if (n.type === 'Literal' && typeof n.value === 'number') found = true;
      else if (n.type === 'Identifier' && PORT_NAME_RE.test(n.name)) found = true;
      else if (n.type === 'Property' && keyName(n.key, n.computed) === 'port') found = true;
    });
    return found;
  }

  /** Whatever calling a value runs: local functions and methods, a module's exports. */
  private invoke(value: AstNode): void {
    const v = unwrap(value);
    const ref = moduleOf(this.record, this.scope, v);
    if (ref !== null) { this.use(ref); return; }
    if (isFunction(v) || isClass(v)) { this.run(v); return; }
    if (v.type === 'Identifier') {
      for (const fn of this.scope.functions.get(v.name) ?? []) this.run(fn);
      return;
    }
    if (v.type === 'MemberExpression') {
      const method = propertyName(v);
      if (method !== null) this.invokeMember(v.object, method);
    }
  }

  /** Calling `owner.method`: the local methods of that name, or a module's export's. */
  private invokeMember(owner: AstNode, method: string): void {
    const o = unwrap(owner);
    const ref = moduleOf(this.record, this.scope, o);
    if (ref !== null) { this.use({ path: ref.path, members: [...ref.members, method] }); return; }
    if (o.type === 'ThisExpression') {
      // A method calling another of its class: every method of that name here.
      for (const byName of this.scope.members.values()) for (const fn of byName.get(method) ?? []) this.run(fn);
      return;
    }
    const name = o.type === 'Identifier' ? o.name : isClass(o) && o.id ? o.id.name : null;
    if (name === null) return;
    const local = this.scope.instances.get(name) ?? name;
    const instanceOf = this.scope.modules.get(local);
    if (instanceOf !== undefined) { this.use({ path: instanceOf.path, members: [...instanceOf.members, method] }); return; }
    for (const fn of this.scope.members.get(local)?.get(method) ?? []) this.run(fn);
  }

  /** Loading a module runs its top level. */
  private load(specifier: string | null): void {
    if (specifier === null || this.hops <= 0) return;
    const record = this.graph.module(this.record.deps.get(specifier));
    if (record !== undefined && this.graph.onLoad(record, this.hops - 1)) this.launches = true;
  }

  /** Using a module's value runs its top level (it was loaded) and the export used. */
  private use(ref: ModuleRef): void {
    if (this.hops <= 0 || this.launches) return;
    const record = this.graph.module(ref.path);
    if (record === undefined) return;
    if (this.graph.onLoad(record, this.hops - 1) || this.graph.onUse(record, ref.members, this.hops - 1)) this.launches = true;
  }

  private truth(test: AstNode): boolean | undefined {
    const known = this.evaluate(test);
    return known === undefined ? undefined : !!known.value;
  }

  /** The value of an expression that depends only on this invocation, or undefined. */
  private evaluate(node: AstNode, depth = 0): Known | undefined {
    if (depth > 16) return undefined;
    const e = unwrap(node);
    switch (e.type) {
      case 'Literal':
        return 'regex' in e ? undefined : { value: e.value };
      case 'TemplateLiteral':
        return e.expressions.length === 0 ? { value: e.quasis[0].value.cooked } : undefined;
      case 'Identifier': {
        if (e.name === 'undefined') return { value: undefined };
        const init = this.scope.constants.get(e.name);
        return init && !this.scope.assigned.has(e.name) ? this.evaluate(init, depth + 1) : undefined;
      }
      case 'MemberExpression': {
        if (isNamed(e, 'process', 'argv')) return { value: this.graph.argv };
        if (e.object.type === 'MetaProperty' && propertyName(e) === 'main') return { value: this.record.entry };
        const object = this.evaluate(e.object, depth + 1);
        if (object === undefined || (typeof object.value !== 'string' && !Array.isArray(object.value))) return undefined;
        const key = e.computed ? this.evaluate(e.property, depth + 1)?.value : propertyName(e);
        const target = object.value as string | readonly unknown[];
        if (key === 'length') return { value: target.length };
        if (typeof key === 'number') return { value: target[key] };
        return undefined;
      }
      case 'CallExpression': {
        const callee = unwrap(e.callee);
        const method = propertyName(callee);
        if (method === null || !['slice', 'includes', 'indexOf', 'at', 'startsWith', 'endsWith'].includes(method)) return undefined;
        const object = this.evaluate(callee.object, depth + 1);
        if (object === undefined || (typeof object.value !== 'string' && !Array.isArray(object.value))) return undefined;
        const args: unknown[] = [];
        for (const a of e.arguments) {
          const v = this.evaluate(a, depth + 1);
          if (v === undefined) return undefined;
          args.push(v.value);
        }
        const target = object.value as unknown as Record<string, (...a: unknown[]) => unknown>;
        return { value: target[method](...args) };
      }
      case 'UnaryExpression': {
        if (e.operator === 'void') return { value: undefined };
        if (e.operator !== '!') return undefined;
        const v = this.evaluate(e.argument, depth + 1);
        return v === undefined ? undefined : { value: !v.value };
      }
      case 'BinaryExpression': {
        // `require.main === module`: true for the entry, false for a module it loads.
        const mainTest = (a: AstNode, b: AstNode) => isNamed(a, 'require', 'main')
          && unwrap(b).type === 'Identifier' && unwrap(b).name === 'module';
        if (mainTest(e.left, e.right) || mainTest(e.right, e.left)) {
          if (e.operator === '===' || e.operator === '==') return { value: this.record.entry };
          if (e.operator === '!==' || e.operator === '!=') return { value: !this.record.entry };
          return undefined;
        }
        const left = this.evaluate(e.left, depth + 1);
        const right = left && this.evaluate(e.right, depth + 1);
        if (left === undefined || right === undefined) return undefined;
        const [l, r] = [left.value, right.value] as [never, never];
        // Loose equality is strict equality between values of one type, and
        // null equals undefined; anything else is not judged.
        const loose = (l === null || l === undefined) && (r === null || r === undefined) ? true
          : typeof l === typeof r ? l === r : undefined;
        switch (e.operator) {
          case '===': return { value: l === r };
          case '!==': return { value: l !== r };
          case '==': return loose === undefined ? undefined : { value: loose };
          case '!=': return loose === undefined ? undefined : { value: !loose };
          case '<': return { value: l < r };
          case '<=': return { value: l <= r };
          case '>': return { value: l > r };
          case '>=': return { value: l >= r };
          default: return undefined;
        }
      }
      case 'LogicalExpression': {
        const left = this.evaluate(e.left, depth + 1);
        if (left === undefined) return undefined;
        if (e.operator === '&&') return left.value ? this.evaluate(e.right, depth + 1) : left;
        if (e.operator === '||') return left.value ? left : this.evaluate(e.right, depth + 1);
        return left.value == null ? this.evaluate(e.right, depth + 1) : left;
      }
      case 'ConditionalExpression': {
        const test = this.evaluate(e.test, depth + 1);
        if (test === undefined) return undefined;
        return this.evaluate(test.value ? e.consequent : e.alternate, depth + 1);
      }
      default:
        return undefined;
    }
  }
}
