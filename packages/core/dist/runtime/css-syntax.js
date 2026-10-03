/**
 * css-syntax.ts — the CSS syntax Nimbus reads and writes, on css-tree 3
 * (its parser, generator, walker and tokenizer; never its lexer, so its MDN
 * grammar data stays out of every bundle).
 *
 * A stylesheet is parsed once into css-tree's AST. On top of it this module
 * answers what bundling needs and css-tree does not model: which `@import`
 * rules are in effect (only those before any rule but `@charset` and
 * `@layer` statements, as CSS says), each one's URL and conditions (`layer`,
 * `layer(...)`, `supports(...)`, then a media query list) as component values
 * from css-tree's tokens, and the cascade layers the sheet names before and
 * after its first `@import`. Rules print through css-tree's generator, which
 * keeps what whitespace and comments meant (`.x/**\/.y` stays one compound
 * selector, a no-break space stays a name character); conditions print as
 * esbuild 0.24 prints them, since a bundle writes them back.
 *
 * Used by css-bundle.ts (the built-in `vite build`'s stylesheets) and by the
 * Vite dev server's stylesheet serving.
 */
import parse from 'css-tree/parser';
import generate from 'css-tree/generator';
import walk from 'css-tree/walker';
import * as T from 'css-tree/tokenizer';
import { ident, string as cssString, url as cssUrl } from 'css-tree/utils';
const OPEN = {
    [T.Function]: T.RightParenthesis,
    [T.LeftParenthesis]: T.RightParenthesis,
    [T.LeftSquareBracket]: T.RightSquareBracket,
    [T.LeftCurlyBracket]: T.RightCurlyBracket,
};
/** `source`'s component values, offsets counted from `base`. */
export function componentsOf(source, base = 0) {
    const root = [];
    const stack = [{ list: root, close: -1 }];
    T.tokenize(source, (type, start, end) => {
        if (type === T.EOF)
            return;
        const top = stack[stack.length - 1];
        if (type === top.close && stack.length > 1) {
            stack.pop();
            return;
        }
        const component = { type, text: source.slice(start, end), at: base + start };
        top.list.push(component);
        const close = OPEN[type];
        if (close !== undefined) {
            component.children = [];
            stack.push({ list: component.children, close });
        }
    });
    return root;
}
const insignificant = (c) => c.type === T.WhiteSpace || c.type === T.Comment;
/** A component's value: decoded for names, strings and URLs, as written otherwise. */
function valueOf(c) {
    switch (c.type) {
        case T.Ident: return ident.decode(c.text);
        case T.Function: return ident.decode(c.text.slice(0, -1)).toLowerCase();
        case T.AtKeyword: return ident.decode(c.text.slice(1));
        case T.Hash: return ident.decode(c.text.slice(1));
        case T.String: return cssString.decode(c.text);
        case T.Url: return cssUrl.decode(c.text);
        default: return c.text;
    }
}
/** esbuild's TokensEqualIgnoringWhitespace: equal kinds and values, whitespace and comments aside. */
export function componentsEqual(a, b) {
    const x = a.filter((c) => !insignificant(c));
    const y = b.filter((c) => !insignificant(c));
    if (x.length !== y.length)
        return false;
    for (let i = 0; i < x.length; i++) {
        if (x[i].type !== y[i].type || valueOf(x[i]) !== valueOf(y[i]))
            return false;
        if (Boolean(x[i].children) !== Boolean(y[i].children))
            return false;
        if (x[i].children && !componentsEqual(x[i].children, y[i].children))
            return false;
    }
    return true;
}
/** esbuild's choice of quote for a string (bestQuoteCharForString): the one needing fewer escapes, `"` on a tie. */
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
/** `text` quoted with `quote` (none: as a bare url()), escaped as esbuild escapes it. */
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
/** A string as esbuild prints one. */
export const quoteString = (text) => quoted(text, bestQuote(text, false));
/**
 * A url() as esbuild prints one: unquoted where that is shortest, quoted
 * always for a path the bundle wrote (an emitted file's), as esbuild does.
 */
export const printUrl = (url, alwaysQuoted) => `url(${quoted(url, bestQuote(url, !alwaysQuoted))})`;
/**
 * Components as esbuild prints them: comments dropped, a run of whitespace
 * one space, none just inside a function or block, before a comma, or (when
 * minifying) after one; strings and URLs quoted esbuild's way.
 */
export function printComponents(components, minify) {
    let out = '';
    let pendingSpace = false;
    let afterComma = false;
    for (const c of components) {
        if (insignificant(c)) {
            if (c.type === T.WhiteSpace)
                pendingSpace = true;
            continue;
        }
        if (out && pendingSpace && c.type !== T.Comma && !(afterComma && minify))
            out += ' ';
        pendingSpace = false;
        afterComma = c.type === T.Comma;
        const urlArgument = c.type === T.Function && valueOf(c) === 'url' ? trim(c.children ?? []) : [];
        if (c.type === T.String)
            out += quoteString(valueOf(c));
        else if (c.type === T.Url)
            out += printUrl(valueOf(c), false);
        // `url("x")` is a url() like `url(x)`, and prints as one.
        else if (urlArgument.length === 1 && urlArgument[0].type === T.String)
            out += printUrl(valueOf(urlArgument[0]), false);
        else if (c.children)
            out += c.text + printComponents(trim(c.children), minify) + closing(c);
        else
            out += c.text;
    }
    return out;
}
function closing(c) {
    return c.type === T.LeftSquareBracket ? ']' : c.type === T.LeftCurlyBracket ? '}' : ')';
}
const trim = (components) => {
    let start = 0;
    let end = components.length;
    while (start < end && insignificant(components[start]))
        start++;
    while (end > start && insignificant(components[end - 1]))
        end--;
    return components.slice(start, end);
};
const isNamed = (c, name, types) => c !== undefined && types.includes(c.type) && (c.type === T.Function ? valueOf(c) : valueOf(c).toLowerCase()) === name;
/** An `@import`'s prelude: its URL and conditions, or null when it names no URL. */
function importOf(prelude) {
    const parts = trim(prelude);
    const first = parts[0];
    let path = null;
    let at = 0;
    let length = 0;
    if (first?.type === T.String) {
        path = valueOf(first);
        at = first.at;
        length = first.text.length;
    }
    else if (first?.type === T.Url) {
        path = valueOf(first);
        at = first.at;
        length = first.text.length;
    }
    else if (first && isNamed(first, 'url', [T.Function])) {
        const arg = trim(first.children ?? [])[0];
        if (arg?.type === T.String) {
            path = valueOf(arg);
            at = arg.at;
            length = arg.text.length;
        }
    }
    if (path === null)
        return null;
    let rest = trim(parts.slice(1));
    const conditions = { layers: [], supports: [], media: [] };
    if (isNamed(rest[0], 'layer', [T.Ident, T.Function])) {
        conditions.layers = [rest[0]];
        rest = trim(rest.slice(1));
    }
    if (isNamed(rest[0], 'supports', [T.Function])) {
        conditions.supports = [rest[0]];
        rest = trim(rest.slice(1));
    }
    conditions.media = rest;
    const any = conditions.layers.length || conditions.supports.length || conditions.media.length;
    return { path, at, length, conditions: any ? conditions : null };
}
/** The decoded, lower-cased name of an at-rule node. */
export const atRuleName = (node) => ident.decode(node.name ?? '').toLowerCase();
/** A node's source text. */
const sourceOf = (source, node) => source.slice(node.loc.start.offset, node.loc.end.offset);
const isLegalComment = (text) => text.startsWith('!') || /@(license|preserve)\b/.test(text);
/** Layer names an `@layer` prelude lists, each split at its dots. */
function layerNames(source, node) {
    if (!node.prelude)
        return [];
    const names = [];
    let current = [];
    for (const c of componentsOf(sourceOf(source, node.prelude))) {
        if (c.type === T.Ident)
            current.push(valueOf(c));
        else if (c.type === T.Comma) {
            if (current.length)
                names.push(current);
            current = [];
        }
    }
    if (current.length)
        names.push(current);
    return names;
}
/** Parses a stylesheet. Throws on nothing: what css-tree cannot parse it keeps as written. */
export function parseSheet(source) {
    const legal = [];
    const ast = parse(source, {
        positions: true,
        onComment(value) {
            if (isLegalComment(value))
                legal.push(`/*${value}*/`);
        },
    });
    const sheet = { source, ast, imports: [], missingUrl: null, layersPreImport: [], layersPostImport: [], legal, hasCharset: false };
    // The cascade layers named anywhere, in order, prefixed by the layers they
    // sit in; nothing inside an anonymous layer (esbuild's recordAtLayerRule).
    const record = (names, enclosing) => {
        for (const name of names)
            sheet.layersPostImport.push([...enclosing, ...name]);
    };
    const visitLayers = (nodes, enclosing, anonymous) => {
        for (const node of nodes) {
            if (node.type !== 'Atrule' && node.type !== 'Rule')
                continue;
            let inner = enclosing;
            let innerAnonymous = anonymous;
            if (node.type === 'Atrule' && atRuleName(node) === 'layer') {
                const names = layerNames(source, node);
                if (!anonymous && (node.block ? names.length <= 1 : names.length >= 1))
                    record(names, enclosing);
                if (node.block) {
                    if (names.length === 1)
                        inner = [...enclosing, ...names[0]];
                    else
                        innerAnonymous++;
                }
            }
            if (node.type === 'Atrule' && atRuleName(node) === 'import')
                continue;
            visitLayers(node.block?.children?.toArray() ?? [], inner, innerAnonymous);
        }
    };
    // `@import` is in effect only before any rule but `@charset` and `@layer` statements.
    let importsValid = true;
    ast.children.forEach((node) => {
        if (node.type === 'Comment')
            return;
        const name = node.type === 'Atrule' ? atRuleName(node) : '';
        if (name === 'charset') {
            sheet.hasCharset = true;
            return;
        }
        if (name === 'layer' && !node.block) {
            visitLayers([node], [], 0);
            return;
        }
        if (name === 'import' && importsValid) {
            const rule = importOf(node.prelude ? componentsOf(sourceOf(source, node.prelude), node.prelude.loc.start.offset) : []);
            if (!rule) {
                sheet.missingUrl ??= { at: node.loc.start.offset, length: node.name.length + 1 };
                return;
            }
            if (sheet.imports.length === 0) {
                sheet.layersPreImport = sheet.layersPostImport;
                sheet.layersPostImport = [];
            }
            sheet.imports.push(rule);
            return;
        }
        importsValid = false;
        visitLayers([node], [], 0);
    });
    return sheet;
}
/**
 * The rules a sheet contributes where it is bundled, each printed: all but
 * its `@charset`, the `@import`s in effect, and (when it has any) the
 * `@layer` statements before them, which the bundle orders by itself.
 * Comments are dropped. `rewriteUrl` gives each url() its URL first; it
 * changes the sheet's nodes, so a sheet is printed once.
 */
export function sheetRules(sheet, rewriteUrl) {
    const rules = [];
    let importsSeen = 0;
    let importsValid = true;
    const before = [];
    sheet.ast.children.forEach((node) => {
        if (node.type === 'Comment')
            return;
        const name = node.type === 'Atrule' ? atRuleName(node) : '';
        if (name === 'charset')
            return;
        if (name === 'layer' && !node.block && importsValid) {
            (importsSeen === 0 ? before : rules).push(print(sheet.source, node, rewriteUrl));
            return;
        }
        if (name === 'import' && importsValid) {
            importsSeen++;
            return;
        }
        importsValid = false;
        rules.push(print(sheet.source, node, rewriteUrl));
    });
    return sheet.imports.length ? rules : [...before, ...rules];
}
/**
 * One node printed: comments dropped, url()s (but an `@import`'s) rewritten
 * and quoted as esbuild quotes them, at-rule preludes printed from their
 * tokens as esbuild prints them (css-tree's generator would respace them).
 */
function print(source, node, rewriteUrl) {
    walk(node, (inner, item, list) => {
        if (inner.type === 'Atrule' && atRuleName(inner) === 'import')
            return walk.skip;
        if (inner.type === 'Comment' && item && list) {
            list.remove(item);
        }
        else if (inner.type === 'Url') {
            const { url, written } = rewriteUrl ? rewriteUrl(inner.value) : { url: inner.value, written: false };
            inner.type = 'Raw';
            inner.value = printUrl(url, written);
        }
        else if (inner.type === 'Atrule' && inner.prelude?.loc) {
            inner.prelude = { type: 'Raw', value: ' ' + printComponents(componentsOf(sourceOf(source, inner.prelude)), true) };
        }
    });
    return generate(node, { decorator: spaceAfterUrl });
}
const AFTER_URL_SPACED = new Set([T.Ident, T.Function, T.Url, T.String, T.Number, T.Dimension, T.Percentage, T.Hash]);
/**
 * css-tree writes no space between a url() and the value after it
 * (`url(a.png)no-repeat`), which CSS allows but esbuild never writes and
 * older parsers trip on: keep one there.
 */
function spaceAfterUrl(handlers) {
    const tokenBefore = handlers.tokenBefore;
    handlers.tokenBefore = (prevCode, type, value) => {
        const next = tokenBefore(prevCode, type, value);
        return prevCode >> 1 === T.Url && AFTER_URL_SPACED.has(type) ? next | 1 : next;
    };
    return handlers;
}
/** Every url() a sheet's rules name (but an `@import`'s). */
export function sheetUrls(sheet) {
    const urls = [];
    walk(sheet.ast, (node) => {
        if (node.type === 'Atrule' && atRuleName(node) === 'import')
            return walk.skip;
        if (node.type !== 'Url' || !node.loc)
            return;
        const text = sheet.source.slice(node.loc.start.offset, node.loc.end.offset);
        const inner = /^url\(\s*/i.exec(text)?.[0].length ?? 0;
        urls.push({
            url: node.value, at: node.loc.start.offset, length: text.length,
            innerAt: node.loc.start.offset + inner, innerLength: text.replace(/\s*\)$/, '').length - inner,
        });
    });
    return urls;
}
