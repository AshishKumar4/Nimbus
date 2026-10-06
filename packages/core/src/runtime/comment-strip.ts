/**
 * The import-detection view of a JavaScript source: one lexer, read in two
 * dialects.
 *
 * `stripCommentsForImports(src)` is the require walk's (prefetch) view: it
 * walks `src` once and returns a copy in which `//` and `/* … *\/` comments
 * are blanked (each comment becomes a space; newlines inside a block comment
 * are preserved so line numbers still match the input) and regex literals
 * are blanked. String and template literals are copied verbatim:
 * IMPORT_RE/REQUIRE_RE must see the specifier string, and a `//` or `/*`
 * inside a literal must NOT open a comment that swallows a following real
 * import. A `/` is a regex unless the last non-blank character ends a
 * value (tests/unit/comment-strip-bounded.mjs pins this byte for byte).
 *
 * `maskSourceForImports(src, path)` is a project source file's view, which
 * the pre-bundle's project scan and a barrel's slice read: the same lexer,
 * reading a keyword that precedes an expression (`return`, `default`, …)
 * as starting one, and, outside TypeScript files, JSX. In valid JavaScript
 * a `<` never starts an expression, so one that does is a JSX element: its
 * tags and text are blanked (a closing tag's slash is no regex, an
 * apostrophe in text opens no string, a URL in text opens no comment) and
 * its `{…}` expressions are lexed as code again. A TypeScript generic
 * arrow's `<T,>` / `<T extends U>`, and in a TSX file a generic function
 * type's `<T>(…) =>`, is not an element. A `<` the lexer can neither close
 * as an element nor read as one of those is a construct it cannot decide:
 * it throws UndecidableSourceError, and the caller reads that file with a
 * parser instead. It never guesses on.
 *
 * The output is assembled from input slices and joined once. It used to
 * be built one character at a time (`stripped += c`), which V8 keeps as
 * a rope of one node per append — ~30 bytes of heap per character, all
 * live until the string is first read. On typescript's 6.15 MB
 * `lib/_tsc.js` that rope measured 174 MB against a 128 MB isolate —
 * the session Durable Object was killed inside `tsc`'s spawn before the
 * facet existed. Spans hold the input, the output and a short array.
 */
export function stripCommentsForImports(src: string): string {
  return maskForImports(src, { keywords: false, jsx: false });
}

/**
 * A project source file's import-detection view (see the module comment);
 * `path` decides the language: TypeScript (`.ts`, no JSX), TSX, or
 * JavaScript with JSX. Throws UndecidableSourceError for a construct the
 * lexer cannot decide.
 */
export function maskSourceForImports(src: string, path: string): string {
  const typescript = /\.[mc]?tsx?$/.test(path);
  return maskForImports(src, { keywords: true, jsx: !/\.[mc]?ts$/.test(path), typescript });
}

/** A `<` the import lexer can neither close as a JSX element nor read as type parameters. */
export class UndecidableSourceError extends Error {
  constructor(readonly offset: number) {
    super(`the import lexer cannot decide the '<' at offset ${offset}: not a JSX element it can close, nor type parameters`);
    this.name = 'UndecidableSourceError';
  }
}

/**
 * Every specifier `code` names after `from`, `import` or `import(`, as
 * written, in order: the one grammar the project scan
 * (barrel-synthesizer scanProjectImports) and a barrel's scoped slice read
 * module edges with. `code` is a masked view (maskSourceForImports), so an
 * import commented out names nothing; a caller keeps the bare or relative
 * ones it wants.
 */
export function importedSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  for (const match of code.matchAll(IMPORTED_SPECIFIER_RE)) specifiers.push(match[1]);
  return specifiers;
}

// `from` and `import` as keywords, not the end of a name (`dynamic-import`,
// `x.import`); a specifier holds no quote or blank, so a quoted word "import"
// never reads the text after it as one.
const IMPORTED_SPECIFIER_RE = /(?<![\w$.-])(?:from\s*|import\s*\(?\s*)["']([^"'\s]+)["']/g;

interface MaskDialect {
  /** A keyword before a `/` or `<` (`return /x/`, `return <a/>`) leaves an expression to start. */
  readonly keywords: boolean;
  /** A `<` that starts an expression is a JSX element. */
  readonly jsx: boolean;
  /** TypeScript's syntax: a generic function type's `<T>(…) =>` is not an element. */
  readonly typescript?: boolean;
}

/** Keywords an expression may follow. */
const EXPRESSION_KEYWORDS: Record<string, true> = {
  return: true, typeof: true, instanceof: true, in: true, of: true, new: true, delete: true, void: true,
  throw: true, case: true, do: true, else: true, yield: true, await: true, default: true,
};

/** What `element` answers when the input ends inside what read as an element. */
const ENDS_INSIDE = -1;
/** What `element` answers when a closing tag names another element: the `<` opened none. */
const NOT_AN_ELEMENT = -2;

/**
 * Identifier-suffix detection: `/` after one of these is division; after
 * anything else (operators, punctuators, start-of-file) it opens a regex
 * literal. Word chars + `)` + `]` cover `foo()/x` and `a[i]/y`; the quote
 * characters cover `'…' /re/` and `` `…` /re/ ``.
 */
const DIVISION_AFTER = /[A-Za-z0-9_$\)\]'\"`]/;

function maskForImports(src: string, dialect: MaskDialect): string {
  const NEWLINE = 0x0a;
  const N = src.length;
  const parts: string[] = [];
  const { jsx } = dialect;

  /** Whether the `/` or `<` at `i` starts an expression, `lastNonWs` being the last character the lexer passed. */
  const startsExpression = (i: number, lastNonWs: string): boolean => {
    if (!DIVISION_AFTER.test(lastNonWs)) return true;
    if (!dialect.keywords || !/[a-z]/.test(lastNonWs)) return false;
    let end = i;
    while (end > 0 && /\s/.test(src[end - 1])) end--;
    let start = end;
    while (start > 0 && /[\w$]/.test(src[start - 1])) start--;
    return EXPRESSION_KEYWORDS[src.slice(start, end)] === true && src[start - 1] !== '.';
  };

  /** Whether the `<` at `i` opens a JSX element: a fragment or a tag name, not a generic arrow's type parameters. */
  const opensElement = (i: number): boolean => {
    const next = src[i + 1];
    if (next === '>') return true;
    if (next === undefined || !/[A-Za-z_$]/.test(next)) return false;
    return !/^<[\w$]+\s*(?:,|extends\s)/.test(src.slice(i, i + 64));
  };

  /** The index after the quoted text that opens at `open`, or N. */
  const afterQuoted = (open: number): number => {
    const quote = src[open];
    for (let i = open + 1; i < N; i++) {
      if (src[i] === '\\') i++;
      else if (src[i] === quote) return i + 1;
    }
    return N;
  };

  /** The index after the bracket `close` that matches the `open` at `start`, within `limit` characters; -1 when there is none. */
  const afterMatching = (start: number, open: string, close: string, limit: number): number => {
    let depth = 0;
    for (let i = start; i < N && i < start + limit;) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {
        i = afterQuoted(i);
        continue;
      }
      if (c === open) depth++;
      else if (c === close && !(close === '>' && src[i - 1] === '=')) {
        if (--depth === 0) return i + 1;
      }
      i++;
    }
    return -1;
  };

  /**
   * Whether the `<` at `start` opens a TypeScript generic function type's
   * parameters, `<T, U extends V = W>(…) =>`: in a TSX file that is a type,
   * since TSX reads an expression's `<T>` as an element.
   */
  const genericFunctionType = (start: number): boolean => {
    const typeParameters = afterMatching(start, '<', '>', 512);
    if (typeParameters < 0) return false;
    let at = typeParameters;
    while (at < N && /\s/.test(src[at])) at++;
    if (src[at] !== '(') return false;
    const parameters = afterMatching(at, '(', ')', 4096);
    if (parameters < 0) return false;
    at = parameters;
    while (at < N && /\s/.test(src[at])) at++;
    return src[at] === '=' && src[at + 1] === '>';
  };

  /**
   * Code from `start`: written to `parts` as the dialect masks it. Returns
   * the end of the input, or, `inBraces`, the index after the `}` that
   * closes the expression container it is in; -1 when the input ends first.
   */
  const code = (start: number, inBraces: boolean): number => {
    // Start of the span not yet copied to `parts`.
    let spanStart = start;
    let i = start;
    let lastNonWs = '';
    let depth = 0;
    const record = (ch: string) => {
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') lastNonWs = ch;
    };
    // The division/regex discriminator needs the last non-ws char the loop
    // has passed — stepped chars record themselves; spans already landed in
    // `parts` only need their final char re-derived.
    const step = () => { record(src[i]); i++; };
    const copy = (end: number) => {
      if (end > spanStart) parts.push(src.slice(spanStart, end));
    };
    const emit = (ch: string) => { parts.push(ch); };

    // A shebang is the file's first line and never a comment or a regex —
    // `#!/` at offset 0 is copied whole before the loop sees the `/`.
    if (start === 0 && src.charCodeAt(0) === 0x23 && src.charCodeAt(1) === 0x21) {
      i = 2;
      while (i < N && src.charCodeAt(i) !== NEWLINE) i++;
      record('!');
    }

    while (i < N) {
      if (src.charCodeAt(i) === 0x2f /* / */) {
        const next = src.charCodeAt(i + 1);
        if (next === 0x2f) {
          // Line comment: to end-of-line, one space. The newline itself is
          // not part of the comment and stays in the next span.
          copy(i);
          i += 2;
          while (i < N && src.charCodeAt(i) !== NEWLINE) i++;
          emit(' ');
          spanStart = i;
          continue;
        }
        if (next === 0x2a) {
          // Block comment: replaced by its own newlines plus one space; an
          // unterminated one runs to the end of input and gets no space.
          copy(i);
          i += 2;
          let newlines = 0;
          let closed = false;
          while (i < N) {
            const bc = src.charCodeAt(i);
            if (bc === NEWLINE) newlines++;
            else if (bc === 0x2a && src.charCodeAt(i + 1) === 0x2f) { i += 2; closed = true; break; }
            i++;
          }
          if (newlines > 0) parts.push('\n'.repeat(newlines));
          if (closed) emit(' ');
          spanStart = i;
          continue;
        }
        // Regex literal when nothing before it ends a value.
        if (startsExpression(i, lastNonWs)) {
          // A regex needs its closing `/` on the same line; without one the
          // slash is division (or a lone `/`), and treating the rest of the
          // line as a literal would drop real code — imports included.
          let j = i + 1;
          let closes = false;
          while (j < N) {
            const rc = src.charCodeAt(j);
            if (rc === 0x5c) { j += 2; continue; }
            if (rc === 0x5b) {
              j++;
              while (j < N && src.charCodeAt(j) !== 0x5d) {
                if (src.charCodeAt(j) === 0x5c) { j += 2; continue; }
                j++;
              }
              if (j < N) j++;
              continue;
            }
            if (rc === 0x2f) { closes = true; break; }
            if (rc === NEWLINE) break;
            j++;
          }
          if (!closes) { step(); continue; }
          copy(i);
          emit(' ');
          i++;
          while (i < N) {
            const rc = src.charCodeAt(i);
            if (rc === 0x5c) { i += 2; continue; }
            if (rc === 0x5b) {
              // Character class: `/` inside it is content.
              i++;
              while (i < N && src.charCodeAt(i) !== 0x5d) {
                if (src.charCodeAt(i) === 0x5c) { i += 2; continue; }
                i++;
              }
              if (i < N) i++;
              continue;
            }
            if (rc === 0x2f) { i++; break; }
            i++;
          }
          // Flags: g, i, m, s, u, y, d.
          while (i < N && /[gimsuyd]/.test(src[i])) i++;
          record('/');
          spanStart = i;
          continue;
        }
        // Division or a lone slash — plain source.
        step();
        continue;
      }

      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        i++;
        while (i < N) {
          const cc = src[i];
          if (cc === '\\') { i += 2; continue; }
          if (cc === ch) { i++; break; }
          i++;
        }
        // The literal ends a value: a following `/` is division.
        record(ch);
        continue;
      }
      if (inBraces) {
        if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          if (depth === 0) {
            copy(i);
            return i + 1;
          }
          depth--;
        }
      }
      if (jsx && ch === '<' && startsExpression(i, lastNonWs) && opensElement(i)
        && !(dialect.typescript && genericFunctionType(i))) {
        copy(i);
        const mark = parts.length;
        emit(' ');
        const end = element(i);
        if (end >= 0) {
          emit(' ');
          i = end;
          spanStart = i;
          // An element is a value: a `/` after it is division.
          lastNonWs = ')';
          continue;
        }
        // A closing tag that names another element shows this `<` opened
        // none: it is a character. One the input ends inside is neither
        // decided way, and guessing on would lose what follows.
        if (end === ENDS_INSIDE) throw new UndecidableSourceError(i);
        parts.length = mark;
        spanStart = i;
      }
      step();
    }
    copy(N);
    return inBraces ? -1 : N;
  };

  /**
   * The JSX element at `start` (a `<`): its tags and text blanked, the code
   * of its `{…}` expressions written to `parts`. Returns the index after
   * it; ENDS_INSIDE when the input ends inside it; NOT_AN_ELEMENT when the
   * first closing tag it meets names another element.
   */
  const element = (start: number): number => {
    const name = tagName(start + 1);
    let i = start + 1 + name.length;
    // The opening tag, to `/>` or `>`: attribute names, strings (JSX has no
    // escapes in them), `{…}` expressions, and comments between attributes.
    for (;;) {
      if (i >= N) return ENDS_INSIDE;
      const ch = src[i];
      if (ch === '/' && src[i + 1] === '>') return i + 2;
      if (ch === '>') { i++; break; }
      if (ch === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i);
        i = end < 0 ? N : end;
      } else if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) return ENDS_INSIDE;
        i = end + 2;
      } else if (ch === '"' || ch === "'") {
        const close = src.indexOf(ch, i + 1);
        if (close < 0) return ENDS_INSIDE;
        i = close + 1;
      } else if (ch === '{') {
        i = expression(i);
        if (i < 0) return ENDS_INSIDE;
      } else {
        i++;
      }
    }
    // Children, to the closing tag: text, elements and `{…}` expressions.
    for (;;) {
      if (i >= N) return ENDS_INSIDE;
      const ch = src[i];
      if (ch === '<') {
        let j = i + 1;
        while (j < N && /\s/.test(src[j])) j++;
        if (src[j] === '/') {
          j++;
          while (j < N && /\s/.test(src[j])) j++;
          if (tagName(j) !== name) return NOT_AN_ELEMENT;
          const close = src.indexOf('>', j);
          return close < 0 ? ENDS_INSIDE : close + 1;
        }
        if (opensElement(i)) {
          const mark = parts.length;
          const end = element(i);
          if (end === ENDS_INSIDE) return ENDS_INSIDE;
          if (end >= 0) {
            i = end;
            continue;
          }
          parts.length = mark;
        }
        i++;
      } else if (ch === '{') {
        i = expression(i);
        if (i < 0) return ENDS_INSIDE;
      } else {
        i++;
      }
    }
  };

  /** The JSX tag name at `i` (`div`, `Foo.Bar`, `svg:rect`, `data-x`), `''` for a fragment. */
  const tagName = (i: number): string => {
    let end = i;
    while (end < N && /[\w$.:-]/.test(src[end])) end++;
    return src.slice(i, end);
  };

  /** A JSX `{…}` expression at `open`: its code written to `parts`; the index after its `}`, or -1. */
  const expression = (open: number): number => {
    parts.push(' ');
    const end = code(open + 1, true);
    parts.push(' ');
    return end;
  };

  code(0, false);
  return parts.join('');
}
