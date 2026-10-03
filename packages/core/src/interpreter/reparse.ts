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
import { parse, type Options } from 'acorn';
import { Error, newSafeList, stringSlice } from './intrinsics.js';
import type { FunctionNode } from './scope.js';
import { own } from './parser-realm.js';
import { type Owned, ownProgram } from './tree.js';

/** What precedes a function's parameters, which decides how its text is wrapped. */
export type FunctionSyntax =
  /**
   * `function` or `async function`: the text starts at the keyword. A named
   * declaration is parsed as one, since its name is bound outside it (a
   * sloppy generator may be named `yield`).
   */
  | { readonly kind: 'keyword'; readonly declaration: boolean }
  /** An arrow function: the text starts at its parameters (or `async`). */
  | { readonly kind: 'arrow' }
  /** A method, getter, setter or class constructor: the text starts at the parameter list's `(`. */
  | { readonly kind: 'method'; readonly async: boolean; readonly generator: boolean; readonly derivedConstructor: boolean };

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
  readonly node: Owned<FunctionNode>;
  /** The text that was parsed; node offsets index it. */
  readonly text: string;
  /** The offset in the unit's source of `text`'s first character. */
  readonly base: number;
}

const OPTIONS: Options = {
  ecmaVersion: 'latest',
  // Whether a private name is declared, the unit's parse already checked.
  checkPrivateFields: false,
  // A sloppy method's arrow may use super; the unit's parse checked that it sits in a method.
  allowSuperOutsideMethod: true,
};
// What the parser is given inherits nothing: it reads one option directly (parser-realm.ts).
const SCRIPT_OPTIONS: Options = own({ ...OPTIONS, sourceType: 'script' });
const MODULE_OPTIONS: Options = own({ ...OPTIONS, sourceType: 'module' });

/** The text before and after the function's own, for its syntax and strictness. */
function wrapper(syntax: FunctionSyntax, strict: boolean, module: boolean): readonly [string, string] {
  const directive = strict && !module ? '"use strict";' : '';
  switch (syntax.kind) {
    case 'keyword':
      return syntax.declaration ? [directive, ''] : [`${directive}(`, ')'];
    case 'arrow':
      // A derived constructor allows everything an arrow can take from where it sits.
      return strict ? ['(class extends Object { constructor() { (', ') } })'] : ['(function () { (', ') })'];
    case 'method': {
      if (syntax.derivedConstructor) return ['(class extends Object { constructor', ' })'];
      const prefix = `${syntax.async ? 'async ' : ''}${syntax.generator ? '*' : ''}m`;
      return strict ? [`(class { ${prefix}`, ' })'] : [`({ ${prefix}`, ' })'];
    }
  }
}

/** The function node of `site`, parsed again. */
export function reparseFunction(site: FunctionSite): Reparsed {
  const around = wrapper(site.syntax, site.strict, site.module);
  const before = around[0];
  const text = `${before}${stringSlice(site.source, site.start, site.end)}${around[1]}`;
  // The copy of the program lists its functions; the one spanning the function's text is it.
  const functions = newSafeList<Owned<FunctionNode>>();
  ownProgram(parse(text, site.module ? MODULE_OPTIONS : SCRIPT_OPTIONS), functions);
  const start = before.length;
  const end = start + (site.end - site.start);
  for (let i = 0; i < functions.length; i++) {
    const node = functions[i];
    if (node.start === start && node.end === end) return { node, text, base: site.start - start };
  }
  throw new Error(`interpreter: the function at ${site.start} did not parse back to itself`);
}
