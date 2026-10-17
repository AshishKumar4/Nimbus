/**
 * Bun.file and Bun.write over a process's Node `fs`. The `bun` preamble
 * (bun-runner.ts) and opencode's Bun polyfill (opencode-facet-runner.ts) are
 * generated text: each evaluates this module's compiled body
 * (BUN_FILE_API_SOURCE, scripts/compile-facet-bodies.mjs) over its own fs.
 *
 * Every read and write goes through fs.promises, which reaches a file the
 * process does not hold; a sync read refuses one.
 */
const MIME = {
    html: 'text/html', css: 'text/css', js: 'application/javascript',
    json: 'application/json', txt: 'text/plain', md: 'text/markdown',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml',
};
function isByteSource(value) {
    return 'arrayBuffer' in value && typeof value.arrayBuffer === 'function';
}
export function bunFileApi(fs) {
    const utf8 = new TextEncoder();
    function file(path) {
        const bytes = async () => {
            const b = await fs.promises.readFile(path);
            return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        };
        const text = async () => new TextDecoder().decode(await bytes());
        return {
            name: path,
            get size() {
                try {
                    return fs.statSync(path).size;
                }
                catch {
                    return 0;
                }
            },
            get type() {
                return MIME[(path.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
            },
            bytes,
            text,
            async json() { return JSON.parse(await text()); },
            async arrayBuffer() { return new Uint8Array(await bytes()).buffer; },
            async exists() {
                try {
                    return !(await fs.promises.stat(path)).isDirectory();
                }
                catch {
                    return false;
                }
            },
            stream() {
                return new ReadableStream({
                    async start(controller) { controller.enqueue(await bytes()); controller.close(); },
                });
            },
        };
    }
    async function bytesOf(data) {
        if (typeof data === 'string')
            return utf8.encode(data);
        if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer))
            return new Uint8Array(data);
        if (ArrayBuffer.isView(data))
            return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (typeof data === 'object' && data !== null && isByteSource(data))
            return new Uint8Array(await data.arrayBuffer());
        return utf8.encode(String(data));
    }
    async function write(dest, data) {
        const target = typeof dest === 'string' ? dest : dest?.name;
        if (typeof target !== 'string')
            throw new TypeError('Bun.write: dest must be a path or a BunFile');
        const bytes = await bytesOf(data);
        await fs.promises.writeFile(target, bytes);
        return bytes.byteLength;
    }
    return { file, write };
}
