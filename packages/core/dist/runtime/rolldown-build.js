/**
 * rolldown-build.ts — esbuild's build contract (EsbuildBuildHost:
 * esbuild-shaped options and a remote resolve/load plugin), run by rolldown.
 *
 * Every Nimbus build serves its modules from a plugin (EsbuildService's VFS
 * plugin, the pre-bundle facet's slice plugin), so rolldown never reads a
 * file: each import goes to `plugin.resolve` with esbuild's arguments (path,
 * importer, namespace, resolveDir, kind) and each module to `plugin.load`,
 * whose esbuild-shaped answer (contents, loader, resolveDir, errors) becomes
 * rolldown's. esbuild keys a module on (namespace, path); here a module of the
 * plugin's main namespace keeps its path as its id, so names of outputs come
 * from files as esbuild's do, and any other namespace is `\0<ns>:<path>`.
 *
 * What a caller reads comes back as esbuild gave it: output files at
 * `outdir/<name>` (or `outfile`), the metafile subset callers read (each
 * output's `entryPoint`, `cssBundle`, `bytes`), diagnostics as `{ text,
 * location }`, and a failed build as esbuild's "Build failed with N errors:"
 * message, its diagnostics alongside. Options no caller uses are refused
 * rather than ignored. CSS is bundled by css-bundle.ts, as esbuild bundled it.
 *
 * Self-contained but for types and css-bundle.ts: the build facet's runtime
 * bundles it (rolldown-facet/preamble.ts).
 */
import { bundleCss } from './css-bundle.js';
/** esbuild options a Nimbus build may pass; anything else is refused. */
const SUPPORTED = new Set([
    'entryPoints', 'bundle', 'format', 'target', 'platform', 'outdir', 'outfile', 'sourcemap', 'minify', 'external',
    'define', 'globalName', 'tsconfigRaw', 'alias', 'keepNames', 'entryNames', 'chunkNames', 'assetNames', 'metafile',
    'conditions', 'mainFields', 'logLevel',
]);
const LOADER_MODULE_TYPES = {
    js: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', json: 'json', text: 'text', base64: 'base64', dataurl: 'dataurl', binary: 'binary', empty: 'empty',
};
class BuildError extends Error {
    messages;
    constructor(messages) {
        super(messages.map((m) => m.text).join('\n'));
        this.messages = messages;
    }
}
function message(text, location = null, pluginName = '') {
    return { id: '', pluginName, text, location, notes: [], detail: undefined };
}
/** esbuild's location of `offset` (or of line/column) in `source`. */
function locate(file, source, line, column, length = 0) {
    const lines = source.split(/\r\n|\r|\n/);
    const lineText = lines[line - 1] ?? '';
    return { file, namespace: '', line, column, length, lineText, suggestion: '' };
}
/** `Build failed with N errors:` and one line per error, as esbuild words its rejection. */
export function esbuildFailureText(errors) {
    const lines = errors.map((e) => (e.location
        ? `${e.location.file}:${e.location.line}:${e.location.column}: ERROR: ${e.text}`
        : `error: ${e.text}`));
    return `Build failed with ${errors.length} error${errors.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}
function refuse(text) {
    throw new BuildError([message(text)]);
}
export async function buildWithRolldown(api, options, plugin) {
    const raised = [];
    try {
        return await build(api, options, plugin, raised);
    }
    catch (error) {
        const errors = error instanceof BuildError ? error.messages : messagesOf(error, raised);
        return { outputFiles: [], errors, warnings: [], failure: esbuildFailureText(errors) };
    }
}
/**
 * A rolldown failure's diagnostics; anything else is one error with its
 * message. An error the adapter raised from a hook (an unresolved import)
 * comes back inside rolldown's own, by text only: `raised` holds it as
 * esbuild worded and placed it.
 */
function messagesOf(error, raised) {
    const logs = error instanceof Error ? Reflect.get(error, 'errors') : undefined;
    if (!Array.isArray(logs) || !logs.length)
        return [message(error instanceof Error ? error.message : String(error))];
    const unclaimed = [...raised];
    return logs.map((log) => {
        const i = unclaimed.findIndex((m) => log.message.includes(m.text));
        return i >= 0 ? unclaimed.splice(i, 1)[0] : fromLog(log);
    });
}
let loadedForLog = new Map();
/** A rolldown diagnostic as esbuild's: its first line of text, its place in its module. */
function fromLog(log) {
    // rolldown's message repeats the code and draws the source; esbuild's text is the one line.
    // eslint-disable-next-line no-control-regex
    const plain = log.message.replace(/\u001b\[[0-9;]*m/g, '');
    const firstLine = plain.split('\n')[0].replace(/^\[[A-Z_]+\]\s*/, '').replace(/^(Error|Warning):\s*/, '');
    const loaded = log.id ? loadedForLog.get(log.id) : undefined;
    const location = log.loc && loaded
        ? locate(fileOf(loaded), loaded.source, log.loc.line, log.loc.column)
        : null;
    return message(firstLine, location, log.plugin ?? '');
}
/** How esbuild names a module's file in a diagnostic: `<namespace>:<path>`, the path alone for `file`. */
function fileOf(module) {
    return module.namespace === 'file' || module.namespace === '' ? module.path : `${module.namespace}:${module.path}`;
}
async function build(api, options, plugin, raised) {
    for (const [key, value] of Object.entries(options)) {
        if (value !== undefined && !SUPPORTED.has(key))
            refuse(`Nimbus's bundler does not support the esbuild option "${key}"`);
    }
    if (options.bundle === false)
        refuse('Nimbus\'s bundler only bundles (bundle: false is not supported)');
    if (options.tsconfigRaw !== undefined && options.tsconfigRaw !== '' && JSON.stringify(options.tsconfigRaw) !== '{}') {
        refuse('Nimbus\'s bundler does not support tsconfigRaw');
    }
    const entryPoints = Array.isArray(options.entryPoints) ? options.entryPoints : null;
    if (!entryPoints || entryPoints.some((e) => typeof e !== 'string'))
        refuse('Nimbus\'s bundler takes entryPoints as a list of paths');
    if (options.outfile && entryPoints.length !== 1)
        refuse('outfile needs exactly one entry point');
    const format = options.format ?? 'esm';
    if (format !== 'esm' && format !== 'cjs' && format !== 'iife')
        refuse(`Nimbus's bundler does not support format "${format}"`);
    const target = typeof options.target === 'string' ? options.target : 'esnext';
    if (!/^(esnext|es20\d\d)$/.test(target))
        refuse(`Nimbus's bundler does not support target "${String(options.target)}"`);
    const alias = Object.entries(options.alias ?? {});
    const aliased = (path) => {
        for (const [from, to] of alias) {
            if (path === from)
                return to;
            if (path.startsWith(from + '/'))
                return to + path.slice(from.length);
        }
        return path;
    };
    // The namespace most modules load in: the plugin's answer for the first entry.
    let mainNamespace = null;
    const idOf = (namespace, path) => (namespace === mainNamespace ? path : `\0${namespace}:${path}`);
    const loaded = new Map();
    loadedForLog = loaded;
    const decode = (id) => {
        const known = loaded.get(id);
        if (known)
            return known;
        const m = /^\0([^:]*):([\s\S]*)$/.exec(id);
        return m ? { namespace: m[1], path: m[2] } : { namespace: mainNamespace ?? 'file', path: id };
    };
    const pending = new Map();
    const css = [];
    const warnings = [];
    const raise = (text, importer, source) => {
        const from = importer ? loaded.get(importer) : undefined;
        let location = null;
        if (from) {
            const at = from.source.indexOf(JSON.stringify(source).slice(1, -1));
            if (at >= 0) {
                const before = from.source.slice(0, at);
                const line = before.split(/\r\n|\r|\n/).length;
                const column = at - Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) - 1 - 1;
                location = locate(fileOf(from), from.source, line, column, source.length + 2);
            }
        }
        raised.push(message(text, location, ''));
        throw new Error(text);
    };
    const vfs = {
        name: plugin.name,
        async resolveId(source, importer, extra) {
            if (source.startsWith('\0'))
                return null;
            const from = importer ? decode(importer) : null;
            const kind = extra.isEntry && !importer ? 'entry-point' : (extra.kind ?? 'import-statement');
            const path = kind === 'entry-point' ? source : aliased(source);
            const answer = await plugin.resolve({
                path,
                importer: from ? from.path : '',
                namespace: from ? from.namespace : 'file',
                resolveDir: from ? (loaded.get(importer)?.resolveDir ?? '') : '',
                kind: kind,
                with: extra.attributes ?? {},
            });
            if (answer?.errors?.length)
                raise(answer.errors[0].text ?? 'error', importer, source);
            if (answer?.warnings?.length)
                for (const w of answer.warnings)
                    warnings.push(message(w.text ?? ''));
            if (!answer || (!answer.path && !answer.external))
                raise(`Could not resolve ${JSON.stringify(source)}`, importer, source);
            if (answer.external)
                return { id: answer.path ?? path, external: true };
            const namespace = answer.namespace ?? 'file';
            if (mainNamespace === null)
                mainNamespace = namespace;
            const id = idOf(namespace, answer.path);
            pending.set(id, { namespace, path: answer.path });
            return id;
        },
        async load(id) {
            const { namespace, path } = pending.get(id) ?? decode(id);
            const answer = await plugin.load({ path, namespace, suffix: '', with: {} });
            if (answer?.errors?.length)
                raise(answer.errors[0].text ?? 'error', undefined, path);
            if (answer?.warnings?.length)
                for (const w of answer.warnings)
                    warnings.push(message(w.text ?? ''));
            if (!answer || answer.contents === undefined)
                raise(`No loader produced ${fileOf({ namespace, path })}`, undefined, path);
            const loader = answer.loader ?? 'js';
            const contents = answer.contents;
            const text = typeof contents === 'string' ? contents : loader === 'binary' || loader === 'base64' || loader === 'dataurl' || loader === 'file' ? '' : new TextDecoder().decode(contents);
            const lastSlash = path.lastIndexOf('/');
            loaded.set(id, {
                namespace, path,
                resolveDir: answer.resolveDir ?? (namespace === 'file' || namespace === mainNamespace ? (lastSlash > 0 ? path.slice(0, lastSlash) : '/') : ''),
                source: text,
            });
            if (loader === 'css') {
                css.push({ id, path, source: text });
                return { code: '', moduleType: 'js', moduleSideEffects: true };
            }
            const moduleType = LOADER_MODULE_TYPES[loader];
            if (!moduleType)
                raise(`Nimbus's bundler does not support the "${loader}" loader (${fileOf({ namespace, path })})`, undefined, path);
            if (typeof contents === 'string')
                return { code: contents, moduleType };
            // Byte loaders: rolldown takes their source as a string of the bytes' latin1 code units.
            let latin1 = '';
            for (let i = 0; i < contents.length; i += 0x8000)
                latin1 += String.fromCharCode(...contents.subarray(i, i + 0x8000));
            return { code: moduleType === 'binary' || moduleType === 'base64' || moduleType === 'dataurl' ? latin1 : text, moduleType };
        },
    };
    const bundle = await api.rolldown({
        input: entryPoints,
        cwd: '/',
        platform: options.platform ?? 'browser',
        plugins: [vfs],
        tsconfig: false,
        transform: {
            target,
            define: options.define,
            // esbuild's default for JSX without a tsconfig: React.createElement.
            jsx: { runtime: 'classic', pragma: 'React.createElement', pragmaFrag: 'React.Fragment' },
        },
        checks: { pluginTimings: false },
        onLog(level, log) {
            if (level === 'warn')
                warnings.push(fromLog(log));
        },
    });
    try {
        const template = (names, fallback) => (names ?? fallback).replace(/\[ext\]/g, '[extname]');
        const { output } = await bundle.generate({
            format: format === 'esm' ? 'es' : format,
            name: options.globalName,
            minify: options.minify === true,
            keepNames: options.keepNames === true,
            sourcemap: options.sourcemap === true || options.sourcemap === 'external' ? true : options.sourcemap === 'inline' ? 'inline' : false,
            entryFileNames: options.outfile ? options.outfile.slice(options.outfile.lastIndexOf('/') + 1) : `${template(options.entryNames, '[name]')}.js`,
            chunkFileNames: `${template(options.chunkNames, '[name]-[hash]')}.js`,
            assetFileNames: `${template(options.assetNames, '[name]-[hash]')}[extname]`,
            codeSplitting: false,
        });
        const outdir = options.outfile ? options.outfile.slice(0, options.outfile.lastIndexOf('/')) || '/' : (options.outdir ?? '/dist');
        const at = (fileName) => `${outdir.replace(/\/+$/, '')}/${fileName}`;
        const encoder = new TextEncoder();
        const outputFiles = [];
        const outputs = {};
        const relative = (path) => path.replace(/^\/+/, '');
        for (const out of output) {
            if (out.type === 'chunk') {
                const contents = encoder.encode(out.code);
                const path = at(out.fileName);
                outputFiles.push({ path, contents });
                const entry = out.isEntry && out.facadeModuleId ? decode(out.facadeModuleId) : null;
                const cssOfChunk = css.filter((m) => out.moduleIds.includes(m.id));
                let cssBundle;
                if (cssOfChunk.length) {
                    const cssPath = path.replace(/\.js$/, '.css');
                    const bundled = await bundleCss(cssOfChunk, plugin, { minify: options.minify === true });
                    outputFiles.push({ path: cssPath, contents: encoder.encode(bundled) });
                    outputs[relative(cssPath)] = { imports: [], exports: [], inputs: {}, bytes: bundled.length };
                    cssBundle = relative(cssPath);
                }
                outputs[relative(path)] = {
                    imports: [], exports: out.exports, inputs: {}, bytes: contents.length,
                    ...(entry ? { entryPoint: fileOf(entry) } : {}),
                    ...(cssBundle ? { cssBundle } : {}),
                };
            }
            else {
                const contents = typeof out.source === 'string' ? encoder.encode(out.source) : out.source;
                const path = at(out.fileName);
                outputFiles.push({ path, contents });
                outputs[relative(path)] = { imports: [], exports: [], inputs: {}, bytes: contents.length };
            }
        }
        return { outputFiles, errors: [], warnings, metafile: { inputs: {}, outputs } };
    }
    finally {
        await bundle.close();
    }
}
