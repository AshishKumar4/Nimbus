/**
 * One JavaScript source scanner shared by the two comment-stripping
 * call sites — prefetch's import detection and the esbuild transform
 * pipeline's classifiers.
 *
 * `scanJsSource(src, literals)` walks `src` once and returns a
 * byte-aligned copy in which `//` and `/* … *\/` comments are blanked
 * (each comment becomes a space; newlines inside a block comment are
 * preserved so line numbers still match the input). String, template
 * and regex literals are what `literals` decides:
 *
 *   - `'blank'`: literal content is replaced too — templates keep their
 *     `${…}` interpolation expression as code so a depth-tracked caller
 *     sees `await` etc. inside it. This is the transform pipeline's
 *     classification view: nothing quoted can read as an `import`.
 *   - `'keep'`: literals are copied verbatim. This is prefetch's
 *     import-detection view: IMPORT_RE/REQUIRE_RE must see the
 *     specifier string, and a `//` or `/*` inside a literal must NOT
 *     open a comment that swallows a following real import.
 *
 * The output is assembled from input slices and joined once. It used to
 * be built one character at a time (`stripped += c`), which V8 keeps as
 * a rope of one node per append — ~30 bytes of heap per character, all
 * live until the string is first read. On typescript's 6.15 MB
 * `lib/_tsc.js` that rope measured 174 MB against a 128 MB isolate —
 * the session Durable Object was killed inside `tsc`'s spawn before the
 * facet existed. Spans hold the input, the output and a short array.
 *
 * Serialized by name: `generateEsbuildTransformRuntimeSource` embeds
 * this function's `.toString()` in the transform runtime, so every
 * constant it reads is declared inside the body.
 */
export function scanJsSource(src: string, literals: 'keep' | 'blank'): string {
  const NEWLINE = 0x0a;
  // Identifier-suffix detection: `/` after one of these is division;
  // after anything else (operators, punctuators, keywords, start-of-file)
  // it opens a regex literal. Word chars + `)` + `]` cover `foo()/x` and
  // `a[i]/y`; the quote characters cover `'…' /re/` and `` `…` /re/ ``.
  const DIVISION_AFTER = /[A-Za-z0-9_$\)\]'\"`]/;

  const parts: string[] = [];
  // Start of the span not yet copied to `parts`.
  let spanStart = 0;
  let i = 0;
  const N = src.length;
  let lastNonWs = '';
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
  if (src.charCodeAt(0) === 0x23 && src.charCodeAt(1) === 0x21) {
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
      // Regex literal when the previous non-ws char can't end a value.
      if (!DIVISION_AFTER.test(lastNonWs)) {
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
      if (literals === 'keep') {
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
      // blank: the delimiters and content become one space; a template's
      // `${…}` interpolation keeps its expression as code.
      copy(i);
      emit(' ');
      i++;
      while (i < N) {
        const cc = src[i];
        if (cc === '\\') { i += 2; continue; }
        if (cc === ch) { i++; break; }
        if (ch === '`' && cc === '$' && src[i + 1] === '{') {
          emit('${');
          i += 2;
          let depth = 1;
          while (i < N && depth > 0) {
            const ic = src[i];
            // Nested string inside the interpolation: blank its content
            // so a `}` inside it doesn't drop the depth early.
            if (ic === '"' || ic === "'" || ic === '`') {
              const iq = ic;
              emit(' ');
              i++;
              while (i < N) {
                const icc = src[i];
                if (icc === '\\') { i += 2; continue; }
                if (icc === iq) { i++; break; }
                // A nested template's own ${…} recurses once more —
                // deeper nesting falls back to brace counting.
                if (iq === '`' && icc === '$' && src[i + 1] === '{') {
                  emit('${');
                  i += 2;
                  let d2 = 1;
                  while (i < N && d2 > 0) {
                    const i2 = src[i];
                    if (i2 === '{') d2++;
                    else if (i2 === '}') d2--;
                    if (d2 > 0) emit(i2);
                    i++;
                  }
                  emit('}');
                  continue;
                }
                if (icc === '\n') emit('\n');
                i++;
              }
              continue;
            }
            if (ic === '{') depth++;
            else if (ic === '}') depth--;
            if (depth > 0) emit(ic);
            i++;
          }
          emit('}');
          continue;
        }
        if (cc === '\n') emit('\n');
        i++;
      }
      spanStart = i;
      continue;
    }
    step();
  }
  copy(N);
  return parts.join('');
}

/**
 * Strip comments for import/require detection. Literals are kept: the
 * specifier the regexes extract lives inside a string, and a comment
 * marker inside a string must not swallow the code that follows it.
 */
export function stripCommentsForImports(src: string): string {
  return scanJsSource(src, 'keep');
}
