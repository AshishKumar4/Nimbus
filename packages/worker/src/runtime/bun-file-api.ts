/**
 * Bun.file and Bun.write over a Node `fs`, as source: a function of `fs`
 * answering `{ file, write }`. The `bun` preamble (bun-runner.ts) and
 * opencode's Bun polyfill (opencode-facet-runner.ts) each evaluate it over
 * their process's fs. Every read and write goes through fs.promises, which
 * reaches a file this process does not hold; a sync read refuses one.
 */
export const BUN_FILE_API = `
(fs) => {
  const MIME = { html: 'text/html', css: 'text/css', js: 'application/javascript',
    json: 'application/json', txt: 'text/plain', md: 'text/markdown',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };
  const utf8 = new TextEncoder();

  function file(p) {
    const bytes = async () => {
      const b = await fs.promises.readFile(p);
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    };
    const text = async () => new TextDecoder().decode(await bytes());
    return {
      name: p,
      get size() {
        try { return fs.statSync(p).size; } catch { return 0; }
      },
      get type() {
        return MIME[(String(p).split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
      },
      bytes,
      text,
      async json() { return JSON.parse(await text()); },
      async arrayBuffer() {
        const b = await bytes();
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      async exists() {
        try { return !(await fs.promises.stat(p)).isDirectory(); } catch { return false; }
      },
      stream() {
        return new ReadableStream({
          async start(controller) { controller.enqueue(await bytes()); controller.close(); },
        });
      },
    };
  }

  async function bytesOf(data) {
    if (typeof data === 'string') return utf8.encode(data);
    if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data !== null && typeof data === 'object' && typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
    return utf8.encode(String(data));
  }

  async function write(dest, data) {
    let target;
    if (typeof dest === 'string') target = dest;
    else if (dest && typeof dest.name === 'string') target = dest.name;
    else throw new TypeError('Bun.write: dest must be a path or a BunFile');
    const bytes = await bytesOf(data);
    await fs.promises.writeFile(target, bytes);
    return bytes.byteLength;
  }

  return { file, write };
}
`.trim();
