/**
 * cjs-module-exports.ts — the names an ES module may import from a CommonJS
 * module, as Node 22.23.4 names them before the module runs
 * (lib/internal/modules/esm/translators.js cjsPreparseModuleExports): what
 * cjs-module-lexer, at Node's own version, finds in its source, `default`
 * first, and the names of every module it re-exports (`module.exports =
 * require('x')`, `__exportStar`, Babel's loop) that require() resolves to a
 * `.js`, a `.cjs` or a file of an extension require has no loader for,
 * walked the same way. A module whose source does not lex has no names but
 * `default`; a re-export that does not resolve, or whose resolution require()
 * refuses (a path a package's "exports" hides), adds none. A cycle stops at a
 * module already being read: its names are the ones found so far, as Node's,
 * which records them first.
 *
 * One walk over a host that answers in place (a process's filesystem) or
 * with promises (the session's).
 */
import { createCjsLexer } from './cjs-module-lexer.js';
/** Extensions require loads as something other than CommonJS source. */
const NOT_COMMONJS = { '.json': true, '.node': true, '.mjs': true };
let lexer = null;
function* walk(path, cache, source) {
    const known = cache.get(path);
    if (known !== undefined)
        return known;
    const text = source ?? (yield { source: path });
    let exports = [];
    let reexports = [];
    try {
        ({ exports, reexports } = (lexer ??= createCjsLexer())(typeof text === 'string' ? text : ''));
    }
    catch {
        // No names but `default`, as Node's.
    }
    const names = new Set(['default', ...exports]);
    cache.set(path, names);
    for (const reexport of reexports) {
        let resolved;
        try {
            resolved = yield { resolve: reexport, from: path };
        }
        catch {
            continue; // As Node's: a re-export require() refuses is skipped.
        }
        if (typeof resolved !== 'string' || !resolved.startsWith('/'))
            continue;
        const slash = resolved.lastIndexOf('/');
        const dot = resolved.lastIndexOf('.');
        if (dot > slash && NOT_COMMONJS[resolved.slice(dot)])
            continue;
        for (const name of yield* walk(resolved, cache, undefined))
            names.add(name);
    }
    return names;
}
/**
 * The names an ES module may import from the CommonJS module at `path`
 * (`source`, when the caller holds it), `default` first. `cache` keeps each
 * module's names across calls, and is what ends a cycle.
 */
export function cjsModuleExportNames(path, host, cache = new Map(), source) {
    const steps = walk(path, cache, source);
    for (let step = steps.next();;) {
        if (step.done)
            return step.value;
        const q = step.value;
        let answer;
        try {
            answer = 'source' in q ? host.source(q.source) : host.resolve(q.resolve, q.from);
        }
        catch (error) {
            step = steps.throw(error);
            continue;
        }
        step = steps.next(answer);
    }
}
/** cjsModuleExportNames over a host whose answers may be promises (the session's filesystem). */
export async function cjsModuleExportNamesAsync(path, host, cache = new Map(), source) {
    const steps = walk(path, cache, source);
    for (let step = steps.next();;) {
        if (step.done)
            return step.value;
        const q = step.value;
        let answer;
        try {
            answer = await ('source' in q ? host.source(q.source) : host.resolve(q.resolve, q.from));
        }
        catch (error) {
            step = steps.throw(error);
            continue;
        }
        step = steps.next(answer);
    }
}
