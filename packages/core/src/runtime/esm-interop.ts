/**
 * Node's ES module / CommonJS interop for ES modules Nimbus lowers to
 * CommonJS cells (https://nodejs.org/api/esm.html#commonjs-namespaces,
 * https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require):
 *
 *   - an ES module importing CommonJS gets `module.exports` as its default
 *     export, whether or not the exports carry `__esModule`, and its names
 *     (with `__esModule`) as named exports;
 *   - an ES module importing an ES module gets that module's namespace;
 *   - require(esm) returns the namespace, with an enumerable
 *     `__esModule: true` added only when the module has a default export.
 *
 * Every import is a `require` of another cell here, so the two cases are told
 * apart by a marker the lowering puts on an ES module's exports object:
 * `Symbol.for(ESM_NAMESPACE_KEY)`, whose value is the namespace an importer
 * sees — never by `__esModule`, which CommonJS compiled by TypeScript or
 * Babel sets too. esbuild's CommonJS output uses Babel's rule in `__toESM`
 * and marks every module in `__toCommonJS`; `nodeInterop` replaces the two
 * helper definitions with Node's rule and the marker. The other lowerings
 * (async-module-lowering.ts, esbuild-service.ts's bounded bundle rewrite, and
 * the process's ESM loader in node-shims.ts) read and write the same marker.
 */
import { Parser, tokTypes, type Node } from 'acorn';

export const ESM_NAMESPACE_KEY = 'nimbus.esm.namespace';
const MARK = `Symbol.for(${JSON.stringify(ESM_NAMESPACE_KEY)})`;

/** An expression: is `value` a lowered ES module's exports object? */
export function isEsmNamespaceSource(value: string): string {
  return `(${value} != null && typeof ${value}[${MARK}] === "object")`;
}

/**
 * Statements marking `target`, the exports object of a lowering that assigns
 * its exports as the module runs, as a lowered ES module's: its namespace is
 * the object itself, and `__esModule` is added (not enumerable, so a
 * namespace import does not list it) when the module exports a default.
 */
export function markEsmNamespaceSource(target: string, exportsDefault: boolean): string {
  return `Object.defineProperty(${target}, ${MARK}, { value: ${target} });`
    + (exportsDefault ? ` Object.defineProperty(${target}, "__esModule", { value: true, configurable: true });` : '');
}

// The named exports Node gives CommonJS `m`: its own enumerable names, and
// `__esModule` however it was defined (cjs-module-lexer detects
// `Object.defineProperty(exports, "__esModule", …)`). Namespace names are
// enumerable.
const cjsNamesSource = (m: string) => `Object.keys(${m}).concat(Object.prototype.hasOwnProperty.call(${m}, "__esModule")`
  + ` && !Object.prototype.propertyIsEnumerable.call(${m}, "__esModule") ? ["__esModule"] : [])`;

/**
 * A declaration of `name(exports)`: the namespace an import of those exports
 * sees. A lowered ES module's is its marker's; CommonJS gets module.exports as
 * `default` and its names, live.
 */
export function namespaceHelperSource(name: string): string {
  return `const ${name} = (m) => { if (${isEsmNamespaceSource('m')}) return m[${MARK}]; const ns = { default: m };`
    + ` if (m && typeof m === "object" || typeof m === "function") for (const k of ${cjsNamesSource('m')}) if (k !== "default") Object.defineProperty(ns, k, { get: () => m[k], enumerable: true });`
    + ' return ns; };';
}

// Self-contained: esbuild renames its helpers (`__toESM2`) when the module
// declares the same names. Each copies properties as live getters, as
// esbuild's __copyProps does. Node's rule for CommonJS is esbuild's own
// "node mode". __toCommonJS runs once esbuild's `__export` has defined every
// export, so it can build both objects: the namespace an importer sees, and
// — when there is a default — the require(esm) result with `__esModule`.
const TO_ESM = `(mod, isNodeMode, target) => { if (${isEsmNamespaceSource('mod')}) return mod[${MARK}];`
  + ' target = mod != null ? Object.create(Object.getPrototypeOf(mod)) : {};'
  + ' Object.defineProperty(target, "default", { value: mod, enumerable: true });'
  + ` if (mod && typeof mod === "object" || typeof mod === "function") for (const key of ${cjsNamesSource('mod')})`
  + ' if (!Object.prototype.hasOwnProperty.call(target, key)) Object.defineProperty(target, key, { get: () => mod[key], enumerable: true });'
  + ' return target; }';
const TO_COMMON_JS = '(mod, target) => { const names = Object.getOwnPropertyNames(mod);'
  + ' const view = (object) => { for (const key of names) Object.defineProperty(object, key, { get: () => mod[key], enumerable: true }); return object; };'
  + ` const ns = view({}); Object.defineProperty(ns, ${MARK}, { value: ns });`
  + ' if (!names.includes("default")) return ns;'
  + ` target = view(Object.defineProperty({}, ${MARK}, { value: ns }));`
  + ' Object.defineProperty(target, "__esModule", { value: true, enumerable: true });'
  + ' return target; }';
const HELPER = /^(__toESM|__toCommonJS)\d*$/;
const REPLACEMENTS: Record<string, string> = { __toESM: TO_ESM, __toCommonJS: TO_COMMON_JS };

/**
 * esbuild's CommonJS output with its interop helpers replaced by Node's rule.
 * esbuild prints its runtime helpers first, as top-level `var` declarations,
 * so only that prologue is parsed: parsing stops at the first statement that
 * declares no `__`-prefixed helper, and the rest of the module is never read.
 */
export function nodeInterop(cjs: string): string {
  if (!cjs.includes('__toESM') && !cjs.includes('__toCommonJS')) return cjs;
  const edits: { start: number; end: number; text: string }[] = [];
  try {
    // Acorn's statement-at-a-time API (the one its plugins extend).
    const parser: object = Reflect.construct(Parser, [
      { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true }, cjs,
    ]);
    Reflect.apply(Reflect.get(parser, 'nextToken'), parser, []);
    const parseStatement = Reflect.get(parser, 'parseStatement');
    while (Reflect.get(parser, 'type') !== tokTypes.eof && edits.length < 2) {
      const statement: Node = Reflect.apply(parseStatement, parser, [null, true, Object.create(null)]);
      if (statement.type === 'ExpressionStatement' && Reflect.get(statement, 'directive') !== undefined) continue;
      if (statement.type !== 'VariableDeclaration') break;
      const declarators = Reflect.get(statement, 'declarations') as Node[];
      let helpers = false;
      for (const declarator of declarators) {
        const id = Reflect.get(declarator, 'id') as Node;
        const name = id.type === 'Identifier' ? String(Reflect.get(id, 'name')) : '';
        if (!name.startsWith('__')) continue;
        helpers = true;
        const init = Reflect.get(declarator, 'init') as Node | null;
        const helper = HELPER.exec(name);
        if (init && helper) edits.push({ start: init.start, end: init.end, text: REPLACEMENTS[helper[1]] });
      }
      if (!helpers) break;
    }
  } catch {
    // Not esbuild output it can read: left for the compiler to judge.
    return cjs;
  }
  if (edits.length === 0) return cjs;
  let out = '';
  let at = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    out += cjs.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + cjs.slice(at);
}
