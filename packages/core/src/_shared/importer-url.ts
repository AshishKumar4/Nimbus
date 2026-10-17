/**
 * importer-url.ts — the URL a module at a VFS path imports from, shared by
 * the interpreter (interpreter/index.ts) and the host (module-importer.ts).
 */

const HEX = '0123456789ABCDEF';

/** `%XX` of a byte. */
function percent(byte: number): string {
  return '%' + HEX[byte >> 4] + HEX[byte & 15];
}

/** Whether Node's pathToFileURL escapes the printable ASCII `code` (v22: these, then the URL parser's). */
function escaped(code: number): boolean {
  return code === 0x22 || code === 0x23 || code === 0x25 || code === 0x3c || code === 0x3e || code === 0x3f
    || code === 0x5b || code === 0x5c || code === 0x5d || code === 0x5e || code === 0x60 || code === 0x7b
    || code === 0x7c || code === 0x7d || code === 0x7e;
}

/**
 * The importer URL of the module at `path`: a VFS path, with or without its
 * leading slash, or a data: URL. A path's is Node's pathToFileURL of it:
 * printable ASCII as itself but `escaped`'s, everything else its UTF-8 bytes
 * percent-encoded (a lone surrogate U+FFFD's), so a `#` or `?` in a name is
 * part of the path. It calls no built-in method but `codeAt`, so the
 * interpreter gives its own (interpreter/intrinsics.ts charCodeAt): a
 * program may have replaced the others (tests/unit/primordials-audit.mjs).
 */
export function importerUrl(path: string, codeAt: (text: string, index: number) => number): string {
  if (path[0] === 'd' && path[1] === 'a' && path[2] === 't' && path[3] === 'a' && path[4] === ':') return 'data:text/javascript,';
  let at = 0;
  while (path[at] === '/') at++;
  let url = 'file:///';
  for (; at < path.length; at++) {
    let code = codeAt(path, at);
    if (code >= 0xd800 && code <= 0xdfff) {
      const low = code <= 0xdbff && at + 1 < path.length ? codeAt(path, at + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        at++;
      } else {
        code = 0xfffd;
      }
    }
    if (code > 0x20 && code < 0x7f && !escaped(code)) url += path[at];
    else if (code < 0x80) url += percent(code);
    else if (code < 0x800) url += percent(0xc0 | (code >> 6)) + percent(0x80 | (code & 63));
    else if (code < 0x10000) url += percent(0xe0 | (code >> 12)) + percent(0x80 | ((code >> 6) & 63)) + percent(0x80 | (code & 63));
    else url += percent(0xf0 | (code >> 18)) + percent(0x80 | ((code >> 12) & 63)) + percent(0x80 | ((code >> 6) & 63)) + percent(0x80 | (code & 63));
  }
  return url;
}
