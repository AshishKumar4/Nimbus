/**
 * compiled-fn.ts — how a CommonJS module cell becomes a function.
 *
 * Every facet compiles its module cells with `new Function(exports, require,
 * module, __filename, __dirname, code)`. A module that itself declares one
 * of those names at top level — esbuild's CJS emit of an ESM file that had
 * `const __dirname = …` or `const require = createRequire(import.meta.url)`
 * — collides with the parameter, which is a SyntaxError ("Identifier
 * 'require' has already been declared"). The parameter is then renamed so
 * the body's own binding wins; slots stay aligned because every caller
 * passes five positional arguments.
 *
 * The collision is detected by compiling, not by scanning: a regex over the
 * source matched `const require = …` inside a template literal (vite's
 * config chunk carries one as text) and renamed a parameter the module never
 * declared, so every transformed import's `require(...)` was undefined.
 * Only the parser knows what a module declares.
 *
 * One definition, embedded by both facet generators (facets/manager.ts) and
 * the node shims' request-time fallback, so the three sites cannot drift.
 * They did: the long-running facet's copy once lacked the shebang strip,
 * and a required module that kept its shebang (pi 0.87.0's cli-runtime.js)
 * compiled in a short command and failed in the attached process.
 */
export const MK_COMPILED_FN_SOURCE = `
function __mkCompiledFn(code) {
  // Node strips a leading shebang from every module before evaluation;
  // bin scripts are commonly bundled verbatim with their
  // "#!/usr/bin/env node" line, which is a SyntaxError under new Function.
  if (typeof code === "string" && code.charCodeAt(0) === 35 && code.charCodeAt(1) === 33) {
    const __nl = code.indexOf("\\n");
    code = __nl >= 0 ? code.slice(__nl + 1) : "";
  }
  const __base = ["exports", "require", "module", "__filename", "__dirname"];
  const __params = __base.slice();
  let __error;
  // Each pass renames exactly the parameter the parser reported; a module
  // may declare more than one, so the loop runs once per slot at most.
  for (let __attempt = 0; __attempt <= __base.length; __attempt++) {
    try { return new Function(...__params, code); }
    catch (e) {
      __error = e;
      // V8 (workerd) and JavaScriptCore (bun, the unit tests) word it differently.
      const __m = /Identifier '([$\\w]+)' has already been declared|Cannot declare a \\w+ variable twice: '([$\\w]+)'/.exec((e && e.message) || "");
      const __slot = __m ? __base.indexOf(__m[1] || __m[2]) : -1;
      if (__slot < 0 || __params[__slot] !== __base[__slot]) throw e;
      __params[__slot] = __base[__slot] + "__nimbus_unused";
    }
  }
  throw __error;
}
`;
