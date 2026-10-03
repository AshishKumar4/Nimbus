/**
 * css-bundle.ts — the CSS a bundle's JavaScript imports, as one stylesheet,
 * by esbuild 0.24's rules (what the built-in `vite build` shipped before).
 *
 * rolldown 1.2 no longer bundles CSS, so rolldown-build.ts loads every CSS
 * module as an empty JavaScript module and hands a chunk's CSS modules here
 * in the order the chunk's JavaScript imports them. Each sheet is read
 * through css-syntax.ts (css-tree), and the graph and cascade policy is
 * esbuild's linker, ported (internal/linker/linker.go at v0.24.2):
 *
 *   - Every sheet is resolved, loaded and parsed once per build, however
 *     often it is imported (each resolve and load is a call back to the
 *     session that owns the files).
 *   - The import order is esbuild's findImportedFilesInCSSOrder: depth-first,
 *     every `@import` evaluated each time it appears, a sheet already on the
 *     import stack skipped (a cycle); each import's conditions wrap all it
 *     imports. Layer names a sheet orders before its first `@import` come
 *     first; external imports (`http:`, `https:`, `//`, or resolved external)
 *     are hoisted to the top, keeping their importers' conditions (nested
 *     through `data:` stylesheet imports where one `@import` cannot carry them).
 *   - A sheet or external import that appears again later, under conditions
 *     that apply wherever the earlier ones did (isConditionalImportRedundant),
 *     keeps only its last place; the earlier place keeps the layer order it
 *     set (`@layer a;`), and redundant layer statements are dropped and
 *     adjacent ones merged, as esbuild does.
 *   - A sheet's `url()`s are resolved and loaded through the build's plugin
 *     (kind `url-token`): a `file` loader makes an emitted asset, written as
 *     a path relative to the stylesheet, a `dataurl` loader a data URL; any
 *     other loader cannot be a URL. `data:`, `http(s):`, `//` and `#` URLs
 *     are left alone. `@import` paths resolve with kind `import-rule`, and
 *     what they load must be CSS.
 *   - `@charset` becomes one `@charset "UTF-8";` first; legal comments move
 *     to the end, once each.
 *
 * Minifying prints rules as css-tree's generator does (no comments, no
 * whitespace a rule does not need); it does not rewrite values, so a sheet
 * is larger than esbuild's, never different in meaning.
 */
import { componentsEqual, parseSheet, printComponents, quoteString, sheetRules, sheetUrls, } from './css-syntax.js';
export class CssError extends Error {
    diagnostic;
    constructor(diagnostic) {
        super(diagnostic.text);
        this.diagnostic = diagnostic;
    }
}
const isExternalUrl = (url) => /^(data:|https?:|\/\/|#)/i.test(url);
const isRemoteImport = (path) => /^(https?:)?\/\//i.test(path);
const isCssLoader = (loader) => loader === 'css' || loader === 'global-css' || loader === 'local-css';
/** How esbuild names a module in a diagnostic: `<namespace>:<path>`, the path alone for `file`. */
function fileOf(module) {
    return module.namespace === 'file' || module.namespace === '' ? module.path : `${module.namespace}:${module.path}`;
}
const utf8Length = (text) => new TextEncoder().encode(text).length;
export async function bundleCss(modules, plugin, assets, { minify }) {
    const fail = (module, at, length, text, pluginName = '') => {
        const before = module.source.slice(0, at);
        const line = before.split(/\r\n|\r|\n/).length;
        const lineStart = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1;
        const lineEnd = module.source.slice(at).search(/\r|\n/);
        throw new CssError({
            id: '', pluginName, text, notes: [], detail: undefined,
            location: {
                file: fileOf(module), namespace: '', line, column: utf8Length(before.slice(lineStart)),
                length: utf8Length(module.source.slice(at, at + length)),
                lineText: module.source.slice(lineStart, lineEnd < 0 ? undefined : at + lineEnd), suggestion: '',
            },
        });
    };
    // Every resolve and load once per build: each is a call to the session.
    const resolved = new Map();
    const loadedModules = new Map();
    const resolve = async (from, path, kind, at, length) => {
        const key = `${fileOf(from)}\0${kind}\0${path}`;
        if (!resolved.has(key)) {
            resolved.set(key, plugin.resolve({ path, importer: from.path, namespace: from.namespace, resolveDir: from.resolveDir, kind, with: {} }));
        }
        const answer = await resolved.get(key);
        if (answer?.errors?.length)
            fail(from, at, length, answer.errors[0].text ?? 'error', plugin.name);
        if (!answer || (!answer.path && !answer.external))
            fail(from, at, length, `Could not resolve ${JSON.stringify(path)}`);
        return answer;
    };
    const load = async (from, module, at, length) => {
        const key = fileOf(module);
        if (!loadedModules.has(key))
            loadedModules.set(key, plugin.load({ path: module.path, namespace: module.namespace, suffix: '', with: {} }));
        const answer = await loadedModules.get(key);
        if (answer?.errors?.length)
            fail(from, at, length, answer.errors[0].text ?? 'error', plugin.name);
        if (!answer || answer.contents === undefined)
            fail(from, at, length, `Could not load ${fileOf(module)}`);
        return answer;
    };
    // ── The graph: each sheet once, its imports resolved in order ──────────────
    const files = new Map();
    const add = async (module) => {
        const key = fileOf(module);
        const known = files.get(key);
        if (known)
            return known;
        const file = { key, module, sheet: parseSheet(module.source), targets: [], rules: [] };
        files.set(key, file);
        if (file.sheet.missingUrl)
            fail(module, file.sheet.missingUrl.at, file.sheet.missingUrl.length, 'Expected URL token');
        for (const rule of file.sheet.imports) {
            if (isRemoteImport(rule.path)) {
                file.targets.push({ kind: 'external', path: rule.path });
                continue;
            }
            const answer = await resolve(module, rule.path, 'import-rule', rule.at, rule.length);
            if (answer.external) {
                file.targets.push({ kind: 'external', path: answer.path ?? rule.path });
                continue;
            }
            const child = { namespace: answer.namespace ?? 'file', path: answer.path };
            const loaded = await load(module, child, rule.at, rule.length);
            if (loaded.loader === 'empty') {
                file.targets.push({ kind: 'empty' });
                continue;
            }
            if (!isCssLoader(loaded.loader ?? 'css'))
                fail(module, rule.at, rule.length, `Cannot import ${JSON.stringify(fileOf(child))} into a CSS file`);
            const source = typeof loaded.contents === 'string' ? loaded.contents : new TextDecoder().decode(loaded.contents);
            const lastSlash = child.path.lastIndexOf('/');
            const resolveDir = loaded.resolveDir ?? (lastSlash > 0 ? child.path.slice(0, lastSlash) : '/');
            file.targets.push({ kind: 'file', file: await add({ ...child, source, resolveDir }) });
        }
        return file;
    };
    const roots = [];
    for (const module of modules)
        roots.push(await add(module));
    // ── Each sheet's url()s, then its rules printed once ───────────────────────
    for (const file of files.values()) {
        // Each url()'s URL, and whether it is a path the bundle wrote (an emitted file's).
        const urls = new Map();
        for (const { url, at, length, innerAt, innerLength } of sheetUrls(file.sheet)) {
            if (urls.has(url) || isExternalUrl(url))
                continue;
            const answer = await resolve(file.module, url, 'url-token', at, length);
            if (answer.external) {
                urls.set(url, { url: answer.path ?? url, written: false });
                continue;
            }
            const target = { namespace: answer.namespace ?? 'file', path: answer.path };
            const loaded = await load(file.module, target, at, length);
            const bytes = typeof loaded.contents === 'string' ? new TextEncoder().encode(loaded.contents) : loaded.contents;
            if (loaded.loader === 'file')
                urls.set(url, { url: await assets.emit(target, bytes), written: true });
            else if (loaded.loader === 'dataurl')
                urls.set(url, { url: assets.dataUrl(target.path, bytes), written: false });
            // esbuild places this one at the URL inside the token.
            else
                fail(file.module, innerAt, innerLength, `Cannot use ${JSON.stringify(fileOf(target))} as a URL`);
        }
        file.rules = sheetRules(file.sheet, (url) => urls.get(url) ?? { url, written: false });
    }
    const order = importOrder(roots);
    return printBundle(order, minify);
}
/** esbuild's isConditionalImportRedundant: `later` applies wherever `earlier` would. */
function isConditionalImportRedundant(earlier, later) {
    if (later.length > earlier.length)
        return false;
    for (let i = 0; i < later.length; i++) {
        const a = earlier[i];
        const b = later[i];
        if (componentsEqual(a.layers, b.layers)) {
            const sameSupports = componentsEqual(a.supports, b.supports);
            const sameMedia = componentsEqual(a.media, b.media);
            if (sameSupports && sameMedia)
                continue;
            if (sameMedia && b.supports.length === 0)
                continue;
            if (sameSupports && b.media.length === 0)
                continue;
        }
        return false;
    }
    return true;
}
/** esbuild's importConditionsAreEqual. */
function conditionsAreEqual(a, b) {
    return a.length === b.length && a.every((x, i) => componentsEqual(x.layers, b[i].layers) && componentsEqual(x.supports, b[i].supports) && componentsEqual(x.media, b[i].media));
}
const layersEqual = (a, b) => a.length === b.length && a.every((x, i) => x.length === b[i].length && x.every((y, j) => y === b[i][j]));
/** esbuild's findImportedFilesInCSSOrder (linker.go), over this build's graph. */
function importOrder(roots) {
    let order = [];
    let hasExternalImport = false;
    const visit = (file, visited, wrapping) => {
        if (visited.includes(file))
            return;
        const stack = [...visited, file];
        if (file.sheet.layersPreImport.length)
            order.push({ kind: 'layers', layers: file.sheet.layersPreImport, conditions: wrapping });
        file.sheet.imports.forEach((rule, i) => {
            const target = file.targets[i];
            const conditions = rule.conditions ? [...wrapping, rule.conditions] : wrapping;
            if (target.kind === 'file')
                visit(target.file, stack, conditions);
            else if (target.kind === 'external') {
                order.push({ kind: 'external', path: target.path, layers: [], conditions });
                hasExternalImport = true;
            }
        });
        order.push({ kind: 'file', file, layers: [], conditions: wrapping });
    };
    for (const root of roots)
        visit(root, [], []);
    // External imports must come first: hoist them, and the layer statements before them.
    if (hasExternalImport) {
        const hoisted = [];
        const rest = [];
        let layerPrefix = true;
        for (const entry of order) {
            if ((entry.kind === 'layers' && layerPrefix) || entry.kind === 'external')
                hoisted.push(entry);
            else
                rest.push(entry);
            if (entry.kind !== 'layers')
                layerPrefix = false;
        }
        order = [...hoisted, ...rest];
    }
    // A duplicate keeps its last place; an earlier one keeps only the layers it orders.
    {
        const fileDuplicates = new Map();
        const externalDuplicates = new Map();
        for (let i = order.length - 1; i >= 0; i--) {
            const entry = order[i];
            if (entry.kind === 'file') {
                const duplicates = fileDuplicates.get(entry.file) ?? [];
                if (duplicates.some((j) => isConditionalImportRedundant(entry.conditions, order[j].conditions))) {
                    order[i] = { kind: 'layers', layers: entry.file.sheet.layersPostImport, conditions: entry.conditions };
                    continue;
                }
                fileDuplicates.set(entry.file, [...duplicates, i]);
            }
            else if (entry.kind === 'external') {
                const duplicates = externalDuplicates.get(entry.path) ?? [];
                if (duplicates.some((j) => isConditionalImportRedundant(entry.conditions, order[j].conditions))) {
                    order[i] = { kind: 'layers', layers: [], conditions: entry.conditions };
                    continue;
                }
                externalDuplicates.set(entry.path, [...duplicates, i]);
            }
        }
    }
    // Layer statements take effect at their first place: drop the redundant ones.
    {
        const kept = [];
        const layerDuplicates = [];
        next: for (const original of order) {
            const entry = { ...original };
            if (entry.kind === 'layers') {
                // Conditions past the first anonymous layer, or past the last layer when nothing is named, do nothing.
                const anonymous = entry.conditions.findIndex((c) => c.layers.length === 1 && !c.layers[0].children);
                if (anonymous >= 0) {
                    entry.conditions = entry.conditions.slice(0, anonymous);
                    entry.layers = [];
                }
                if (entry.layers.length === 0) {
                    let end = entry.conditions.length;
                    while (end > 0 && entry.conditions[end - 1].layers.length === 0)
                        end--;
                    entry.conditions = entry.conditions.slice(0, end);
                }
                if (entry.conditions.length === 0 && entry.layers.length === 0)
                    continue;
            }
            const layersKey = entry.kind === 'file' ? entry.file.sheet.layersPostImport : entry.layers;
            let index = layerDuplicates.findIndex((d) => layersEqual(d.layers, layersKey));
            if (index < 0) {
                layerDuplicates.push({ layers: layersKey, indices: [] });
                index = layerDuplicates.length - 1;
            }
            const duplicates = layerDuplicates[index].indices;
            for (let j = duplicates.length - 1; j >= 0; j--) {
                const at = duplicates[j];
                if (!isConditionalImportRedundant(entry.conditions, kept[at].conditions))
                    continue;
                if (entry.kind !== 'layers') {
                    // An empty layer statement right before an identical full one is not needed.
                    if (j === duplicates.length - 1 && at === kept.length - 1) {
                        const other = kept[at];
                        if (other.kind === 'layers' && conditionsAreEqual(entry.conditions, other.conditions)) {
                            duplicates.splice(j, 1);
                            kept.length = at;
                            duplicates.push(kept.length);
                            kept.push(entry);
                            continue next;
                        }
                    }
                    // Other entries stay: they do more than order layers.
                    kept.push(entry);
                }
                continue next;
            }
            duplicates.push(kept.length);
            kept.push(entry);
        }
        order = kept;
    }
    // Adjacent layer statements under equal conditions merge.
    const merged = [];
    for (const entry of order) {
        const prev = merged[merged.length - 1];
        if (entry.kind === 'layers' && prev?.kind === 'layers' && conditionsAreEqual(prev.conditions, entry.conditions)) {
            merged[merged.length - 1] = { ...prev, layers: [...prev.layers, ...entry.layers] };
            continue;
        }
        merged.push(entry);
    }
    return merged;
}
/** esbuild's wrapRulesWithConditions: `rules` inside each level of `conditions`, innermost last. */
function wrapRules(rules, conditions, minify) {
    const block = (prelude, inner) => minify ? `${prelude}{${inner.join('')}}` : `${prelude} {\n${inner.join('\n')}\n}`;
    let out = rules;
    for (let i = conditions.length - 1; i >= 0; i--) {
        const item = conditions[i];
        for (const layer of item.layers) {
            const name = layer.children ? printComponents(layer.children, minify) : '';
            if (out.length === 0) {
                // An empty anonymous layer does nothing; an empty named one still orders its name.
                if (!layer.children)
                    continue;
                out = [`@layer ${name};`];
                continue;
            }
            out = [block(name ? `@layer ${name}` : '@layer', out)];
        }
        if (out.length > 0) {
            for (const supports of item.supports)
                out = [block(`@supports (${printComponents(supports.children ?? [], minify)})`, out)];
        }
        if (out.length > 0 && item.media.length > 0)
            out = [block(`@media ${printComponents(item.media, minify)}`, out)];
    }
    return out;
}
/** An `@import` of `path` under one level of conditions, as esbuild prints it. */
function printImport(path, conditions, minify) {
    const parts = conditions ? [conditions.layers, conditions.supports, conditions.media].filter((p) => p.length) : [];
    const printed = parts.map((p) => printComponents(p, minify)).join(' ');
    return minify ? `@import${quoteString(path)}${printed};` : `@import ${quoteString(path)}${printed ? ' ' + printed : ''};`;
}
/** esbuild's EncodeStringAsShortestDataURL. */
export function shortestDataUrl(mimeType, text) {
    const bytes = new TextEncoder().encode(text);
    let latin1 = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
        latin1 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const encoded = `data:${mimeType};base64,${btoa(latin1)}`;
    const escaped = percentEscapedDataUrl(mimeType, text);
    return escaped.length < encoded.length ? escaped : encoded;
}
/** esbuild's EncodeStringAsPercentEscapedDataURL, for text that came from valid UTF-8. */
export function percentEscapedDataUrl(mimeType, text) {
    let trailing = text.length;
    while (trailing > 0) {
        const c = text.charCodeAt(trailing - 1);
        if (c > 0x20 || c === 9 || c === 10 || c === 13)
            break;
        trailing--;
    }
    let out = `data:${mimeType},`;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        const hex = (n) => '%' + n.toString(16).toUpperCase().padStart(2, '0');
        if (c === 9 || c === 10 || c === 13 || c === 35 || i >= trailing || (c === 37 && /^[0-9a-fA-F]{2}/.test(text.slice(i + 1, i + 3))))
            out += hex(c);
        else
            out += text[i];
    }
    return out;
}
/** The bundle: `@charset`, then each place in the order, then the legal comments. */
function printBundle(order, minify) {
    const pieces = [];
    const legal = [];
    let charset = false;
    for (const entry of order) {
        if (entry.kind === 'layers') {
            const statement = entry.layers.length ? [`@layer ${entry.layers.map((name) => name.join('.')).join(minify ? ',' : ', ')};`] : [];
            pieces.push(wrapRules(statement, entry.conditions, minify).join(minify ? '' : '\n'));
        }
        else if (entry.kind === 'external') {
            // Conditions past the first nest as imports of data: stylesheets, innermost first.
            let path = entry.path;
            for (let i = entry.conditions.length - 1; i > 0; i--)
                path = shortestDataUrl('text/css', printImport(path, entry.conditions[i], minify));
            pieces.push(printImport(path, entry.conditions[0], minify));
        }
        else {
            const file = entry.file;
            if (file.sheet.hasCharset)
                charset = true;
            for (const comment of file.sheet.legal)
                if (!legal.includes(comment))
                    legal.push(comment);
            const body = wrapRules(file.rules, entry.conditions, minify).join(minify ? '' : '\n');
            pieces.push(minify ? body : `/* ${fileOf(file.module)} */\n${body}`);
        }
    }
    const head = charset ? ['@charset "UTF-8";'] : [];
    const sheet = [...head, ...pieces.filter((piece) => piece !== '')].join(minify ? '' : '\n');
    return `${sheet}\n${legal.map((comment) => comment + '\n').join('')}`;
}
