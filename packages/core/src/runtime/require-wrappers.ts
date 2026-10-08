/**
 * require-wrappers.ts — what a module's require wrappers load, read by the
 * supervisor's walk (require-resolver.ts).
 *
 * A function that passes its first parameter to a require (the module's
 * own, or one createRequire made, by any name), or to its `.resolve`, loads
 * what each of its calls names with a string. @vitejs/plugin-vue loads the
 * project's compiler so:
 *
 *   const _require = createRequire(import.meta.url);
 *   function tryRequire(id, from) {
 *     try { return from ? _require(_require.resolve(id, { paths: [from] })) : _require(id); } catch (e) {}
 *   }
 *   … tryRequire("vue/compiler-sfc", root) …
 *
 * No other grammar reads that call, and a Vue project's first `vite` and
 * `vite build` failed on what it loads. Every such question is the shared
 * analysis's, which the runtime's import() prefetch reads modules with
 * (core/interpreter/module-requests.ts RequestCollector), over a parse
 * that keeps no tree of the program (parseStatements: a whole tree is 13 to
 * 24 times its source, and this runs in the session's isolate). A module is
 * parsed only if its tokens hold an identifier `require` or `createRequire`,
 * which every wrapper needs. What a text answers is kept by its content, so
 * a launch that walks text it walked before reads nothing again, whatever
 * its path or revision.
 */
import { tokenizer, tokTypes } from 'acorn';
import { RequestCollector, uniqueSpecifiers } from '../interpreter/module-requests.js';
import { PROGRAM_PARSE_OPTIONS, parseStatements } from './javascript-ast.js';

/** What each text answered, by a digest of it; bounded, the oldest dropped first. */
const ANSWERS = new Map<string, readonly string[]>();
const ANSWERS_MAX = 16_384;
const NONE: readonly string[] = Object.freeze([]);
const encoder = new TextEncoder();

/** What `code`'s require wrappers load, each once. */
export async function requireWrapperCalls(code: string): Promise<readonly string[]> {
  // Neither identifier can be in a text that spells neither, unless it escapes one.
  if (!code.includes('equire') && !code.includes('\\u')) return NONE;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(code)));
  let key = '';
  for (let i = 0; i < 16; i++) key += String.fromCharCode(digest[i]!);
  const known = ANSWERS.get(key);
  if (known !== undefined) {
    ANSWERS.delete(key);
    ANSWERS.set(key, known);
    return known;
  }
  const calls = namesRequire(code) ? wrapperCallsOf(code) : NONE;
  ANSWERS.set(key, calls);
  if (ANSWERS.size > ANSWERS_MAX) ANSWERS.delete(ANSWERS.keys().next().value!);
  return calls;
}

/**
 * Whether `code` has an identifier token `require` or `createRequire` (its
 * escapes read; one in a string, a template, a regular expression or a
 * comment is none), as a module or as a script; true if it tokenizes as
 * neither, for the parse to settle.
 */
export function namesRequire(code: string): boolean {
  for (const sourceType of ['module', 'script'] as const) {
    try {
      const tokens = tokenizer(code, { ...PROGRAM_PARSE_OPTIONS, sourceType });
      for (let token = tokens.getToken(); token.type !== tokTypes.eof; token = tokens.getToken()) {
        if (token.type !== tokTypes.name) continue;
        // A name token's value (acorn's declarations leave it out).
        const name = Reflect.get(token, 'value');
        if (name === 'require' || name === 'createRequire') return true;
      }
      return false;
    } catch { /* the other source type */ }
  }
  return true;
}

/** The shared analysis's wrapper calls in `code`, parsed as Node would run it (a module, else a script); none if neither parses. */
function wrapperCallsOf(code: string): readonly string[] {
  for (const sourceType of ['module', 'script'] as const) {
    const collector = new RequestCollector();
    try {
      parseStatements(code, { ...PROGRAM_PARSE_OPTIONS, sourceType }, { onNode: (node) => collector.visit(node) });
    } catch {
      continue;
    }
    const calls = uniqueSpecifiers(collector.finish().wrapperCalls);
    return calls.length === 0 ? NONE : Object.freeze(calls);
  }
  return NONE;
}
