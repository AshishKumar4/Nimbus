// A test-only USTAR encoder, independent of the decoders the tests check:
// header fields go in as given, so a malformed field (a raw name, another
// magic, a declared size the data does not have) stays malformed.

const enc = new TextEncoder();

/** One header block. `raw` is the name field's bytes, verbatim; `size` is what the header declares. */
export function ustarHeader({ name = '', prefix = '', size = 0, type = '0', mode = 0o644, mtime = 0, magic = 'ustar\0', version = '00', raw = null }) {
  const block = new Uint8Array(512);
  const put = (text, at, length) => block.set(enc.encode(text).slice(0, length), at);
  const octal = (value, at, length) => put(value.toString(8).padStart(length - 1, '0') + '\0', at, length);
  if (raw) block.set(raw.slice(0, 100), 0);
  else put(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(mtime, 136, 12);
  block[156] = type.charCodeAt(0);
  put(magic, 257, 6);
  put(version, 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}

/** The name and prefix fields of `path`: past ustar's 100-byte name, its directory goes in the 155-byte prefix. */
export function ustarPath(path) {
  const split = path.length > 100 ? path.lastIndexOf('/') : -1;
  return split > 0 ? { name: path.slice(split + 1), prefix: path.slice(0, split) } : { name: path };
}

/**
 * An archive of `entries`, each a header's fields and its bytes (`data`),
 * the header declaring the data's size unless the entry names another, then
 * the two zero blocks that end it.
 */
export function ustarArchive(entries) {
  const parts = [];
  for (const { data = new Uint8Array(0), ...fields } of entries) {
    parts.push(ustarHeader({ size: data.length, ...fields }));
    if (data.length > 0) {
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
      padded.set(data);
      parts.push(padded);
    }
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
