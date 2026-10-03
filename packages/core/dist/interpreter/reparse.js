/**
 * reparse.ts — the AST of one function again, from its unit's source text.
 *
 * A function is compiled on its first call (compile.ts), and its AST is not
 * kept until then: the unit's text is, as V8 keeps a script's source. So the
 * function's text is parsed again, alone. Some of what is valid in a function
 * depends on where it sits (strictness, `super`, `super()`, `new.target`), so
 * the text is wrapped in the smallest construct that gives it that context,
 * and the function is found in the result by its offset. The unit's own
 * parse already accepted the text, so this parse fails only on a bug.
 */
import { parse } from 'acorn';
import { Error, newSafeList, reflectGetPrototypeOf, reflectSetPrototypeOf, stringSlice } from './intrinsics.js';
import { ownProgram } from './tree.js';
// acorn assigns each node's fields as it builds it. A program may since have
// defined accessors on Object.prototype under those names (test262 defines
// `callee`), which the assignments would run into; nodes inherit nothing.
// The prototype of acorn's nodes is read off a node: its typings declare
// Node only as an interface, and a namespace import would be built at load
// with Object.defineProperty, which a program may have replaced.
const NodePrototype = reflectGetPrototypeOf(parse('0', { ecmaVersion: 'latest' }));
if (NodePrototype === null)
    throw new Error('interpreter: acorn nodes no longer have a prototype of their own');
reflectSetPrototypeOf(NodePrototype, null);
const OPTIONS = {
    ecmaVersion: 'latest',
    // Whether a private name is declared, the unit's parse already checked.
    checkPrivateFields: false,
    // A sloppy method's arrow may use super; the unit's parse checked that it sits in a method.
    allowSuperOutsideMethod: true,
};
/** The text before and after the function's own, for its syntax and strictness. */
function wrapper(syntax, strict, module) {
    const directive = strict && !module ? '"use strict";' : '';
    switch (syntax.kind) {
        case 'keyword':
            return syntax.declaration ? [directive, ''] : [`${directive}(`, ')'];
        case 'arrow':
            // A derived constructor allows everything an arrow can take from where it sits.
            return strict ? ['(class extends Object { constructor() { (', ') } })'] : ['(function () { (', ') })'];
        case 'method': {
            if (syntax.derivedConstructor)
                return ['(class extends Object { constructor', ' })'];
            const prefix = `${syntax.async ? 'async ' : ''}${syntax.generator ? '*' : ''}m`;
            return strict ? [`(class { ${prefix}`, ' })'] : [`({ ${prefix}`, ' })'];
        }
    }
}
/** The function node of `site`, parsed again. */
export function reparseFunction(site) {
    const around = wrapper(site.syntax, site.strict, site.module);
    const before = around[0];
    const text = `${before}${stringSlice(site.source, site.start, site.end)}${around[1]}`;
    // The copy of the program lists its functions; the one spanning the function's text is it.
    const functions = newSafeList();
    ownProgram(parse(text, { ...OPTIONS, sourceType: site.module ? 'module' : 'script' }), functions);
    const start = before.length;
    const end = start + (site.end - site.start);
    for (let i = 0; i < functions.length; i++) {
        const node = functions[i];
        if (node.start === start && node.end === end)
            return { node, text, base: site.start - start };
    }
    throw new Error(`interpreter: the function at ${site.start} did not parse back to itself`);
}
