/**
 * module-requests.ts — the modules a parsed module asks for, and how.
 *
 * One analysis over an ESTree program, whichever parser produced it: the
 * import() prefetch's (moduleRequests, over this interpreter's parser) and
 * the supervisor's walk (core/runtime/require-resolver.ts
 * require-wrappers.ts requireWrapperCalls, over acorn) read the same calls with it. It reaches
 * nodes only through the interpreter's captured intrinsics, as the rest of
 * the interpreter does (intrinsics.ts), since the prefetch runs it in the
 * program's realm.
 */
import { SafeWeakMap, arrayIsArray, objectCreate, objectKeys, reflectGet } from './intrinsics.js';

/**
 * One module a module's text asks for, and how: `static` (an import or
 * export-from declaration), `dynamic` (import()) or `require`. The kind
 * decides the resolution, as the loader makes it: a static import is
 * evaluated through the module's scoped require (modules.ts), so it resolves
 * under require's conditions; import() resolves under import's.
 */
export interface ModuleRequest {
  readonly specifier: string;
  readonly kind: 'static' | 'dynamic' | 'require';
}

/** A string literal, or a template with no substitutions: the specifier a request spells. */
function spelledString(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const type = reflectGet(node, 'type');
  if (type === 'Literal') {
    const value = reflectGet(node, 'value');
    return typeof value === 'string' ? value : undefined;
  }
  if (type !== 'TemplateLiteral') return undefined;
  const expressions = reflectGet(node, 'expressions');
  const quasis = reflectGet(node, 'quasis');
  if (!arrayIsArray(expressions) || expressions.length !== 0 || !arrayIsArray(quasis) || quasis.length !== 1) return undefined;
  const value = reflectGet(quasis[0], 'value');
  const cooked = typeof value === 'object' && value !== null ? reflectGet(value, 'cooked') : undefined;
  return typeof cooked === 'string' ? cooked : undefined;
}

/** An Identifier's name, else undefined. */
function identifierName(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null || reflectGet(node, 'type') !== 'Identifier') return undefined;
  const name = reflectGet(node, 'name');
  return typeof name === 'string' ? name : undefined;
}

/** `createRequire(…)` or `<x>.createRequire(…)`: a require of its own. */
function makesRequire(node: unknown): boolean {
  if (typeof node !== 'object' || node === null || reflectGet(node, 'type') !== 'CallExpression') return false;
  const callee = reflectGet(node, 'callee');
  if (identifierName(callee) === 'createRequire') return true;
  return typeof callee === 'object' && callee !== null && reflectGet(callee, 'type') === 'MemberExpression'
    && reflectGet(callee, 'computed') !== true && identifierName(reflectGet(callee, 'property')) === 'createRequire';
}

/** A function's first parameter, when it is a name (with or without a default). */
function firstParameter(fn: unknown): string | undefined {
  if (typeof fn !== 'object' || fn === null) return undefined;
  const type = reflectGet(fn, 'type');
  if (type !== 'FunctionDeclaration' && type !== 'FunctionExpression' && type !== 'ArrowFunctionExpression') return undefined;
  const params = reflectGet(fn, 'params');
  if (!arrayIsArray(params) || params.length === 0) return undefined;
  const first = params[0];
  if (typeof first === 'object' && first !== null && reflectGet(first, 'type') === 'AssignmentPattern') return identifierName(reflectGet(first, 'left'));
  return identifierName(first);
}

/**
 * The require a call makes, by its callee: `x(…)` is x's, `x.resolve(…)` is
 * x's too (it resolves as x loads). Undefined for any other callee.
 */
function requireCallee(callee: unknown): string | undefined {
  const name = identifierName(callee);
  if (name !== undefined) return name;
  if (typeof callee !== 'object' || callee === null || reflectGet(callee, 'type') !== 'MemberExpression') return undefined;
  if (reflectGet(callee, 'computed') === true || identifierName(reflectGet(callee, 'property')) !== 'resolve') return undefined;
  return identifierName(reflectGet(callee, 'object'));
}

/** A node's numeric `start` or `end`, else -1. */
function offset(node: unknown, key: 'start' | 'end'): number {
  if (typeof node !== 'object' || node === null) return -1;
  const at = reflectGet(node, key);
  return typeof at === 'number' ? at : -1;
}

/** A function's first parameter, and the requires its body passes it to first (callee names). */
interface FunctionFacts {
  readonly param: string;
  readonly passedTo: string[];
}

/**
 * The modules a program asks for, read node by node in post-order (each
 * node after its children), as acorn finishes them: a whole tree walked so
 * (programRequests), or a parse that keeps no tree of the program
 * (core/runtime/require-wrappers.ts, parseStatements' onNode). Nothing it
 * keeps refers to a node once that node's parent is read, so a parse that
 * drops each statement as it goes holds no more than it would.
 */
export class RequestCollector {
  private readonly requests: ModuleRequest[] = [];
  // The requires createRequire made, by the name bound to one.
  private readonly made: Record<string, true> = objectCreate(null);
  // Calls of a require-like callee (`r(x`, `r.resolve(x`) with a name first, by that name: the callee and where.
  private readonly passed: Record<string, { callee: string; at: number }[]> = objectCreate(null);
  // Each function node with a named first parameter, until its binding (a declarator or an assignment) is read.
  private readonly functions = new SafeWeakMap<object, FunctionFacts>();
  // Named functions with a named first parameter.
  private readonly candidates: { name: string; facts: FunctionFacts }[] = [];
  // Calls of a name (other than require) with a string first.
  private readonly calls: { callee: string; specifier: string }[] = [];

  private add(specifier: string | undefined, kind: ModuleRequest['kind']): void {
    if (specifier !== undefined) this.requests[this.requests.length] = { specifier, kind };
  }

  private candidate(name: string | undefined, fn: unknown): void {
    if (name === undefined || typeof fn !== 'object' || fn === null) return;
    const facts = this.functions.get(fn);
    if (facts !== undefined) this.candidates[this.candidates.length] = { name, facts };
  }

  /** Read `node`, every one of whose children has been read. */
  visit(node: unknown): void {
    if (typeof node !== 'object' || node === null) return;
    const type = reflectGet(node, 'type');
    if (type === 'ImportDeclaration' || type === 'ExportAllDeclaration' || type === 'ExportNamedDeclaration') {
      this.add(spelledString(reflectGet(node, 'source')), 'static');
    } else if (type === 'ImportExpression') {
      this.add(spelledString(reflectGet(node, 'source')), 'dynamic');
    } else if (type === 'CallExpression') {
      const callee = reflectGet(node, 'callee');
      const args = reflectGet(node, 'arguments');
      if (arrayIsArray(args) && args.length > 0) {
        const name = identifierName(callee);
        const specifier = spelledString(args[0]);
        if (name === 'require') this.add(specifier, 'require');
        else if (name !== undefined && specifier !== undefined) this.calls[this.calls.length] = { callee: name, specifier };
        const from = requireCallee(callee);
        const param = identifierName(args[0]);
        if (from !== undefined && param !== undefined) {
          const list = this.passed[param] ?? (this.passed[param] = []);
          list[list.length] = { callee: from, at: offset(node, 'start') };
        }
      }
    } else if (type === 'FunctionDeclaration' || type === 'FunctionExpression' || type === 'ArrowFunctionExpression') {
      const param = firstParameter(node);
      if (param !== undefined) {
        // What its body (its calls are read by now) passes the parameter to first.
        const body = reflectGet(node, 'body');
        const from = offset(body, 'start'), to = offset(body, 'end');
        const passedTo: string[] = [];
        const list = this.passed[param];
        if (list !== undefined) {
          for (let i = 0; i < list.length; i++) if (list[i].at >= from && list[i].at < to) passedTo[passedTo.length] = list[i].callee;
        }
        const facts: FunctionFacts = { param, passedTo };
        this.functions.set(node, facts);
        if (type === 'FunctionDeclaration') this.candidate(identifierName(reflectGet(node, 'id')), node);
      }
    } else if (type === 'VariableDeclarator') {
      const name = identifierName(reflectGet(node, 'id'));
      const init = reflectGet(node, 'init');
      if (name !== undefined && makesRequire(init)) this.made[name] = true;
      this.candidate(name, init);
    } else if (type === 'AssignmentExpression') {
      if (reflectGet(node, 'operator') === '=') this.candidate(identifierName(reflectGet(node, 'left')), reflectGet(node, 'right'));
    }
  }

  /** The requests, once every node is read: the program's, and the specifiers a require wrapper's calls name. */
  finish(): { requests: ModuleRequest[]; wrapperCalls: string[] } {
    const isRequire = (name: string) => name === 'require' || this.made[name] === true;
    const wrappers: Record<string, true> = objectCreate(null);
    for (let i = 0; i < this.candidates.length; i++) {
      const { name, facts } = this.candidates[i];
      if (isRequire(name)) continue;
      for (let j = 0; j < facts.passedTo.length; j++) {
        if (isRequire(facts.passedTo[j])) { wrappers[name] = true; break; }
      }
    }
    const wrapperCalls: string[] = [];
    for (let i = 0; i < this.calls.length; i++) {
      const call = this.calls[i];
      if (wrappers[call.callee] === true) wrapperCalls[wrapperCalls.length] = call.specifier;
      if (this.made[call.callee] === true || wrappers[call.callee] === true) this.add(call.specifier, 'require');
    }
    return { requests: this.requests, wrapperCalls };
  }
}

/** `program` read whole, in post-order. */
function collect(program: unknown): RequestCollector {
  const collector = new RequestCollector();
  // Each entry is a node and whether its children are on the stack already.
  const pending: { node: unknown; expanded: boolean }[] = [{ node: program, expanded: false }];
  while (pending.length > 0) {
    const top = pending[pending.length - 1];
    const node = top.node;
    if (top.expanded || typeof node !== 'object' || node === null) {
      pending.length -= 1;
      if (top.expanded) collector.visit(node);
      continue;
    }
    top.expanded = true;
    if (arrayIsArray(node)) {
      pending.length -= 1;
      for (let i = node.length - 1; i >= 0; i--) pending[pending.length] = { node: node[i], expanded: false };
      continue;
    }
    const type = reflectGet(node, 'type');
    if (typeof type !== 'string') { pending.length -= 1; continue; }
    const keys = objectKeys(node);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      // A literal's or template element's value is data; elsewhere `value` holds a node (a property's).
      if ((key === 'value' || key === 'regex') && (type === 'Literal' || type === 'TemplateElement')) continue;
      pending[pending.length] = { node: reflectGet(node, key), expanded: false };
    }
  }
  return collector;
}

/**
 * The modules a parsed module asks for: import and export-from sources,
 * `import()` of a string, and `require()` of a string: any call of a
 * `require` binding, the module's own or one createRequire made, by any
 * name. A call of a require wrapper with a string asks for it too: a
 * function whose own body passes its first parameter to such a require, or
 * to its `.resolve` (@vitejs/plugin-vue's `tryRequire(id, from)`, which
 * loads the project's vue/compiler-sfc as `tryRequire("vue/compiler-sfc",
 * root)`). A specifier spelled with escapes or in a template is read as the
 * language reads it; one in a comment or a string is not a request.
 */
export function programRequests(program: unknown): ModuleRequest[] {
  return collect(program).finish().requests;
}

/** Of programRequests, the specifiers a require wrapper's calls name, each once. */
export function programWrapperCalls(program: unknown): string[] {
  return uniqueSpecifiers(collect(program).finish().wrapperCalls);
}

/** `specifiers`, each once, in order. */
export function uniqueSpecifiers(specifiers: readonly string[]): string[] {
  const seen: Record<string, true> = objectCreate(null);
  const unique: string[] = [];
  for (let i = 0; i < specifiers.length; i++) {
    if (seen[specifiers[i]] === true) continue;
    seen[specifiers[i]] = true;
    unique[unique.length] = specifiers[i];
  }
  return unique;
}
