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
/**
 * The bytes the kept answers may hold. They live in the session's isolate
 * (128 MB, about 10 MB of it spare once a launch's map is built:
 * platform/limits.ts ONE_SHOT_MODULE_MAP_MAX_BYTES), and a launch asks of
 * them once per module it walks that names `require` (about 3,000 for a nuxt
 * project, nearly all answering nothing, about 100 bytes each), so 2 MiB keeps
 * a few projects' worth while costing that headroom little.
 */
export const REQUIRE_WRAPPER_ANSWERS_MAX_BYTES = 2 * 1024 * 1024;
/** An answer larger than this is returned and not kept: no single module may take most of the bound. */
const ANSWER_KEPT_MAX_BYTES = REQUIRE_WRAPPER_ANSWERS_MAX_BYTES / 4;
/** What one kept answer costs beyond its strings: the Map entry, the record and the array (an estimate). */
const ANSWER_OVERHEAD_BYTES = 128;
/**
 * What each text answered, by the first 128 bits of its SHA-256 (the text
 * itself is never kept; the walk reads text through a filesystem that hands
 * no content key with it, and a digest of the modules a vite launch walks
 * costs about 4 ms): least recently used first out, within
 * REQUIRE_WRAPPER_ANSWERS_MAX_BYTES.
 */
const ANSWERS = new Map();
let answersBytes = 0;
const NONE = Object.freeze([]);
const encoder = new TextEncoder();
/** The answers kept now: how many, and the bytes they hold (UTF-16 strings, and the estimated overhead). */
export function requireWrapperAnswersHeld() {
    return { entries: ANSWERS.size, bytes: answersBytes };
}
/** What `code`'s require wrappers load, each once. */
export async function requireWrapperCalls(code) {
    // Neither identifier can be in a text that spells neither, unless it escapes one.
    if (!code.includes('equire') && !code.includes('\\u'))
        return NONE;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(code)));
    let key = '';
    for (let i = 0; i < 16; i++)
        key += String.fromCharCode(digest[i]);
    const known = ANSWERS.get(key);
    if (known !== undefined) {
        ANSWERS.delete(key);
        ANSWERS.set(key, known);
        return known.calls;
    }
    const calls = namesRequire(code) ? wrapperCallsOf(code) : NONE;
    let bytes = ANSWER_OVERHEAD_BYTES + key.length * 2;
    for (const specifier of calls)
        bytes += specifier.length * 2;
    if (bytes <= ANSWER_KEPT_MAX_BYTES) {
        ANSWERS.set(key, { calls, bytes });
        answersBytes += bytes;
        for (const [oldest, answer] of ANSWERS) {
            if (answersBytes <= REQUIRE_WRAPPER_ANSWERS_MAX_BYTES)
                break;
            ANSWERS.delete(oldest);
            answersBytes -= answer.bytes;
        }
    }
    return calls;
}
/**
 * Whether `code` has an identifier token `require` or `createRequire` (its
 * escapes read; one in a string, a template, a regular expression or a
 * comment is none), as a module or as a script; true if it tokenizes as
 * neither, for the parse to settle.
 */
export function namesRequire(code) {
    for (const sourceType of ['module', 'script']) {
        try {
            const tokens = tokenizer(code, { ...PROGRAM_PARSE_OPTIONS, sourceType });
            for (let token = tokens.getToken(); token.type !== tokTypes.eof; token = tokens.getToken()) {
                if (token.type !== tokTypes.name)
                    continue;
                // A name token's value (acorn's declarations leave it out).
                const name = Reflect.get(token, 'value');
                if (name === 'require' || name === 'createRequire')
                    return true;
            }
            return false;
        }
        catch { /* the other source type */ }
    }
    return true;
}
/** The shared analysis's wrapper calls in `code`, parsed as Node would run it (a module, else a script); none if neither parses. */
function wrapperCallsOf(code) {
    for (const sourceType of ['module', 'script']) {
        const collector = new RequestCollector();
        try {
            parseStatements(code, { ...PROGRAM_PARSE_OPTIONS, sourceType }, { onNode: (node) => collector.visit(node) });
        }
        catch {
            continue;
        }
        const calls = uniqueSpecifiers(collector.finish().wrapperCalls);
        return calls.length === 0 ? NONE : Object.freeze(calls);
    }
    return NONE;
}
