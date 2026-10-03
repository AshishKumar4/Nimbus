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
    js: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', json: 'json', text: 'text', base64: 'base64', dataurl: 'dataurl', empty: 'empty',
};
/**
 * Where `module` names `source` as an import (static, dynamic, re-exported or
 * required): the span of the first such string literal, by the parser, so a
 * same-text string elsewhere in the file does not stand in for it.
 */
function importSpan(module, source, parse) {
    let program;
    try {
        program = parse(module.source, { lang: module.lang });
    }
    catch {
        return null;
    }
    let found = null;
    const literal = (node) => {
        const n = node;
        if (n?.type !== 'Literal' || n.value !== source || typeof n.start !== 'number' || typeof n.end !== 'number')
            return;
        if (found === null || n.start < found[0])
            found = [n.start, n.end];
    };
    const visit = (node) => {
        if (!node || typeof node !== 'object')
            return;
        if (Array.isArray(node)) {
            for (const child of node)
                visit(child);
            return;
        }
        const n = node;
        switch (n.type) {
            case 'ImportDeclaration':
            case 'ExportNamedDeclaration':
            case 'ExportAllDeclaration':
            case 'ImportExpression':
                literal(n.source);
                break;
            case 'TSExternalModuleReference':
                literal(n.expression);
                break;
            case 'CallExpression': {
                const callee = n.callee;
                if (callee?.type === 'Identifier' && callee.name === 'require')
                    literal(n.arguments?.[0]);
                break;
            }
        }
        for (const [key, child] of Object.entries(n))
            if (key !== 'parent')
                visit(child);
    };
    visit(program);
    return found;
}
const utf8Length = (text) => new TextEncoder().encode(text).length;
/** `bytes` in base64. */
function base64Of(bytes) {
    let latin1 = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
        latin1 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(latin1);
}
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
    // This build's diagnostics and modules: overlapping builds each keep their own.
    const state = { raised: [], unresolved: [], loaded: new Map() };
    try {
        return await build(api, options, plugin, state);
    }
    catch (error) {
        const errors = error instanceof BuildError ? error.messages : sortedMessages([...state.unresolved, ...messagesOf(error, state.raised, state.loaded)]);
        return { outputFiles: [], errors, warnings: [], failure: esbuildFailureText(errors) };
    }
}
/** In esbuild's order: by file, line and column, those without a place first. */
function sortedMessages(messages) {
    const key = (m) => m.location;
    return messages
        .map((m, i) => [m, i])
        .sort(([a, i], [b, j]) => {
        const la = key(a);
        const lb = key(b);
        if (!la || !lb)
            return la ? 1 : lb ? -1 : i - j;
        if (la.file !== lb.file)
            return la.file < lb.file ? -1 : 1;
        return la.line - lb.line || la.column - lb.column || i - j;
    })
        .map(([m]) => m);
}
/**
 * A rolldown failure's diagnostics; anything else is one error with its
 * message. An error the adapter raised from a hook (a load the plugin failed)
 * comes back inside rolldown's own, by text only: `raised` holds it as
 * esbuild worded it.
 */
function messagesOf(error, raised, loaded) {
    const logs = error instanceof Error ? Reflect.get(error, 'errors') : undefined;
    if (!Array.isArray(logs) || !logs.length)
        return [message(error instanceof Error ? error.message : String(error))];
    const unclaimed = [...raised];
    return logs.map((log) => {
        const i = unclaimed.findIndex((m) => log.message.includes(m.text));
        return i >= 0 ? unclaimed.splice(i, 1)[0] : fromLog(log, loaded);
    });
}
/** A rolldown diagnostic as esbuild's: its first line of text, its place in its module. */
function fromLog(log, modules) {
    // rolldown's message repeats the code and draws the source; esbuild's text is the one line.
    // eslint-disable-next-line no-control-regex
    const plain = log.message.replace(/\u001b\[[0-9;]*m/g, '');
    const firstLine = plain.split('\n')[0].replace(/^\[[A-Z_]+\]\s*/, '').replace(/^(Error|Warning):\s*/, '');
    const loaded = log.id ? modules.get(log.id) : undefined;
    const location = log.loc && loaded
        ? locate(fileOf(loaded), loaded.source, log.loc.line, log.loc.column)
        : null;
    return message(firstLine, location, log.plugin ?? '');
}
/** How esbuild names a module's file in a diagnostic: `<namespace>:<path>`, the path alone for `file`. */
function fileOf(module) {
    return module.namespace === 'file' || module.namespace === '' ? module.path : `${module.namespace}:${module.path}`;
}
async function build(api, options, plugin, { raised, unresolved, loaded }) {
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
    const raise = (text, pluginName = '') => {
        raised.push(message(text, null, pluginName));
        throw new Error(text);
    };
    // An import that did not resolve, placed at its string literal as esbuild
    // places it (column and length in UTF-8 bytes). The import stays external
    // so the build goes on to report every other error with it.
    const unresolvedImport = (text, importer, source, pluginName, parse) => {
        const from = importer ? loaded.get(importer) : undefined;
        let location = null;
        const span = from?.lang ? importSpan(from, source, parse) : null;
        if (from && span) {
            const before = from.source.slice(0, span[0]);
            const line = before.split(/\r\n|\r|\n/).length;
            const lineStart = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1;
            location = locate(fileOf(from), from.source, line, utf8Length(before.slice(lineStart)), utf8Length(from.source.slice(span[0], span[1])));
        }
        unresolved.push(message(text, location, pluginName));
        return { id: source, external: true };
    };
    const vfs = {
        name: plugin.name,
        async resolveId(source, importer, extra) {
            const parse = this.parse.bind(this);
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
                return unresolvedImport(answer.errors[0].text ?? 'error', importer, source, plugin.name, parse);
            if (answer?.warnings?.length)
                for (const w of answer.warnings)
                    warnings.push(message(w.text ?? ''));
            if (!answer || (!answer.path && !answer.external))
                return unresolvedImport(`Could not resolve ${JSON.stringify(source)}`, importer, source, '', parse);
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
                raise(answer.errors[0].text ?? 'error', plugin.name);
            if (answer?.warnings?.length)
                for (const w of answer.warnings)
                    warnings.push(message(w.text ?? ''));
            if (!answer || answer.contents === undefined)
                raise(`No loader produced ${fileOf({ namespace, path })}`);
            const loader = answer.loader ?? 'js';
            const contents = answer.contents;
            const text = typeof contents === 'string' ? contents : loader === 'binary' || loader === 'base64' || loader === 'dataurl' || loader === 'file' ? '' : new TextDecoder().decode(contents);
            const lastSlash = path.lastIndexOf('/');
            loaded.set(id, {
                namespace, path,
                resolveDir: answer.resolveDir ?? (namespace === 'file' || namespace === mainNamespace ? (lastSlash > 0 ? path.slice(0, lastSlash) : '/') : ''),
                source: text,
                lang: loader === 'js' || loader === 'jsx' || loader === 'ts' || loader === 'tsx' ? loader : undefined,
            });
            if (loader === 'css') {
                css.push({ id, path, source: text });
                return { code: '', moduleType: 'js', moduleSideEffects: true };
            }
            // A Uint8Array of the bytes, decoded from base64 as esbuild's __toBinary does:
            // rolldown's `binary` takes a string, and would store its UTF-8.
            if (loader === 'binary') {
                const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
                return { code: `export default /* @__PURE__ */ Uint8Array.from(atob(${JSON.stringify(base64Of(bytes))}), (c) => c.charCodeAt(0));`, moduleType: 'js' };
            }
            const moduleType = LOADER_MODULE_TYPES[loader];
            if (!moduleType)
                raise(`Nimbus's bundler does not support the "${loader}" loader (${fileOf({ namespace, path })})`);
            if (typeof contents === 'string')
                return { code: contents, moduleType };
            // Byte loaders: rolldown takes their source as a string of the bytes' latin1 code units.
            let latin1 = '';
            for (let i = 0; i < contents.length; i += 0x8000)
                latin1 += String.fromCharCode(...contents.subarray(i, i + 0x8000));
            return { code: moduleType === 'base64' || moduleType === 'dataurl' ? latin1 : text, moduleType };
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
        // esbuild keeps an imported constant a reference: inlining its value
        // changes what a cycle sees before the constant's module has run.
        optimization: { inlineConst: false },
        onLog(level, log) {
            if (level === 'warn')
                warnings.push(fromLog(log, loaded));
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
        if (unresolved.length)
            throw new BuildError(sortedMessages(unresolved));
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
