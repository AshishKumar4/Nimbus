/**
 * The interpreter for code a program produces after its launch.
 *
 * A Worker compiles code only from the module map it was launched with, so
 * text handed to a Function constructor, or a module file written while the
 * program runs, cannot be compiled natively in that launch (see RUNTIME CODE
 * in _shared/commonjs-cell.ts, which records such code so the next launch
 * compiles it into its map). This runs it in the meantime, in the same realm
 * as the program: values, objects, prototypes and functions are the
 * program's own, never copies or proxies.
 *
 * The code is parsed once (acorn, bundled to reach only the built-ins the
 * launch captured at its start: parser-realm.ts), analyzed once (scope.ts)
 * and compiled once into closures (compile.ts); calling an interpreted
 * function runs those closures. host-ops.ts supplies the operators and the
 * native function objects interpreted functions are.
 *
 * Not supported, refused with UnsupportedSyntax before any of the code runs:
 * `using` declarations, TypeScript and JSX, and the bodies of `with`
 * statements in strict code (a SyntaxError anyway). A direct `eval(...)` is
 * an ordinary call of the global eval, which a Worker refuses at request time
 * natively too.
 */
import { Parser, parse, tokTypes, type FunctionExpression, type Options, type Program } from 'acorn';
import {
  type SourceRealm, expressionFunctionBody, parseRuntimeFunction, runtimeFunctionSource, type RuntimeFunctionKind,
  scriptExpression,
} from '../_shared/runtime-function-source.js';
import { Compiler, type UnitContext, type UnitHost } from './compile.js';
import { type ModuleCell, moduleCell } from './modules.js';
import type { HostOps, NativeFunction } from './host-ops.js';
import { ROOT_ENV, frameTemplate, installHost, isObject, makeFunction } from './runtime.js';
import { type FunctionScope, analyzeCommonJs, analyzeFunction, analyzeProgram, releaseScopes } from './scope.js';
import { type Owned, ownFunctionExpression, ownProgram } from './tree.js';
import { own } from './parser-realm.js';
import {
  Error, LAUNCH_PRIMORDIALS, SafeMap, SyntaxError, charCodeAt, isWhitespaceCode, objectCreate, objectKeys,
  reflectGet, reflectGetOwnPropertyDescriptor, reflectSet, someItem, stringLastIndexOf, stringOf, stringSlice, withElement,
} from './intrinsics.js';
import { UnsupportedSyntax } from './unsupported.js';
import { type ModuleRequest, programRequests } from './module-requests.js';
import type { AcornParser } from '../runtime/javascript-ast.js';

export type { HostOps } from './host-ops.js';
export { INTERPRETER_UNSUPPORTED, UnsupportedSyntax } from './unsupported.js';
export { replLineBody } from './repl-line.js';
export type { ModuleCell } from './modules.js';
export type { ModuleRequest } from './module-requests.js';

export interface InterpreterHost {
  /** `import(specifier, options)` from code whose module URL is `parentUrl`, for code compiled without an origin. */
  dynamicImport(parentUrl: string | undefined, specifier: unknown, options: unknown): Promise<unknown>;
  /**
   * LAUNCH_PRIMORDIALS of the primordials module the launch loaded at its
   * start: the interpreter must have loaded that same module, not a second
   * evaluation of it, which would capture what the program has replaced.
   */
  readonly primordials: object;
}

/**
 * Where compiled code comes from (commonjs-cell.ts, RUNTIME CODE): what its
 * import() calls, and the `Function` its free `Function` binding starts as.
 * An origin without a `Function` gives its code the global's, as code
 * compiled without an origin has; that code imports through the host
 * against its own module URL (none for a constructor's).
 */
export interface CodeOrigin {
  import(specifier: unknown, options: unknown): Promise<unknown>;
  /** Undefined, as an own property, for an origin without one. */
  readonly Function: unknown;
}

export interface Interpreter {
  /** The function `new <kind>Function(...params, body)` builds, from `origin`. */
  compileFunction(kind: RuntimeFunctionKind, params: readonly string[], body: string, origin?: CodeOrigin): NativeFunction;
  /**
   * The module cell for a file's text: Node's wrapper function of
   * (exports, require, module, __filename, __dirname). CommonJS text runs as
   * that function's body; an ES module as esbuild lowers it to one.
   */
  compileModule(path: string, text: string, origin?: CodeOrigin): ModuleCell;
  /**
   * A function returning the value of the script `code` when it is one
   * expression (scriptExpression): vm.runInThisContext's code, as node-shims
   * hands it over and calls it, with the global object as `this` (a script's
   * `this` at its top level). Code of any other shape is refused
   * (UnsupportedSyntax).
   */
  compileExpression(code: string, origin?: CodeOrigin): NativeFunction;
  /** Run a script at global scope: its vars and functions become global object properties. */
  runScript(text: string): void;
}

/** The parameters of Node's CommonJS module wrapper. */
const WRAPPER_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'] as const;

/** Extensions whose text is not JavaScript acorn can parse. */
const UNPARSED_EXTENSIONS: Record<string, true> = { '.ts': true, '.mts': true, '.cts': true, '.tsx': true, '.jsx': true };

// What the parser is given inherits nothing: it reads one option directly (parser-realm.ts).
const MODULE_OPTIONS: Options = own({ ecmaVersion: 'latest', allowHashBang: true, sourceType: 'module' });
const COMMONJS_OPTIONS: Options = own({ ecmaVersion: 'latest', allowHashBang: true, sourceType: 'script', allowReturnOutsideFunction: true });
const SCRIPT_OPTIONS: Options = own({ ecmaVersion: 'latest', allowHashBang: true, sourceType: 'script' });

function extensionOf(path: string): string {
  const base = stringSlice(path, stringLastIndexOf(path, '/') + 1);
  const dot = stringLastIndexOf(base, '.');
  return dot > 0 ? stringSlice(base, dot) : '';
}

/**
 * `text` without its trailing `//` comment lines (and blank lines): what
 * acorn parses. A transformer's inline source map is such a line, usually
 * most of the text (Vite's SSR modules: 3.9 of 5.2 MB in an Astro render),
 * and acorn scans a comment character by character. Dropping trailing
 * comments changes nothing a program can observe, and the cut cannot land
 * inside a string, template or block comment: those would then be
 * unterminated, the shortened text would not parse, and the caller parses
 * the whole text instead.
 */
function withoutTrailingLineComments(text: string): string {
  let end = text.length;
  for (;;) {
    let last = end;
    while (last > 0 && isWhitespaceCode(charCodeAt(text, last - 1))) last--;
    const lineStart = stringLastIndexOf(text, '\n', last - 1) + 1;
    let first = lineStart;
    while (first < last && isWhitespaceCode(charCodeAt(text, first))) first++;
    const comment = first + 1 < last && charCodeAt(text, first) === 0x2f && charCodeAt(text, first + 1) === 0x2f;
    if (lineStart === 0 || !comment) return end === text.length ? text : stringSlice(text, 0, end);
    end = lineStart - 1;
  }
}

/** Parse `text` without its trailing line comments, or whole when that does not parse. */
function parseQuick(text: string, options: Options): Program {
  const short = withoutTrailingLineComments(text);
  if (short !== text) {
    try {
      return parse(short, options);
    } catch {
      // The comment was not a comment; the whole text decides.
    }
  }
  return parse(text, options);
}

/** The number of '/' characters `path` starts with. */
function leadingSlashes(path: string): number {
  let i = 0;
  while (i < path.length && charCodeAt(path, i) === 0x2f) i++;
  return i;
}

/**
 * The modules a file's text asks for, as this parser reads it
 * (module-requests.ts programRequests: imports, import() and require() of a
 * string, a createRequire binding's calls, and a require wrapper's). Text the
 * parser cannot read (TypeScript, JSX, a syntax error) asks for nothing. The
 * import() prefetch (node-shims.ts) finds what to fetch with it.
 */
export function moduleRequests(path: string, text: string): ModuleRequest[] {
  if (UNPARSED_EXTENSIONS[extensionOf(path)]) return [];
  let program: Program;
  try {
    program = parseQuick(text, MODULE_OPTIONS);
  } catch {
    try {
      program = parseQuick(text, COMMONJS_OPTIONS);
    } catch {
      return [];
    }
  }
  return programRequests(program);
}

interface BlockParser extends AcornParser {
  strict: boolean;
  startNode(): object;
  expect(type: unknown): void;
  enterScope(flags: number): void;
  exitScope(): void;
}
const AcornParserClass = Parser as unknown as new (options: Options, input: string) => BlockParser;
const FOUND = objectCreate(null);

/**
 * acorn keeping no statement once parsed, at the top level or in a block (a
 * fatal error may come from a multi-MiB bundle, and acorn's tree is 17 to 24
 * times its source): what is held is the chain of open nodes. It stops at the
 * innermost throw whose argument holds `offset`, which finishes before any
 * throw around it.
 */
class ThrowFinder extends AcornParserClass {
  offset = -1;
  found: [number, number] | null = null;

  parseTopLevel(node: Program): Program {
    const exports = objectCreate(null);
    while (this.type !== tokTypes.eof) this.parseStatement(null, true, exports);
    if (this.inModule) {
      const names = objectKeys(this.undefinedExports);
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        this.raiseRecoverable(this.undefinedExports[name].start, "Export '" + name + "' is not defined");
      }
    }
    this.next();
    return this.finishNode(node, 'Program');
  }

  parseBlock(createNewLexicalScope = true, node = this.startNode(), exitStrict = false): object {
    reflectSet(node, 'body', []);
    this.expect(tokTypes.braceL);
    if (createNewLexicalScope) this.enterScope(0);
    while (this.type !== tokTypes.braceR) this.parseStatement(null);
    if (exitStrict) this.strict = false;
    this.next();
    if (createNewLexicalScope) this.exitScope();
    return this.finishNode(node, 'BlockStatement');
  }

  finishNode<T>(node: T, type: string): T {
    const finished = super.finishNode(node, type);
    if (type === 'ThrowStatement') {
      const argument = reflectGet(finished as object, 'argument') as object;
      if (this.offset >= (reflectGet(argument, 'start') as number) && this.offset < (reflectGet(finished as object, 'end') as number)) {
        const start = reflectGet(finished as object, 'start') as number;
        this.found = [start, start + 1];
        throw FOUND;
      }
    }
    return finished;
  }
}

/**
 * Where V8 would place a fatal error's report in `text`, a module's whole
 * text (a `{ cjs }` cell's wrapper included) as `goal` parses it, for the
 * process's fatal report (node-shims.ts __nimbusFatalArrow), which has a
 * frame's offset and not V8's message:
 *   - `offset` given: the innermost `throw` statement whose argument holds
 *     it, as [start, start + 1], V8's location of a throw; null for none;
 *   - `offset` -1: the syntax error that stops the parse, as [start, end]
 *     of the token it stops at; null when the text parses.
 */
export function fatalLocation(text: string, goal: 'script' | 'module', offset: number): [number, number] | null {
  const finder = new ThrowFinder(goal === 'module' ? MODULE_OPTIONS : COMMONJS_OPTIONS, text);
  finder.offset = offset;
  try {
    finder.parse();
  } catch (error) {
    if (error === FOUND) return finder.found;
    if (offset !== -1 || !isObject(error)) return null;
    const at = reflectGet(error, 'pos');
    const end = reflectGet(error, 'raisedAt');
    if (typeof at !== 'number') return null;
    return [at, typeof end === 'number' && end > at ? end : at + 1];
  }
  return null;
}

/** Whether a module's top level has import or export declarations. */
function hasModuleSyntax(program: Program): boolean {
  return someItem(program.body, (s) => s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration'
    || s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration');
}

/** The interpreter's own built-ins, for the checks it shares with commonjs-cell.ts. */
const REALM: SourceRealm = {
  SyntaxError,
  scriptOptions: own({ ecmaVersion: 'latest', sourceType: 'script' }),
  messageOf(error) {
    const message = isObject(error) ? reflectGet(error, 'message') : undefined;
    return typeof message === 'string' ? message : stringOf(error);
  },
};

let installed: HostOps | null = null;

function unitContext(source: string, module: boolean, host: UnitHost, moduleScope: FunctionScope | null): UnitContext {
  return { source, module, host, imports: new SafeMap(), moduleScope };
}

/** A unit's host: `origin`'s import() and `Function` binding, or else the host's import() against `parentUrl` and the global `Function`. */
function unitHost(host: InterpreterHost, origin: CodeOrigin | undefined, parentUrl: string | undefined): UnitHost {
  if (origin === undefined) {
    return { dynamicImport: (specifier, options) => host.dynamicImport(parentUrl, specifier, options), functionBinding: null };
  }
  // Its own property only: an origin without a Function must not take one a program put on Object.prototype.
  const own = reflectGetOwnPropertyDescriptor(origin, 'Function');
  return {
    dynamicImport: (specifier, options) => origin.import(specifier, options),
    functionBinding: own === undefined || own.value === undefined ? null : { value: own.value },
  };
}

export function createInterpreter(hostOps: HostOps, host: InterpreterHost): Interpreter {
  if (host.primordials !== LAUNCH_PRIMORDIALS) throw new Error('interpreter: its built-ins were not captured at the launch start');
  if (installed !== hostOps) {
    installHost(hostOps);
    installed = hostOps;
  }
  const interpreter: Interpreter = {
    compileFunction(kind, params, body, origin) {
      // A trailing source map is parsed only when the shortened body fails.
      const short = withoutTrailingLineComments(body);
      let parsed: { readonly node: FunctionExpression; readonly text: string };
      try {
        parsed = parseRuntimeFunction(kind, params, short, REALM);
      } catch (error) {
        if (short === body) throw error;
        parsed = parseRuntimeFunction(kind, params, body, REALM);
      }
      const text = parsed.text;
      const node = ownFunctionExpression(parsed.node);
      const analysis = analyzeFunction(node);
      const root = analysis.functionScopeOf(node);
      const unit = unitContext(text, false, unitHost(host, origin, undefined), null);
      const fi = new Compiler(analysis, unit, text, 0, root).rootFunction(node, 'anonymous', runtimeFunctionSource(kind, params, body));
      releaseScopes(root);
      return makeFunction(fi, ROOT_ENV, undefined);
    },

    compileModule(path, text, origin) {
      if (UNPARSED_EXTENSIONS[extensionOf(path)]) throw new UnsupportedSyntax(`${extensionOf(path)} source`);
      const parentUrl = stringSlice(path, 0, 5) === 'data:' ? 'data:text/javascript,' : `file:///${stringSlice(path, leadingSlashes(path))}`;
      const moduleHost = unitHost(host, origin, parentUrl);
      const compileCell = (program: Owned<Program>): ModuleCell => {
        const analysis = analyzeProgram(program, { kind: 'module', strict: true });
        const root = analysis.functionScopeOf(program);
        const cell = moduleCell(new Compiler(analysis, unitContext(text, true, moduleHost, root), text, 0, root).modulePlan(program, root));
        releaseScopes(root);
        return cell;
      };
      let module: Owned<Program> | null = null;
      try {
        module = ownProgram(parseQuick(text, MODULE_OPTIONS));
      } catch {
        // Not a module (sloppy-only syntax, a top-level return): CommonJS below.
      }
      if (module !== null && hasModuleSyntax(module)) return compileCell(module);
      let script: Owned<Program>;
      try {
        script = ownProgram(parseQuick(text, COMMONJS_OPTIONS));
      } catch (error) {
        // Top-level await or import.meta without imports or exports: still a module.
        if (module === null) throw error;
        return compileCell(module);
      }
      const analysis = analyzeCommonJs(script, WRAPPER_PARAMS);
      const root = analysis.functionScopeOf(script);
      const fi = new Compiler(analysis, unitContext(text, false, moduleHost, null), text, 0, root).commonJsFunction(script, root, WRAPPER_PARAMS);
      releaseScopes(root);
      // Called as the loader calls a staged cell, so `this` matches the next launch's.
      return makeFunction(fi, ROOT_ENV, undefined);
    },

    compileExpression(code, origin) {
      const at = scriptExpression(code, REALM);
      if (at === null) throw new UnsupportedSyntax('a vm script that is not one expression');
      const body = expressionFunctionBody(stringSlice(code, 0, at.prologueEnd), stringSlice(code, at.start, at.end));
      return interpreter.compileFunction('function', [], body, origin);
    },

    runScript(text) {
      const program = ownProgram(parse(text, SCRIPT_OPTIONS));
      const analysis = analyzeProgram(program, { kind: 'script', strict: false });
      const root = analysis.functionScopeOf(program);
      const unit = unitContext(text, false, unitHost(host, undefined, undefined), null);
      const body = new Compiler(analysis, unit, text, 0, root).programBody(program, root);
      releaseScopes(root);
      if (body.g !== null) throw new UnsupportedSyntax('await in a script');
      body.s(withElement(frameTemplate(root.size, []), 0, ROOT_ENV));
    },
  };
  return interpreter;
}
