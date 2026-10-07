/**
 * The names a CommonJS module exports, read off acorn's tokens (so a
 * comment, a string or a template's text holds none), by one of two
 * policies over the same matches:
 *
 *   - `node`: as Node detects them before running a module, cjs-module-lexer's
 *     grammar (Node's own lexer, whose README states it). Node builds a
 *     CommonJS module's ES namespace from these (`default` is module.exports).
 *   - `vite`: every name a module may put on module.exports, for the dev
 *     server's CJS interop. Real Vite reads any named import of a CJS
 *     dependency off its default export (`mod["red"]`), so any key works
 *     there; the dev server gives the bundle named exports instead, and a
 *     name it misses is an import that fails. So: every key of a
 *     `module.exports = { ... }` literal, whatever its value (color-name's
 *     are arrays, where Node's grammar stops), and every
 *     `Object.defineProperty` of a name, getters Node calls unsafe included.
 *
 * Node's grammar. Detected, anywhere in the source, with no scope analysis:
 *   - `exports.a =`, `exports['a'] =`, the same on `module.exports`;
 *   - `Object.defineProperty(exports, 'a', { value: ... })` and the safe
 *     getter forms (`[enumerable: true,] get[: function [name]] () { return
 *     id[.id | ['s']][;] }`); any other define of a name opts that name out,
 *     whatever else sets it;
 *   - `module.exports = { a, b: c, 'd': e, ...f, ...require('x') }`, up to
 *     its first property of another form.
 * Reexports, whose names the caller adds by resolving and scanning them:
 *   - the requires of the last `module.exports = require('x')` or literal
 *     (each `module.exports =` starts the set again);
 *   - a top-level `__export(require('x'))` or `__exportStar(require('x'), ...)`;
 *   - Babel's reexport loop, `Object.keys(_x).forEach(function (key) { ... })`
 *     over a top-level `var _x = require('x')` (or
 *     `_interopRequireWildcard(require('x'))`), in the forms the lexer's
 *     grammar lists.
 */
import { tokenizer, tokTypes, type Token } from 'acorn';

/** A token's value: a name's or keyword's text, a string's decoded contents (acorn's typings omit the field). */
function tokenValue(token: Token | undefined): string {
  return token === undefined ? '' : String(Reflect.get(token, 'value'));
}

/** Whose detection a scan follows: Node's (cjs-module-lexer) or the Vite dev server's interop. */
export type CjsExportPolicy = 'node' | 'vite';

export interface CjsExports {
  /** Export names, in the order first detected. */
  readonly names: string[];
  /** Specifiers whose exports this module's include. */
  readonly reexports: string[];
}

/** `source`'s exports and reexports by `policy`; none for a source that does not tokenize, as the lexer has none. */
export function scanCjsExports(source: string, policy: CjsExportPolicy = 'node'): CjsExports {
  try {
    return scan(source, policy);
  } catch {
    return { names: [], reexports: [] };
  }
}

function scan(source: string, policy: CjsExportPolicy): CjsExports {
  // The tokens stream through a window: a bundle of megabytes would be
  // millions of tokens at once, and the patterns look back three tokens and
  // forward only as far as one declaration reaches.
  const stream = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  const window: Token[] = [];
  let base = 0;
  let ended = false;
  const at = (i: number): Token | undefined => {
    while (!ended && i >= base + window.length) {
      const token = stream.getToken();
      if (token.type === tokTypes.eof) ended = true;
      else window.push(token);
    }
    return i >= base ? window[i - base] : undefined;
  };
  /** Drop the tokens more than a few behind `i`. */
  const slide = (i: number): void => {
    if (i - base < 256) return;
    const drop = i - base - 8;
    window.splice(0, drop);
    base += drop;
  };
  const names = new Set<string>();
  const unsafe = new Set<string>();
  let reexports = new Set<string>();
  let depth = 0;

  const is = (i: number, type: typeof tokTypes.name): boolean => at(i)?.type === type;
  const word = (i: number, value?: string): boolean => {
    const token = at(i);
    if (token === undefined || (token.type !== tokTypes.name && token.type.keyword === undefined)) return false;
    return value === undefined || tokenValue(token) === value;
  };
  const text = (i: number): string => tokenValue(at(i));
  /** Whether token `i` starts with `=` (`=`, and as the lexer reads it `==` and `===`). */
  const assigns = (i: number): boolean => source.charCodeAt(at(i)?.start ?? -1) === 0x3d && at(i)?.type !== tokTypes.assign && at(i)?.type !== tokTypes.arrow;
  /** Whether token `i` begins where token `i - 1` ends, as the lexer reads some slots without whitespace. */
  const adjacent = (i: number): boolean => at(i) !== undefined && at(i)!.start === at(i - 1)?.end;
  /** Index after `exports` or `module.exports` at `i`, or -1. */
  const exportsAt = (i: number): number => {
    if (is(i - 1, tokTypes.dot) || is(i - 1, tokTypes.questionDot)) return -1;
    if (word(i, 'exports')) return i + 1;
    if (word(i, 'module') && is(i + 1, tokTypes.dot) && word(i + 2, 'exports')) return i + 3;
    return -1;
  };
  /** `require('x')` at `i`: the index after it and the specifier, or null. */
  const requireAt = (i: number): { end: number; specifier: string } | null =>
    word(i, 'require') && is(i + 1, tokTypes.parenL) && is(i + 2, tokTypes.string) && is(i + 3, tokTypes.parenR)
      ? { end: i + 4, specifier: text(i + 2) }
      : null;

  /**
   * Index past the expression at `k` in a list: up to the `,` or the closing
   * bracket at its own depth (templates' `${` close with `}`), or -1 at the end.
   */
  const pastValue = (k: number): number => {
    for (let nesting = 0; at(k) !== undefined; k++) {
      const type = at(k)!.type;
      if (type === tokTypes.parenL || type === tokTypes.braceL || type === tokTypes.bracketL || type === tokTypes.dollarBraceL) nesting++;
      else if (type === tokTypes.parenR || type === tokTypes.braceR || type === tokTypes.bracketR) {
        if (nesting === 0) return k;
        nesting--;
      } else if (type === tokTypes.comma && nesting === 0) return k;
    }
    return -1;
  };

  /**
   * The Vite policy's `module.exports = { ... }` from the `{` at `i`: each
   * property's key (a name, a string, a number; a method's, a getter's), the
   * rest of the property skipped whatever it is; a spread or a computed key
   * names nothing. Exactly the keys the literal itself puts on
   * module.exports, without the names Node's grammar misreads (`get` of
   * `get [a]() {}`).
   */
  const anyLiteral = (i: number): void => {
    const key = (j: number): boolean => word(j) || is(j, tokTypes.string) || is(j, tokTypes.num);
    const keyOrComputed = (j: number): boolean => key(j) || is(j, tokTypes.bracketL);
    for (let k = i + 1; at(k) !== undefined && !is(k, tokTypes.braceR); ) {
      // `get a() {}`, `set a(v) {}`, `async a() {}`, `*a() {}`, `async *a() {}`, a computed `[a]` in each: the key follows the modifiers.
      if (word(k, 'async') && (is(k + 1, tokTypes.star) || keyOrComputed(k + 1))) k++;
      if (is(k, tokTypes.star)) k++;
      else if ((word(k, 'get') || word(k, 'set')) && keyOrComputed(k + 1)) k++;
      if (key(k)) names.add(text(k));
      // A spread of a whole `require(...)` reexports it, as Node reads one.
      const required = is(k, tokTypes.ellipsis) ? requireAt(k + 1) : null;
      if (required && (is(required.end, tokTypes.comma) || is(required.end, tokTypes.braceR))) reexports.add(required.specifier);
      // The property, from its key, its `[`, or its `...`, ends at the next comma at its own depth.
      k = pastValue(k);
      if (k === -1 || !is(k, tokTypes.comma)) return;
      k++;
    }
  };

  /** Node's `module.exports = { ... }` from the `{` at `i`. */
  const literal = (i: number): void => {
    for (let k = i + 1; ; ) {
      if (word(k) || is(k, tokTypes.string)) {
        const key = text(k);
        const keyIsString = is(k, tokTypes.string);
        let next = k + 1;
        if (is(next, tokTypes.colon)) {
          if (!word(next + 1)) return;
          next += 2;
          names.add(key);
          // After a value, the lexer reads the next character as it stands.
          if (!adjacent(next)) return;
        } else if (keyIsString) {
          return;
        } else {
          names.add(key);
        }
        k = next;
      } else if (is(k, tokTypes.ellipsis)) {
        const required = adjacent(k + 1) ? requireAt(k + 1) : null;
        if (required) {
          reexports.add(required.specifier);
          k = required.end;
        } else if (word(k + 1) && adjacent(k + 1)) {
          k += 2;
        } else {
          return;
        }
      } else {
        return;
      }
      if (is(k, tokTypes.braceR)) return;
      if (!is(k, tokTypes.comma)) return;
      k++;
    }
  };

  /** `Object.defineProperty(exports, 's', { ... })` at `i`, the `Object` token. */
  const define = (i: number): void => {
    if (!(is(i + 1, tokTypes.dot) && word(i + 2, 'defineProperty') && is(i + 3, tokTypes.parenL))) return;
    const target = exportsAt(i + 4);
    if (target === -1 || !is(target, tokTypes.comma) || !is(target + 1, tokTypes.string)) return;
    const name = text(target + 1);
    let k = target + 2;
    const safe = (() => {
      if (!is(k, tokTypes.comma) || !is(k + 1, tokTypes.braceL)) return false;
      k += 2;
      if (word(k, 'enumerable')) {
        if (!(is(k + 1, tokTypes.colon) && is(k + 2, tokTypes._true) && is(k + 3, tokTypes.comma))) return false;
        k += 4;
      }
      if (word(k, 'value')) return is(k + 1, tokTypes.colon);
      if (!word(k, 'get')) return false;
      k++;
      if (is(k, tokTypes.colon)) {
        if (!is(k + 1, tokTypes._function)) return false;
        k += 2;
        if (word(k) && !is(k, tokTypes.parenL)) k++;
      }
      if (!(is(k, tokTypes.parenL) && is(k + 1, tokTypes.parenR) && is(k + 2, tokTypes.braceL) && is(k + 3, tokTypes._return) && word(k + 4))) return false;
      k += 5;
      if (is(k, tokTypes.dot)) {
        if (!word(k + 1)) return false;
        k += 2;
      } else if (is(k, tokTypes.bracketL)) {
        if (!(is(k + 1, tokTypes.string) && is(k + 2, tokTypes.bracketR))) return false;
        k += 3;
      }
      if (is(k, tokTypes.semi)) k++;
      if (!is(k, tokTypes.braceR)) return false;
      k++;
      if (is(k, tokTypes.comma)) k++;
      return is(k, tokTypes.braceR) && is(k + 1, tokTypes.parenR);
    })();
    // Under Vite's policy every define names a key the default export holds.
    if (safe || policy === 'vite') names.add(name);
    else unsafe.add(name);
  };

  /** Top-level `var|let|const ID = [_interopRequireWildcard(]require('x')`: ID's specifier, for Babel's loop. */
  const starBindings = new Map<string, string>();
  /** Only spaces between tokens `i - 1` and `i`, at least `min`: the lexer's backtrack reads spaces alone. */
  const spaces = (i: number, min: number): boolean => {
    const gap = source.slice(at(i - 1)?.end ?? 0, at(i)?.start ?? 0);
    return gap.length >= min && /^ *$/.test(gap);
  };
  /** Record the binding a top-level require at `r` (the `require`, or `_interopRequireWildcard`) initializes. */
  const bindRequire = (r: number, specifier: string): void => {
    if (!(is(r - 1, tokTypes.eq) && spaces(r, 0) && is(r - 2, tokTypes.name) && spaces(r - 1, 0))) return;
    const declaration = at(r - 3);
    if (!declaration || !['var', 'let', 'const'].includes(tokenValue(declaration)) || !spaces(r - 2, 1)) return;
    starBindings.set(text(r - 2), specifier);
  };
  /** Babel's `Object.keys(ID).forEach(function (IT) { ... })` at `i`, the `Object` token: ID, when it matches. */
  const babelStar = (i: number): string | null => {
    let k = i;
    const take = (test: (j: number) => boolean): boolean => (test(k) ? (k++, true) : false);
    const punct = (type: typeof tokTypes.name) => (j: number) => is(j, type);
    const named = (value: string) => (j: number) => word(j, value);
    const op = (value: string) => (j: number) => tokenValue(at(j)) === value && at(j)?.type !== tokTypes.string && at(j)?.type !== tokTypes.name;
    const str = (value: string) => (j: number) => is(j, tokTypes.string) && text(j) === value;
    const all = (...tests: ((j: number) => boolean)[]): boolean => tests.every((test) => take(test));
    if (!all(named('Object'), punct(tokTypes.dot), named('keys'), punct(tokTypes.parenL)) || !word(k)) return null;
    const id = text(k++);
    if (!all(punct(tokTypes.parenR), punct(tokTypes.dot), named('forEach'), punct(tokTypes.parenL), punct(tokTypes._function), punct(tokTypes.parenL)) || !word(k)) return null;
    const it = text(k++);
    const self = named(it);
    const exportsHere = (): boolean => {
      const end = exportsAt(k);
      if (end === -1) return false;
      k = end;
      return true;
    };
    // `Object[.prototype].hasOwnProperty.call(IDENT, IT)`
    const hasOwn = (): boolean => {
      const start = k;
      const ok = take(named('Object')) && take(punct(tokTypes.dot))
        && (take(named('prototype')) ? take(punct(tokTypes.dot)) : true)
        && all(named('hasOwnProperty'), punct(tokTypes.dot), named('call'), punct(tokTypes.parenL)) && take(word)
        && all(punct(tokTypes.comma), self, punct(tokTypes.parenR));
      if (!ok) k = start;
      return ok;
    };
    const returns = (): boolean => {
      if (!take(punct(tokTypes._return))) return false;
      take(punct(tokTypes.semi));
      return true;
    };
    if (!all(punct(tokTypes.parenR), punct(tokTypes.braceL), punct(tokTypes._if), punct(tokTypes.parenL), self)) return null;
    if (take(op('==='))) {
      if (!all(str('default'), op('||'), self, op('==='), str('__esModule'), punct(tokTypes.parenR)) || !returns()) return null;
      if (all(punct(tokTypes._if), punct(tokTypes.parenL))) {
        let inIf = true;
        if (hasOwn()) {
          if (!take(punct(tokTypes.parenR)) || !returns()) return null;
          inIf = all(punct(tokTypes._if), punct(tokTypes.parenL));
        }
        if (inIf) {
          if (!all(self, punct(tokTypes._in)) || !exportsHere() || !take(op('&&')) || !exportsHere()) return null;
          if (!all(punct(tokTypes.bracketL), self, punct(tokTypes.bracketR), op('==='), named(id), punct(tokTypes.bracketL), self, punct(tokTypes.bracketR), punct(tokTypes.parenR)) || !returns()) return null;
        }
      }
    } else if (take(op('!=='))) {
      if (!take(str('default'))) return null;
      if (take(op('&&'))) {
        if (!take(op('!'))) return null;
        if (!hasOwn() && !(take(word) && all(punct(tokTypes.dot), named('hasOwnProperty'), punct(tokTypes.parenL), self, punct(tokTypes.parenR)))) return null;
      }
      if (!take(punct(tokTypes.parenR))) return null;
    } else {
      return null;
    }
    if (exportsHere()) {
      if (!all(punct(tokTypes.bracketL), self, punct(tokTypes.bracketR), punct(tokTypes.eq), named(id), punct(tokTypes.bracketL), self, punct(tokTypes.bracketR))) return null;
      take(punct(tokTypes.semi));
    } else if (all(named('Object'), punct(tokTypes.dot), named('defineProperty'), punct(tokTypes.parenL))) {
      if (!exportsHere() || !all(punct(tokTypes.comma), self, punct(tokTypes.comma), punct(tokTypes.braceL), named('enumerable'), punct(tokTypes.colon), punct(tokTypes._true), punct(tokTypes.comma), named('get'))) return null;
      if (take(punct(tokTypes.colon))) {
        if (!take(punct(tokTypes._function))) return null;
        if (!is(k, tokTypes.parenL)) take(word);
      }
      if (!all(punct(tokTypes.parenL), punct(tokTypes.parenR), punct(tokTypes.braceL), punct(tokTypes._return), named(id), punct(tokTypes.bracketL), self, punct(tokTypes.bracketR))) return null;
      take(punct(tokTypes.semi));
      if (!take(punct(tokTypes.braceR))) return null;
      take(punct(tokTypes.comma));
      if (!all(punct(tokTypes.braceR), punct(tokTypes.parenR))) return null;
      take(punct(tokTypes.semi));
    } else {
      return null;
    }
    return all(punct(tokTypes.braceR), punct(tokTypes.parenR)) ? id : null;
  };

  for (let i = 0; at(i) !== undefined; i++) {
    slide(i);
    const token = at(i)!;
    if (token.type === tokTypes.parenL || token.type === tokTypes.braceL || token.type === tokTypes.dollarBraceL) depth++;
    else if (token.type === tokTypes.parenR || token.type === tokTypes.braceR) depth = Math.max(0, depth - 1);
    if (token.type !== tokTypes.name) continue;

    if (tokenValue(token) === 'Object' && !is(i - 1, tokTypes.dot)) {
      define(i);
      const id = depth === 0 ? babelStar(i) : null;
      const specifier = id === null ? undefined : starBindings.get(id);
      if (specifier !== undefined) reexports.add(specifier);
      continue;
    }
    if (depth === 0 && !is(i - 1, tokTypes.dot)) {
      if (tokenValue(token) === 'require') {
        const required = requireAt(i);
        if (required) bindRequire(i, required.specifier);
        continue;
      }
      if (tokenValue(token) === '_interopRequireWildcard' && is(i + 1, tokTypes.parenL) && adjacent(i + 1) && adjacent(i + 2)) {
        const required = requireAt(i + 2);
        if (required) bindRequire(i, required.specifier);
        continue;
      }
    }
    if (depth === 0 && (tokenValue(token) === '__export' || tokenValue(token) === '__exportStar')) {
      const required = is(i + 1, tokTypes.parenL) && adjacent(i + 1) && adjacent(i + 2) ? requireAt(i + 2) : null;
      if (required) reexports.add(required.specifier);
      continue;
    }
    const after = exportsAt(i);
    if (after === -1) continue;
    if (is(after, tokTypes.dot) && word(after + 1) && assigns(after + 2)) {
      names.add(text(after + 1));
    } else if (is(after, tokTypes.bracketL) && is(after + 1, tokTypes.string) && is(after + 2, tokTypes.bracketR) && assigns(after + 3)) {
      names.add(text(after + 1));
    } else if (after === i + 3 && assigns(after)) {
      // module.exports = ...: the reexports start again.
      reexports = new Set();
      if (!is(after, tokTypes.eq)) continue;
      const required = requireAt(after + 1);
      if (required) reexports.add(required.specifier);
      else if (is(after + 1, tokTypes.braceL)) {
        if (policy === 'vite') anyLiteral(after + 1);
        else literal(after + 1);
      }
    }
  }
  return { names: [...names].filter((name) => !unsafe.has(name)), reexports: [...reexports] };
}
