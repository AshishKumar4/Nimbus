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
import * as acorn from 'acorn';
import { parse } from 'acorn';
import { reflectGet, reflectSetPrototypeOf, stringSlice } from './intrinsics.js';
import { forEachChildNode } from './scope.js';
// acorn assigns each node's fields as it builds it. A program may since have
// defined accessors on Object.prototype under those names (test262 defines
// `callee`), which the assignments would run into; nodes inherit nothing.
// (acorn exports its Node class, but its typings declare only the interface.)
const AcornNode = reflectGet(acorn, 'Node');
if (typeof AcornNode !== 'function')
    throw new Error('interpreter: acorn no longer exports its Node class');
reflectSetPrototypeOf(AcornNode.prototype, null);
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
    const program = parse(text, { ...OPTIONS, sourceType: site.module ? 'module' : 'script' });
    const start = before.length;
    const end = start + (site.end - site.start);
    const node = findFunction(program, start, end);
    if (node === null)
        throw new Error(`interpreter: the function at ${site.start} did not parse back to itself`);
    return { node, text, base: site.start - start };
}
/** The function node spanning exactly [start, end) under `root`. */
function findFunction(root, start, end) {
    const isFunction = root.type === 'FunctionExpression' || root.type === 'ArrowFunctionExpression' || root.type === 'FunctionDeclaration';
    if (isFunction && root.start === start && root.end === end)
        return root;
    let found = null;
    forEachChildNode(root, (child) => {
        if (found === null && child.start <= start && child.end >= end)
            found = findFunction(child, start, end);
    });
    return found;
}
