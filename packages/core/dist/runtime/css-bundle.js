/**
 * css-bundle.ts — the CSS a bundle's JavaScript imports, as one stylesheet,
 * by esbuild 0.24's rules (what the built-in `vite build` shipped before).
 *
 * rolldown 1.2 no longer bundles CSS, so rolldown-build.ts loads every CSS
 * module as an empty JavaScript module and hands a chunk's CSS modules here in
 * the order the chunk's JavaScript first imports them. From there:
 *
 *   - Each file's `@import`s are inlined before it, recursively. A file
 *     imported more than once (by `@import`, or by JavaScript and `@import`)
 *     keeps its LAST place, as the cascade does, and a later import with
 *     fewer conditions makes an earlier conditional one redundant
 *     (esbuild's isConditionalImportRedundant). Each import's conditions wrap
 *     its rules, one level per import: `@media`, then `@supports`, then
 *     `@layer`, innermost import innermost.
 *   - An `@import` of a URL (`http:`, `https:`, `//`) stays an `@import`,
 *     hoisted to the top with its conditions; `@charset` becomes one
 *     `@charset "UTF-8";` first.
 *   - Every `url()` naming a file is resolved and loaded through the build's
 *     plugin (kind `url-token`); a `file` loader makes it an emitted asset,
 *     written as a path relative to the stylesheet, a `dataurl` loader a
 *     data URL; any other loader cannot be a URL, as in esbuild. `data:`,
 *     `http(s):`, `//` and `#` URLs are left alone.
 *   - `@import` paths resolve with kind `import-rule`. Paths go to the plugin
 *     as written: a bare `url(img/x.png)` is a package path there, as it was
 *     to esbuild under Nimbus's plugin.
 *
 * Legal comments (`/*!`, or naming `@license` or `@preserve`) move to the end
 * of the sheet, once each, as esbuild's `legalComments: 'eof'` does.
 *
 * Minifying removes the other comments and the whitespace
 * and last semicolons a stylesheet does not need; it does not rewrite values,
 * so a minified sheet is larger than esbuild's, never different in meaning.
 */
export class CssError extends Error {
    diagnostic;
    constructor(diagnostic) {
        super(diagnostic.text);
        this.diagnostic = diagnostic;
    }
}
function tokenize(css) {
    const tokens = [];
    let i = 0;
    const n = css.length;
    const stringEnd = (start) => {
        const quote = css[start];
        let j = start + 1;
        while (j < n && css[j] !== quote && css[j] !== '\n')
            j += css[j] === '\\' ? 2 : 1;
        return Math.min(j + 1, n);
    };
    while (i < n) {
        const c = css[i];
        if (c === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            const stop = end < 0 ? n : end + 2;
            tokens.push({ kind: 'comment', text: css.slice(i, stop), at: i });
            i = stop;
        }
        else if (/\s/.test(c)) {
            let j = i;
            while (j < n && /\s/.test(css[j]))
                j++;
            tokens.push({ kind: 'ws', text: css.slice(i, j), at: i });
            i = j;
        }
        else if (c === '"' || c === "'") {
            const end = stringEnd(i);
            tokens.push({ kind: 'string', text: css.slice(i, end), at: i });
            i = end;
        }
        else if ((c === 'u' || c === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && !/[\w-]/.test(css[i - 1] ?? '')) {
            // url( "x" ) or url(x): one token, whatever is inside.
            let j = i + 4;
            while (j < n && /\s/.test(css[j]))
                j++;
            if (css[j] === '"' || css[j] === "'") {
                const end = stringEnd(j);
                let k = end;
                while (k < n && /\s/.test(css[k]))
                    k++;
                if (css[k] === ')') {
                    tokens.push({ kind: 'url', text: css.slice(i, k + 1), at: i, url: unescape(css.slice(j + 1, end - 1)), quoted: true, inner: j, innerLength: end - j });
                    i = k + 1;
                    continue;
                }
            }
            else {
                let k = j;
                while (k < n && css[k] !== ')')
                    k += css[k] === '\\' ? 2 : 1;
                // esbuild reports an unquoted url() at the token, a quoted one at its string.
                tokens.push({ kind: 'url', text: css.slice(i, k + 1), at: i, url: unescape(css.slice(j, k).trimEnd()), quoted: false, inner: i, innerLength: k + 1 - i });
                i = k + 1;
                continue;
            }
            tokens.push({ kind: 'other', text: c, at: i });
            i++;
        }
        else if (c === ';') {
            tokens.push({ kind: 'semicolon', text: c, at: i });
            i++;
        }
        else if (c === '{') {
            tokens.push({ kind: 'open', text: c, at: i });
            i++;
        }
        else if (c === '}') {
            tokens.push({ kind: 'close', text: c, at: i });
            i++;
        }
        else if (c === '\\') {
            tokens.push({ kind: 'other', text: css.slice(i, i + 2), at: i });
            i += 2;
        }
        else {
            let j = i + 1;
            while (j < n && !/[\s"'/;{}\\]/.test(css[j]) && !/^url\(/i.test(css.slice(j, j + 4)))
                j++;
            tokens.push({ kind: 'other', text: css.slice(i, j), at: i });
            i = j;
        }
    }
    return tokens;
}
function unescape(text) {
    return text.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_, e) => (/^[0-9a-fA-F]/.test(e) ? String.fromCodePoint(parseInt(e, 16)) : e));
}
/** A string of a parsed string token's value. */
function stringValue(token) {
    return unescape(token.slice(1, token.endsWith(token[0]) && token.length > 1 ? -1 : undefined));
}
const isExternalUrl = (url) => /^(data:|https?:|\/\/|#)/i.test(url) || url === '';
const NO_CONDITIONS = [];
/** esbuild's bestQuoteCharForString: the quote that needs the fewest escapes, none for a URL that needs fewer still. */
function bestQuote(text, url) {
    let none = 0;
    let single = 2;
    let double = 2;
    for (const c of text) {
        if (c === "'") {
            none++;
            single++;
        }
        else if (c === '"') {
            none++;
            double++;
        }
        else if (c === '(' || c === ')' || c === ' ' || c === '\t')
            none++;
        else if (c === '\\' || c === '\n' || c === '\r' || c === '\f') {
            none++;
            single++;
            double++;
        }
    }
    if (url && none < single && none < double)
        return '';
    return single < double ? "'" : '"';
}
/** esbuild's printQuotedWithQuote: `text` quoted with `quote` (none: a URL's), escaped as it needs. */
function quoted(text, quote) {
    let out = quote;
    const chars = [...text];
    chars.forEach((c, i) => {
        if (c === '\0' || c === '\r' || c === '\n' || c === '\f') {
            out += '\\' + c.codePointAt(0).toString(16) + (/^[0-9a-fA-F\s]/.test(chars[i + 1] ?? '') ? ' ' : '');
        }
        else if (c === '\\' || c === quote || (quote === '' && (c === '(' || c === ')' || c === ' ' || c === '\t' || c === '"' || c === "'"))) {
            out += '\\' + c;
        }
        else {
            out += c;
        }
    });
    return out + quote;
}
function conditionTokens(tokens) {
    const out = [];
    for (const token of tokens) {
        if (token.kind === 'ws' || token.kind === 'comment')
            out.push({ kind: token.kind, text: token.text });
        // Strings and URLs as esbuild prints a condition's: re-quoted the cheapest way.
        else if (token.kind === 'string')
            out.push({ kind: 'atom', text: (() => { const value = stringValue(token.text); return quoted(value, bestQuote(value, false)); })() });
        else if (token.kind === 'url')
            out.push({ kind: 'atom', text: `url(${quoted(token.url, bestQuote(token.url, true))})` });
        else if (token.text.startsWith('\\'))
            out.push({ kind: 'atom', text: token.text });
        else {
            for (const piece of token.text.split(/([()])/)) {
                if (piece)
                    out.push({ kind: piece === '(' ? 'open' : piece === ')' ? 'close' : 'word', text: piece });
            }
        }
    }
    return out;
}
/** Condition tokens as text: comments dropped, as esbuild prints them. */
function conditionText(tokens) {
    return tokens.map((t) => (t.kind === 'comment' ? '' : t.text)).join('').trim();
}
/** `@import <url> [layer|layer(x)] [supports(...)] [media]`'s conditions, or null for none. */
function parseLevel(tokens) {
    let i = 0;
    const skip = () => {
        while (i < tokens.length && (tokens[i].kind === 'ws' || tokens[i].kind === 'comment'))
            i++;
    };
    // The index of the `)` that closes the `(` at `open`.
    const closing = (open) => {
        let depth = 0;
        for (let k = open; k < tokens.length; k++) {
            if (tokens[k].kind === 'open')
                depth++;
            else if (tokens[k].kind === 'close' && --depth === 0)
                return k;
        }
        return tokens.length;
    };
    const isFunction = (name) => tokens[i]?.kind === 'word' && tokens[i].text.toLowerCase() === name && tokens[i + 1]?.kind === 'open';
    let layerOf = null;
    let supportsOf = null;
    skip();
    if (isFunction('layer')) {
        const end = closing(i + 1);
        layerOf = { name: conditionText(tokens.slice(i + 2, end)) };
        i = end + 1;
    }
    else if (tokens[i]?.kind === 'word' && tokens[i].text.toLowerCase() === 'layer') {
        layerOf = { name: null };
        i++;
    }
    skip();
    if (isFunction('supports')) {
        const end = closing(i + 1);
        // esbuild parenthesizes whatever supports() holds, a condition already in parentheses too.
        supportsOf = `(${conditionText(tokens.slice(i + 2, end))})`;
        i = end + 1;
    }
    const media = conditionText(tokens.slice(i));
    if (!layerOf && !supportsOf && !media)
        return null;
    return { media: media || null, supports: supportsOf, layer: layerOf };
}
function wrap(body, conditions) {
    let out = body;
    for (const level of [...conditions].reverse()) {
        if (level.layer)
            out = level.layer.name === null ? `@layer {\n${out}\n}` : `@layer ${level.layer.name} {\n${out}\n}`;
        if (level.supports)
            out = `@supports ${level.supports} {\n${out}\n}`;
        if (level.media)
            out = `@media ${level.media} {\n${out}\n}`;
    }
    return out;
}
const same = (a, b) => (a ?? '').replace(/\s+/g, '') === (b ?? '').replace(/\s+/g, '');
/** esbuild's isConditionalImportRedundant: `later` applies wherever `earlier` would. */
function redundant(earlier, later) {
    if (later.length > earlier.length)
        return false;
    for (let i = 0; i < later.length; i++) {
        const a = earlier[i];
        const b = later[i];
        if (same(a.layer ? a.layer.name ?? '\0' : null, b.layer ? b.layer.name ?? '\0' : null) && Boolean(a.layer) === Boolean(b.layer)) {
            const sameSupports = same(a.supports, b.supports);
            const sameMedia = same(a.media, b.media);
            if (sameSupports && sameMedia)
                continue;
            if (sameMedia && !b.supports)
                continue;
            if (sameSupports && !b.media)
                continue;
        }
        return false;
    }
    return true;
}
export async function bundleCss(modules, plugin, assets, { minify }) {
    const pieces = [];
    const externals = [];
    const legal = [];
    let charset = false;
    const fail = (module, at, length, text, pluginName = '') => {
        const before = module.source.slice(0, at);
        const line = before.split('\n').length;
        const lineStart = before.lastIndexOf('\n') + 1;
        const lineEnd = module.source.indexOf('\n', at);
        throw new CssError({
            id: '', pluginName, text, notes: [], detail: undefined,
            location: {
                file: fileOf(module), namespace: '', line, column: at - lineStart, length,
                lineText: module.source.slice(lineStart, lineEnd < 0 ? undefined : lineEnd), suggestion: '',
            },
        });
    };
    const resolve = async (from, path, kind, at, length) => {
        const answer = await plugin.resolve({ path, importer: from.path, namespace: from.namespace, resolveDir: from.resolveDir, kind, with: {} });
        if (answer?.errors?.length)
            fail(from, at, length, answer.errors[0].text ?? 'error', plugin.name);
        if (!answer || (!answer.path && !answer.external))
            fail(from, at, length, `Could not resolve ${JSON.stringify(path)}`);
        return answer;
    };
    const load = async (from, module, at, length) => {
        const answer = await plugin.load({ path: module.path, namespace: module.namespace, suffix: '', with: {} });
        if (answer?.errors?.length)
            fail(from, at, length, answer.errors[0].text ?? 'error', plugin.name);
        if (!answer || answer.contents === undefined)
            fail(from, at, length, `Could not load ${fileOf(module)}`);
        return answer;
    };
    /** Inline one file's imports before it, as pieces; `stack` stops a cycle. */
    const flatten = async (module, conditions, stack) => {
        const id = fileOf(module);
        if (stack.has(id))
            return;
        stack.add(id);
        const tokens = tokenize(module.source);
        let body = '';
        let depth = 0;
        let rulesSeen = false;
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.kind === 'open')
                depth++;
            if (token.kind === 'close')
                depth--;
            if (depth === 0 && token.kind === 'other' && /^@charset$/i.test(token.text)) {
                charset = true;
                while (i < tokens.length && tokens[i].kind !== 'semicolon')
                    i++;
                continue;
            }
            if (depth === 0 && token.kind === 'other' && /^@import$/i.test(token.text) && !rulesSeen) {
                let j = i + 1;
                while (j < tokens.length && (tokens[j].kind === 'ws' || tokens[j].kind === 'comment'))
                    j++;
                const target = tokens[j];
                let end = j + 1;
                while (end < tokens.length && tokens[end].kind !== 'semicolon')
                    end++;
                const condition = conditionTokens(tokens.slice(j + 1, end));
                const printed = conditionText(condition);
                const path = target?.kind === 'string' ? stringValue(target.text) : target?.kind === 'url' ? target.url : null;
                if (path === null)
                    fail(module, token.at, token.text.length, 'Expected URL token');
                const own = parseLevel(condition);
                if (/^(https?:)?\/\//i.test(path)) {
                    externals.push(`@import ${JSON.stringify(path)}${printed ? ' ' + printed : ''};`);
                }
                else {
                    const where = target.kind === 'url' ? [target.inner, target.innerLength] : [target.at, target.text.length];
                    const answer = await resolve(module, path, 'import-rule', where[0], where[1]);
                    if (answer.external) {
                        externals.push(`@import ${JSON.stringify(answer.path ?? path)}${printed ? ' ' + printed : ''};`);
                    }
                    else {
                        const child = { namespace: answer.namespace ?? 'file', path: answer.path };
                        const loaded = await load(module, child, where[0], where[1]);
                        const source = typeof loaded.contents === 'string' ? loaded.contents : new TextDecoder().decode(loaded.contents);
                        const lastSlash = child.path.lastIndexOf('/');
                        await flatten({ ...child, source, resolveDir: loaded.resolveDir ?? (lastSlash > 0 ? child.path.slice(0, lastSlash) : '/') }, own ? [...conditions, own] : conditions, stack);
                    }
                }
                i = end;
                continue;
            }
            if (depth === 0 && token.kind === 'other' && !/^@(import|charset|layer)$/i.test(token.text))
                rulesSeen = true;
            if (token.kind === 'url') {
                body += await rewriteUrl(module, token);
                continue;
            }
            if (token.kind === 'comment' && isLegal(token.text)) {
                legal.push(token.text);
                continue;
            }
            body += token.text;
        }
        stack.delete(id);
        pieces.push({ id, module, conditions, body });
    };
    const rewriteUrl = async (module, token) => {
        if (isExternalUrl(token.url))
            return token.text;
        const answer = await resolve(module, token.url, 'url-token', token.inner, token.innerLength);
        if (answer.external)
            return `url(${JSON.stringify(answer.path ?? token.url)})`;
        const target = { namespace: answer.namespace ?? 'file', path: answer.path };
        const loaded = await load(module, target, token.inner, token.innerLength);
        const bytes = typeof loaded.contents === 'string' ? new TextEncoder().encode(loaded.contents) : loaded.contents;
        if (loaded.loader === 'file')
            return `url(${JSON.stringify(await assets.emit(target, bytes))})`;
        if (loaded.loader === 'dataurl')
            return `url(${JSON.stringify(assets.dataUrl(target.path, bytes))})`;
        return fail(module, token.inner, token.innerLength, `Cannot use ${JSON.stringify(fileOf(target))} as a URL`);
    };
    for (const module of modules)
        await flatten(module, NO_CONDITIONS, new Set());
    // A file imported more than once keeps its last place: an earlier import is
    // dropped when a later one of the same file applies wherever it would.
    const later = new Map();
    const kept = [];
    for (let i = pieces.length - 1; i >= 0; i--) {
        const piece = pieces[i];
        const seen = later.get(piece.id) ?? [];
        if (seen.some((conditions) => redundant(piece.conditions, conditions)))
            continue;
        seen.push(piece.conditions);
        later.set(piece.id, seen);
        kept.unshift(piece);
    }
    const head = [...(charset ? ['@charset "UTF-8";'] : []), ...new Set(externals)];
    const sheets = kept.map((piece) => {
        const body = piece.body.trim();
        return minify ? wrap(body, piece.conditions) : `/* ${fileOf(piece.module)} */\n${wrap(body, piece.conditions)}\n`;
    });
    const tail = [...new Set(legal)];
    if (minify)
        return minifyCss([...head, ...sheets].join('')) + '\n' + tail.map((c) => c + '\n').join('');
    return `${head.length ? head.join('\n') + '\n\n' : ''}${sheets.join('\n')}${tail.map((c) => c + '\n').join('')}`;
}
const isLegal = (comment) => comment.startsWith('/*!') || /@(license|preserve)\b/.test(comment);
/** How esbuild names a module in a diagnostic: `<namespace>:<path>`, the path alone for `file`. */
function fileOf(module) {
    return module.namespace === 'file' || module.namespace === '' ? module.path : `${module.namespace}:${module.path}`;
}
/** CSS without comments, and without whitespace or last semicolons it does not need. */
export function minifyCss(css) {
    let out = '';
    let pendingSpace = false;
    for (const token of tokenize(css)) {
        if (token.kind === 'comment') {
            pendingSpace = true;
            continue;
        }
        if (token.kind === 'ws') {
            pendingSpace = true;
            continue;
        }
        const prev = out[out.length - 1];
        if (token.kind === 'close' && prev === ';')
            out = out.slice(0, -1);
        // A string ends and starts itself: no space is needed on either side of
        // one, but after a colon (a condition's `(content: "x")`, as esbuild keeps it).
        const needsSpace = !/[{};,"']/.test(prev ?? ';') && !/^[{};,]/.test(token.text) && (token.kind !== 'string' || prev === ':');
        if (pendingSpace && needsSpace)
            out += ' ';
        pendingSpace = false;
        out += token.text;
    }
    return out;
}
