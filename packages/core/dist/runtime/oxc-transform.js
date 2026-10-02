/**
 * oxc-transform.ts — esbuild's `transform()` contract, run by Nimbus's Oxc
 * build (packages/worker/scripts/oxc-wasm).
 *
 * `createOxcTransform(module)` answers the esbuild transform calls Nimbus
 * makes (esbuild-service.ts's transformWithEsbuild and runTransformRequest)
 * with the same output contract: the loaders `js`, `jsx`, `ts` and `tsx`;
 * `format` unset (module syntax kept), `esm` or `cjs` with esbuild's interop
 * helpers and `__esModule` marking; `define`; `supported['dynamic-import']`
 * and `supported['import-meta']`; JSX classic, automatic or preserved;
 * source maps returned or inlined; and esbuild's error message shape, down to
 * the top-level-await refusal the caller recognizes. Anything else a caller
 * asks for (another target, minify, a tsconfig, CSS) is refused rather than
 * ignored: there is no caller for it, and silently doing less would be wrong.
 *
 * The wasm imports nothing and keeps nothing between calls; its linear
 * memory, which only grows, is the largest module's working set. An instance
 * whose memory passed `retireAboveBytes` is dropped after its call, and one
 * that trapped is never called again: the next call instantiates afresh.
 *
 * Self-contained (no imports, nothing from module scope) so the transform
 * facet can evaluate it from its source text.
 */
export function createOxcTransform(module, { retireAboveBytes = 64 * 1024 * 1024 } = {}) {
    // Core's ambient TextEncoder (substrate/lifo/platform-globals.d.ts) declares
    // encode() alone; every runtime this runs on has encodeInto().
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let instance = null;
    let lastArena = { used: 0, reserved: 0 };
    const KNOWN = {
        loader: true, format: true, target: true, sourcemap: true, sourcefile: true, minify: true, jsx: true,
        jsxFactory: true, jsxFragment: true, tsconfigRaw: true, define: true, supported: true,
    };
    function wire(options) {
        for (const key of Object.keys(options)) {
            if (KNOWN[key] !== true && Reflect.get(options, key) !== undefined)
                throw new Error(`oxc transform: option "${key}" is not supported`);
        }
        const loader = options.loader ?? 'js';
        if (loader !== 'js' && loader !== 'jsx' && loader !== 'ts' && loader !== 'tsx') {
            throw new Error(`oxc transform: loader "${loader}" is not supported`);
        }
        const format = options.format === undefined ? 'preserve' : options.format;
        if (format !== 'preserve' && format !== 'esm' && format !== 'cjs')
            throw new Error(`oxc transform: format "${format}" is not supported`);
        if (options.target !== undefined && options.target !== 'esnext') {
            throw new Error(`oxc transform: target "${options.target}" is not supported; only esnext`);
        }
        if (options.minify)
            throw new Error('oxc transform: minify is not supported');
        if (options.tsconfigRaw !== undefined && options.tsconfigRaw !== '' && JSON.stringify(options.tsconfigRaw) !== '{}') {
            throw new Error('oxc transform: tsconfigRaw is not supported');
        }
        const sourcemap = options.sourcemap === undefined || options.sourcemap === false ? 'none'
            : options.sourcemap === true || options.sourcemap === 'external' ? 'external'
                : options.sourcemap === 'inline' ? 'inline' : null;
        if (sourcemap === null)
            throw new Error(`oxc transform: sourcemap "${String(options.sourcemap)}" is not supported`);
        const jsx = options.jsx ?? 'transform';
        if (jsx !== 'transform' && jsx !== 'automatic' && jsx !== 'preserve')
            throw new Error(`oxc transform: jsx "${jsx}" is not supported`);
        if (jsx === 'preserve' && format === 'cjs' && (loader === 'jsx' || loader === 'tsx')) {
            throw new Error('oxc transform: jsx "preserve" is not supported with format "cjs"');
        }
        const fields = ['loader', loader, 'format', format, 'jsx', jsx, 'sourcemap', sourcemap];
        if (options.jsxFactory)
            fields.push('jsxFactory', options.jsxFactory);
        if (options.jsxFragment)
            fields.push('jsxFragment', options.jsxFragment);
        if (options.sourcefile)
            fields.push('sourcefile', options.sourcefile);
        for (const [name, value] of Object.entries(options.define ?? {}))
            fields.push('define', name, value);
        for (const [feature, supported] of Object.entries(options.supported ?? {})) {
            if (feature === 'dynamic-import')
                fields.push('dynamicImport', supported ? '1' : '0');
            else if (feature === 'import-meta')
                fields.push('importMeta', supported ? '1' : '0');
            else if (!supported)
                throw new Error(`oxc transform: supported["${feature}"] = false is not supported`);
        }
        for (const field of fields) {
            if (field.includes('\0'))
                throw new Error('oxc transform: an option contains a NUL character');
        }
        return fields.join('\0');
    }
    function messages(text) {
        const errors = [];
        const warnings = [];
        const fields = text.split('\0');
        for (let i = 0; i + 7 <= fields.length; i += 7) {
            const [kind, line, column, length, file, lineText, message] = fields.slice(i, i + 7);
            const lineNumber = Number(line);
            const location = lineNumber > 0
                ? { file, namespace: file === '<stdin>' ? '' : 'file', line: lineNumber, column: Number(column), length: Number(length), lineText, suggestion: '' }
                : null;
            (kind === 'E' ? errors : warnings).push({ id: '', pluginName: '', text: message, location, notes: [], detail: undefined });
        }
        return { errors, warnings };
    }
    function failure(errors, warnings) {
        const lines = errors.map((e) => e.location
            ? `${e.location.file}:${e.location.line}:${e.location.column}: ERROR: ${e.text}`
            : `error: ${e.text}`);
        const count = errors.length === 1 ? '1 error' : `${errors.length} errors`;
        return Object.assign(new Error(`Transform failed with ${count}:\n${lines.join('\n')}`), { errors, warnings });
    }
    function run(code, optionsWire) {
        const exports = instance ??= new WebAssembly.Instance(module, {}).exports;
        const options = encoder.encode(optionsWire);
        // Room for the source as ASCII, grown only by what its other characters need.
        let capacity = code.length + options.length;
        let ptr = exports.nimbus_oxc_alloc(capacity);
        let read = 0;
        let written = 0;
        for (;;) {
            const into = new Uint8Array(exports.memory.buffer, ptr + written, capacity - options.length - written);
            const step = encoder.encodeInto(read === 0 ? code : code.slice(read), into);
            read += step.read;
            written += step.written;
            if (read >= code.length)
                break;
            const grown = written + (code.length - read) * 3 + options.length;
            ptr = exports.nimbus_oxc_realloc(ptr, capacity, grown);
            capacity = grown;
        }
        new Uint8Array(exports.memory.buffer, ptr + written, options.length).set(options);
        const at = exports.nimbus_oxc_transform(ptr, capacity, written, options.length);
        try {
            const [status, codePtr, codeLength, mapPtr, mapLength, diagnosticsPtr, diagnosticsLength, arenaUsed, arenaReserved] = new Uint32Array(exports.memory.buffer, at, 9);
            lastArena = { used: arenaUsed, reserved: arenaReserved };
            const memory = exports.memory.buffer;
            const { errors, warnings } = messages(decoder.decode(new Uint8Array(memory, diagnosticsPtr, diagnosticsLength)));
            if (status !== 0) {
                if (status === 2)
                    throw Object.assign(new Error(`oxc transform: ${errors[0]?.text ?? 'the options were refused'}`), { errors, warnings });
                throw failure(errors, warnings);
            }
            return {
                code: decoder.decode(new Uint8Array(memory, codePtr, codeLength)),
                map: decoder.decode(new Uint8Array(memory, mapPtr, mapLength)),
                warnings,
            };
        }
        finally {
            exports.nimbus_oxc_release();
        }
    }
    return {
        async transform(code, options = {}) {
            const optionsWire = wire(options);
            try {
                return run(code, optionsWire);
            }
            catch (error) {
                if (error instanceof Error && Reflect.get(error, 'errors') !== undefined)
                    throw error;
                // A trap, or the host's stack running out inside a deeply nested
                // module, leaves the instance mid-call: never call it again.
                instance = null;
                const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                throw new Error(`Transform failed with 1 error:\nerror: the Oxc transform crashed (${reason})`);
            }
            finally {
                if (instance && instance.memory.buffer.byteLength > retireAboveBytes)
                    instance = null;
            }
        },
        memoryBytes: () => (instance ? instance.memory.buffer.byteLength : 0),
        lastArena: () => lastArena,
    };
}
