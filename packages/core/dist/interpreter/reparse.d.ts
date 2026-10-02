import { type FunctionNode } from './scope.js';
/** What precedes a function's parameters, which decides how its text is wrapped. */
export type FunctionSyntax = 
/**
 * `function` or `async function`: the text starts at the keyword. A named
 * declaration is parsed as one, since its name is bound outside it (a
 * sloppy generator may be named `yield`).
 */
{
    readonly kind: 'keyword';
    readonly declaration: boolean;
}
/** An arrow function: the text starts at its parameters (or `async`). */
 | {
    readonly kind: 'arrow';
}
/** A method, getter, setter or class constructor: the text starts at the parameter list's `(`. */
 | {
    readonly kind: 'method';
    readonly async: boolean;
    readonly generator: boolean;
    readonly derivedConstructor: boolean;
};
export interface FunctionSite {
    /** The unit's source text, and whether it is a module. */
    readonly source: string;
    readonly module: boolean;
    /** The function's offsets in `source`. */
    readonly start: number;
    readonly end: number;
    readonly syntax: FunctionSyntax;
    /** Whether the code the function sits in is strict. */
    readonly strict: boolean;
}
export interface Reparsed {
    readonly node: FunctionNode;
    /** The text that was parsed; node offsets index it. */
    readonly text: string;
    /** The offset in the unit's source of `text`'s first character. */
    readonly base: number;
}
/** The function node of `site`, parsed again. */
export declare function reparseFunction(site: FunctionSite): Reparsed;
//# sourceMappingURL=reparse.d.ts.map